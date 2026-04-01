/**
 * Slack channel — Socket Mode (no public URL needed, works behind firewalls).
 *
 * Monitors DMs and configured channels/groups.
 * Skips own bot messages, bot messages from other apps, and message edits.
 *
 * Requirements:
 *   1. Create a Slack app at https://api.slack.com/apps
 *   2. Enable Socket Mode → generate an App-Level Token (connections:write scope) → SLACK_APP_TOKEN
 *   3. Add Bot Token Scopes: channels:history, groups:history, im:history, mpim:history, users:read
 *   4. Subscribe to bot events: message.channels, message.groups, message.im, message.mpim
 *   5. Install app to workspace → copy Bot User OAuth Token → SLACK_BOT_TOKEN
 *
 * Config keys (config.json → secrets or .env):
 *   SLACK_BOT_TOKEN   xoxb-...   Bot OAuth token
 *   SLACK_APP_TOKEN   xapp-...   App-level token for Socket Mode
 *
 * Optional config (config.json → channels.slack):
 *   monitoredChannels   list of { channelId, name }   limit ingestion to specific channels
 *   monitorDMs          boolean (default: true)        include direct messages
 */

import { createLogger } from '../../logger.js';
import type { Channel } from './registry.js';
import type { RawMessage } from '../../types.js';

const log = createLogger('slack');

// ─── Config ───────────────────────────────────────────────────────────────────

export interface SlackConfig {
  botToken:          string;
  appToken:          string;
  /** Limit ingestion to specific channel IDs — empty = all joined channels */
  monitoredChannels: Array<{ channelId: string; name: string; tags?: string[] }>;
  monitorDMs:        boolean;
}

// ─── Slack channel ─────────────────────────────────────────────────────────────

export class SlackChannel implements Channel {
  readonly name = 'slack';

  private config: SlackConfig;
  private client: unknown = null;    // SocketModeClient
  private webClient: unknown = null; // WebClient
  private onMessageCb: ((msg: RawMessage) => Promise<void>) | null = null;
  private botUserId: string | null = null;
  private userCache = new Map<string, string>(); // userId → display name

