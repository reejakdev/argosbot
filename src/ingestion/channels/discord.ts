/**
 * Discord channel — Gateway (WebSocket, real-time).
 *
 * Monitors DMs and configured guild channels (text/threads).
 * Skips own bot messages, webhook messages, and system messages.
 *
 * Requirements:
 *   1. Create a bot at https://discord.com/developers/applications
 *   2. Bot → Reset Token → copy → DISCORD_BOT_TOKEN
 *   3. OAuth2 → URL Generator: scopes = bot, bot permissions = Read Messages/View Channels + Read Message History
 *   4. Privileged Gateway Intents → enable "Message Content Intent"
 *   5. Invite the bot to your server via the generated URL
 *
 * Config keys (config.json → secrets or .env):
 *   DISCORD_BOT_TOKEN   Bot token from the Developer Portal
 *
 * Optional config (config.json → channels.discord):
 *   monitoredChannels   list of { channelId, name, guildId }   limit to specific channels
 *   monitorDMs          boolean (default: true)                 include DMs
 *   monitoredGuildIds   list of guild IDs                       limit to specific servers
 */

import { createLogger } from '../../logger.js';
import type { Channel } from './registry.js';
import type { RawMessage } from '../../types.js';

const log = createLogger('discord');

// Rate limiter — max N concurrent message processing to avoid overwhelming the LLM
const MAX_CONCURRENT = 3;
let _inFlight = 0;
const _queue: Array<() => void> = [];

async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (_inFlight >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => _queue.push(resolve));
  }
  _inFlight++;
  try {
    return await fn();
  } finally {
    _inFlight--;
    _queue.shift()?.();
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface DiscordConfig {
  token: string;
  monitoredChannels: Array<{ channelId: string; name: string; guildId?: string; tags?: string[] }>;
  monitoredGuildIds: string[];
  monitorDMs: boolean;
}

// ─── Discord channel ──────────────────────────────────────────────────────────

export class DiscordChannel implements Channel {
  readonly name = 'discord';

  private config: DiscordConfig;
  private client: unknown = null;
  private onMessageCb: ((msg: RawMessage) => Promise<void>) | null = null;

  constructor(config: DiscordConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: RawMessage) => Promise<void>): void {
    this.onMessageCb = handler;
  }

  async start(): Promise<void> {
    try {
      const discord = await import('discord.js').catch(() => null);
      if (!discord) {
        log.warn('discord.js not installed. Run: npm install discord.js');
        return;
      }

      const { Client, GatewayIntentBits, Partials } = discord as unknown as {
        Client: new (opts: unknown) => unknown;
        GatewayIntentBits: Record<string, number>;
        Partials: Record<string, number>;
      };

      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
        // Partials needed to receive DMs from users who haven't DMed before
        partials: [Partials.Channel, Partials.Message],
      });

      const c = this.client as {
        on: (event: string, handler: (...args: unknown[]) => Promise<void>) => void;
        login: (token: string) => Promise<string>;
        user: { id: string; tag: string } | null;
        destroy: () => Promise<void>;
      };

      c.on('ready', async () => {
        log.info(`Discord connected as ${c.user?.tag ?? 'unknown'}`);
      });

      c.on('messageCreate', async (message: unknown) => {
        await withConcurrencyLimit(() => this.handleMessage(message));
      });

      c.on('error', async (error: unknown) => {
        log.error('Discord client error', error);
      });

      await c.login(this.config.token);
    } catch (e) {
      log.error('Discord start failed', e);
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        await (this.client as { destroy: () => Promise<void> }).destroy();
      } catch {}
      this.client = null;
    }
    log.info('Discord disconnected');
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async handleMessage(message: unknown): Promise<void> {
    if (!this.onMessageCb) return;

    const msg = message as {
      author: { id: string; username: string; displayName?: string; bot?: boolean };
      content: string;
      channel: {
        id: string;
        type: number;
        name?: string;
        isDMBased: () => boolean;
        isThread: () => boolean;
        fetch?: () => Promise<unknown>;
      };
      guild?: { id: string; name?: string } | null;
      id: string;
      createdTimestamp: number;
      webhookId?: string | null;
      system?: boolean;
    };

    // Skip bots, webhooks, system messages
    if (msg.author.bot) return;
    if (msg.webhookId) return;
    if (msg.system) return;

    const content = msg.content.trim();
    if (!content) return;

    const isDM = msg.channel.isDMBased();
    const isThread = msg.channel.isThread();
    const channelId = msg.channel.id;
    const guildId = msg.guild?.id ?? null;

    // DM filtering
    if (isDM && !this.config.monitorDMs) return;

    // Guild filtering — if list configured, only monitor listed guilds
    if (!isDM && this.config.monitoredGuildIds.length > 0 && guildId) {
      if (!this.config.monitoredGuildIds.includes(guildId)) return;
    }

    // Channel filtering — if list configured, only monitor listed channels
    if (!isDM && this.config.monitoredChannels.length > 0) {
      const monitored = this.config.monitoredChannels.find((c) => c.channelId === channelId);
      if (!monitored) return;
    }

    const senderName = msg.author.displayName ?? msg.author.username;
    const channelName =
      this.config.monitoredChannels.find((c) => c.channelId === channelId)?.name ??
      msg.channel.name ??
      (isDM ? `DM:${senderName}` : channelId);

    const raw: RawMessage = {
      id: `discord_${msg.id}`,
      channel: 'discord',
      source: 'discord' as unknown as RawMessage['source'],
      chatId: channelId,
      chatName: channelName,
      chatType: isDM ? 'dm' : isThread ? 'thread' : 'channel',
      partnerName: senderName,
      senderName,
      senderId: msg.author.id,
      content,
      links: extractLinks(content),
      receivedAt: Date.now(),
      timestamp: msg.createdTimestamp,
      meta: {
        discord_channel_id: channelId,
        discord_message_id: msg.id,
        discord_guild_id: guildId,
        discord_is_thread: isThread,
      },
    };

    log.info(`Discord message from ${senderName} in ${channelName}: ${content.slice(0, 60)}`);

    try {
      await this.onMessageCb(raw);
    } catch (e) {
      log.error('Discord message processing failed', e);
    }
  }
}

// ─── Link extraction ──────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

function extractLinks(text: string): string[] {
  return [...new Set(text.match(URL_REGEX) ?? [])];
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createDiscordChannel(config?: {
  monitoredChannels?: Array<{ channelId: string; name: string; guildId?: string; tags?: string[] }>;
  monitoredGuildIds?: string[];
  monitorDMs?: boolean;
}): DiscordChannel | null {
  const token = process.env.DISCORD_BOT_TOKEN;

  if (!token) {
    log.debug('Discord not configured — set DISCORD_BOT_TOKEN');
    return null;
  }

  return new DiscordChannel({
    token,
    monitoredChannels: config?.monitoredChannels ?? [],
    monitoredGuildIds: config?.monitoredGuildIds ?? [],
    monitorDMs: config?.monitorDMs ?? true,
  });
}