  constructor(config: SlackConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: RawMessage) => Promise<void>): void {
    this.onMessageCb = handler;
  }

  async start(): Promise<void> {
    try {
      const slack = await import('@slack/socket-mode').catch(() => null);
      const webApi = await import('@slack/web-api').catch(() => null);

      if (!slack || !webApi) {
        log.warn('Slack SDK not installed. Run: npm install @slack/socket-mode @slack/web-api');
        return;
      }

      const { SocketModeClient } = slack as { SocketModeClient: new (opts: unknown) => unknown };
      const { WebClient } = webApi as { WebClient: new (token: string) => unknown };

      this.webClient = new WebClient(this.config.botToken);

      // Resolve bot's own user ID to skip self-messages
      try {
        const auth = await (this.webClient as { auth: { test: () => Promise<{ user_id?: string }> } }).auth.test();
        this.botUserId = auth.user_id ?? null;
        log.info(`Slack authenticated as bot user ${this.botUserId}`);
      } catch (e) {
        log.warn('Could not resolve Slack bot user ID', e);
      }

      this.client = new SocketModeClient({
        appToken: this.config.appToken,
        // Suppress SDK internal logging
        logger: {
          debug: () => {},
          info:  () => {},
          warn:  (msg: string) => log.warn(`[slack-sdk] ${msg}`),
          error: (msg: string) => log.error(`[slack-sdk] ${msg}`),
          setLevel: () => {},
          setName:  () => {},
          getLevel: () => 'warn',
        },
      });

      const sm = this.client as {
        on: (event: string, handler: (data: unknown) => Promise<void>) => void;
        start: () => Promise<void>;
        disconnect: () => Promise<void>;
      };

      sm.on('message', async ({ event, ack }: { event: unknown; ack: () => Promise<void> }) => {
        await ack();
        await this.handleEvent(event);
      });

      await sm.start();
      log.info('Slack Socket Mode connected');
    } catch (e) {
      log.error('Slack start failed', e);
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        await (this.client as { disconnect: () => Promise<void> }).disconnect();
      } catch {}
      this.client = null;
    }
    log.info('Slack disconnected');
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async handleEvent(event: unknown): Promise<void> {
    if (!this.onMessageCb) return;

    const e = event as {
      type?:     string;
      subtype?:  string;
      text?:     string;
      user?:     string;
      bot_id?:   string;
      channel?:  string;
      channel_type?: string;
      ts?:       string;
      thread_ts?: string;
    };

    // Only process message events
    if (e.type !== 'message') return;

    // Skip edits, deletes, bot messages
    if (e.subtype === 'message_changed' || e.subtype === 'message_deleted') return;
    if (e.bot_id) return;
    if (!e.user || e.user === this.botUserId) return;

    const content = (e.text ?? '').trim();
    if (!content) return;

    const channelId   = e.channel ?? '';
    const channelType = e.channel_type ?? '';

    // DM filtering
    const isDM = channelType === 'im' || channelType === 'mpim';
    if (isDM && !this.config.monitorDMs) return;

    // Channel filtering — if list configured, only monitor listed channels
    if (!isDM && this.config.monitoredChannels.length > 0) {
      const monitored = this.config.monitoredChannels.find(c => c.channelId === channelId);
      if (!monitored) return;
    }

    const senderName  = await this.resolveUser(e.user);
    const channelName = this.config.monitoredChannels.find(c => c.channelId === channelId)?.name
      ?? (isDM ? `DM:${senderName}` : channelId);

    const ts = e.ts ? Math.round(parseFloat(e.ts) * 1000) : Date.now();

    const raw: RawMessage = {
      id:          `slack_${e.ts ?? Date.now()}`,
      channel:     'slack',
      source:      'slack' as unknown as RawMessage['source'],
      chatId:      channelId,
      chatName:    channelName,
      chatType:    isDM ? 'dm' : (e.thread_ts ? 'thread' : 'channel'),
      partnerName: senderName,
      senderName,
      senderId:    e.user,
      content,
      links:       extractLinks(content),
      receivedAt:  Date.now(),
      timestamp:   ts,
      meta: {
        slack_channel:   channelId,
        slack_channel_type: channelType,
        slack_ts:        e.ts,
        slack_thread_ts: e.thread_ts,
      },
    };

    log.info(`Slack message from ${senderName} in ${channelName}: ${content.slice(0, 60)}`);

    try {
      await this.onMessageCb(raw);
    } catch (err) {
      log.error('Slack message processing failed', err);
    }
  }

  private async resolveUser(userId: string): Promise<string> {
    if (this.userCache.has(userId)) return this.userCache.get(userId)!;

    try {
      const wc = this.webClient as {
        users: { info: (opts: { user: string }) => Promise<{ user?: { real_name?: string; name?: string } }> };
      };
      const res = await wc.users.info({ user: userId });
      const name = res.user?.real_name ?? res.user?.name ?? userId;
      this.userCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }
}

// ─── Link extraction ──────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"')\]|]+/g;

function extractLinks(text: string): string[] {
  // Slack wraps URLs as <url> or <url|label>
  const unwrapped = text.replace(/<(https?:\/\/[^|>]+)[^>]*>/g, '$1');
  return [...new Set(unwrapped.match(URL_REGEX) ?? [])];
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSlackChannel(config?: {
  monitoredChannels?: Array<{ channelId: string; name: string; tags?: string[] }>;
  monitorDMs?: boolean;
}): SlackChannel | null {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    log.debug('Slack not configured — set SLACK_BOT_TOKEN and SLACK_APP_TOKEN');
    return null;
  }

  return new SlackChannel({
    botToken,
    appToken,
    monitoredChannels: config?.monitoredChannels ?? [],
    monitorDMs:        config?.monitorDMs ?? true,
  });
}
