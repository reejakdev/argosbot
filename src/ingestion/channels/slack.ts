/**
 * Slack channel — User token polling (xoxp-).
 *
 * Uses YOUR OWN Slack account (not a bot), so Argos sees:
 *   - Every DM you receive
 *   - Every channel you're a member of
 *   - Private channels, shared channels, everything
 *
 * No bot invite needed. Same philosophy as Telegram MTProto.
 *
 * Auth setup (one-time):
 *   1. Go to https://api.slack.com/apps → Create New App → From scratch
 *   2. OAuth & Permissions → User Token Scopes:
 *        channels:history, channels:read, groups:history, groups:read,
 *        im:history, im:read, mpim:history, mpim:read, users:read
 *   3. Install to workspace → copy User OAuth Token (xoxp-...)
 *   4. Set SLACK_USER_TOKEN in config.secrets or .env
 *
 * Polling: ~60s by default (configurable via pollIntervalSeconds).
 * Uses conversations.history with oldest= cursor to fetch only new messages.
 *
 * Config (config.json → channels.slack):
 *   monitoredChannels   list of { channelId, name }  — empty = all joined channels
 *   monitorDMs          boolean (default: true)
 *   pollIntervalSeconds number (default: 60)
 */

import { createLogger } from '../../logger.js';
import { monotonicFactory } from 'ulid';
import type { Channel } from './registry.js';
import type { RawMessage } from '../../types.js';

const log  = createLogger('slack');
const ulid = monotonicFactory();

// ─── Config ───────────────────────────────────────────────────────────────────

export interface SlackConfig {
  userToken:         string;
  monitoredChannels: Array<{ channelId: string; name: string; tags?: string[] }>;
  monitorDMs:        boolean;
  pollIntervalSeconds: number;
}

type SlackWebClient = {
  conversations: {
    list:    (opts: Record<string, unknown>) => Promise<{ channels?: Array<{ id: string; name: string; is_member?: boolean; is_im?: boolean; is_mpim?: boolean }> }>;
    history: (opts: Record<string, unknown>) => Promise<{ messages?: Array<SlackMessage> }>;
  };
  users: {
    info: (opts: { user: string }) => Promise<{ user?: { real_name?: string; name?: string } }>;
  };
  auth: {
    test: () => Promise<{ user_id?: string; user?: string }>;
  };
};

type SlackMessage = {
  type:        string;
  subtype?:    string;
  text?:       string;
  user?:       string;
  bot_id?:     string;
  ts:          string;
  thread_ts?:  string;
  channel?:    string;
};

// ─── Link extraction ──────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"')\]|]+/g;

function extractLinks(text: string): string[] {
  const unwrapped = text.replace(/<(https?:\/\/[^|>]+)[^>]*>/g, '$1');
  return [...new Set(unwrapped.match(URL_REGEX) ?? [])];
}

// ─── SlackChannel class ───────────────────────────────────────────────────────

export class SlackChannel implements Channel {
  readonly name = 'slack';

  private config:        SlackConfig;
  private webClient:     SlackWebClient | null = null;
  private onMessageCb:   ((msg: RawMessage) => Promise<void>) | null = null;
  private pollTimer:     ReturnType<typeof setInterval> | null = null;
  private botUserId:     string | null = null;
  private userCache:     Map<string, string> = new Map();
  // cursor per channelId: last ts seen — only fetch messages newer than this
  private cursors:       Map<string, string> = new Map();

  constructor(config: SlackConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: RawMessage) => Promise<void>): void {
    this.onMessageCb = handler;
  }

  async start(): Promise<void> {
    try {
      const { WebClient } = await import('@slack/web-api') as unknown as { WebClient: new (token: string) => SlackWebClient };
      this.webClient = new WebClient(this.config.userToken);

      // Identify self to skip own messages
      try {
        const auth = await this.webClient.auth.test();
        this.botUserId = auth.user_id ?? null;
        log.info(`Slack user authenticated as ${auth.user}`);
      } catch (e) {
        log.warn('Slack: auth.test failed', e);
      }

      // Initialize cursors to "now" — only ingest messages received after start
      await this.initCursors();

      // Start polling loop
      const intervalMs = this.config.pollIntervalSeconds * 1000;
      this.pollTimer = setInterval(() => {
        this.poll().catch(e => log.warn('Slack poll error:', e));
      }, intervalMs);

      log.info(`Slack user-token polling started (every ${this.config.pollIntervalSeconds}s)`);
    } catch (e) {
      log.error('Slack start failed', e);
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('Slack channel stopped');
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async initCursors(): Promise<void> {
    const nowTs = (Date.now() / 1000).toFixed(6);
    const channels = await this.resolveChannels();
    for (const ch of channels) {
      this.cursors.set(ch.id, nowTs);
    }
    log.debug(`Slack: initialized ${channels.length} channel cursor(s)`);
  }

  /**
   * Resolve which channels to monitor:
   *   - If monitoredChannels configured → use that list
   *   - Else → list all joined channels + DMs from the API
   */
  private async resolveChannels(): Promise<Array<{ id: string; name: string; isDM: boolean }>> {
    if (!this.webClient) return [];

    if (this.config.monitoredChannels.length > 0) {
      return this.config.monitoredChannels.map(c => ({ id: c.channelId, name: c.name, isDM: false }));
    }

    const result: Array<{ id: string; name: string; isDM: boolean }> = [];

    try {
      // Public + private channels the user is in
      const chRes = await this.webClient.conversations.list({
        types:            'public_channel,private_channel',
        exclude_archived: true,
        limit:            200,
      });
      for (const ch of chRes.channels ?? []) {
        if (ch.is_member && ch.id) result.push({ id: ch.id, name: ch.name, isDM: false });
      }

      // DMs
      if (this.config.monitorDMs) {
        const dmRes = await this.webClient.conversations.list({
          types: 'im,mpim',
          limit: 200,
        });
        for (const ch of dmRes.channels ?? []) {
          if (ch.id) result.push({ id: ch.id, name: ch.name ?? ch.id, isDM: true });
        }
      }
    } catch (e) {
      log.warn('Slack: conversations.list failed', e);
    }

    return result;
  }

  private async poll(): Promise<void> {
    if (!this.webClient || !this.onMessageCb) return;

    const channels = await this.resolveChannels();

    for (const ch of channels) {
      if (ch.isDM && !this.config.monitorDMs) continue;

      const oldest = this.cursors.get(ch.id) ?? (Date.now() / 1000 - 120).toFixed(6);

      let messages: SlackMessage[] = [];
      try {
        const res = await this.webClient.conversations.history({
          channel: ch.id,
          oldest,
          limit:   50,
        });
        messages = res.messages ?? [];
      } catch (e) {
        // 'not_in_channel' or 'channel_not_found' are expected for some channels — skip silently
        const code = (e as { data?: { error?: string } })?.data?.error;
        if (code !== 'not_in_channel' && code !== 'channel_not_found') {
          log.warn(`Slack history error for ${ch.id}: ${e}`);
        }
        continue;
      }

      if (messages.length === 0) continue;

      // Update cursor to the newest ts seen
      const latestTs = messages[0]?.ts;
      if (latestTs) this.cursors.set(ch.id, latestTs);

      // Process oldest-first (Slack returns newest-first)
      for (const msg of [...messages].reverse()) {
        if (!msg.text?.trim()) continue;
        if (msg.subtype === 'message_changed' || msg.subtype === 'message_deleted') continue;
        if (msg.bot_id) continue;
        if (msg.user && msg.user === this.botUserId) continue;

        const senderName = msg.user ? await this.resolveUser(msg.user) : undefined;
        const ts = Math.round(parseFloat(msg.ts) * 1000);

        const raw: RawMessage = {
          id:          ulid(),
          source:      'slack',
          channel:     'slack',
          chatId:      ch.id,
          chatName:    ch.name,
          chatType:    ch.isDM ? 'dm' : (msg.thread_ts ? 'thread' : 'channel'),
          partnerName: senderName ?? ch.name,
          senderName,
          senderId:    msg.user,
          content:     msg.text!,
          links:       extractLinks(msg.text!),
          receivedAt:  Date.now(),
          timestamp:   ts,
          meta: {
            slack_channel:    ch.id,
            slack_ts:         msg.ts,
            slack_thread_ts:  msg.thread_ts,
          },
        };

        log.info(`Slack message from ${senderName ?? 'unknown'} in ${ch.name}: ${msg.text!.slice(0, 60)}`);

        try {
          await this.onMessageCb(raw);
        } catch (e) {
          log.error('Slack message handler error', e);
        }
      }
    }
  }

  private async resolveUser(userId: string): Promise<string> {
    if (this.userCache.has(userId)) return this.userCache.get(userId)!;
    try {
      const res  = await this.webClient!.users.info({ user: userId });
      const name = res.user?.real_name ?? res.user?.name ?? userId;
      this.userCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSlackChannel(config?: {
  monitoredChannels?:  Array<{ channelId: string; name: string; tags?: string[] }>;
  monitorDMs?:         boolean;
  pollIntervalSeconds?: number;
}): SlackChannel | null {
  const userToken = process.env.SLACK_USER_TOKEN;

  if (!userToken) {
    log.debug('Slack not configured — set SLACK_USER_TOKEN (xoxp-...)');
    return null;
  }

  return new SlackChannel({
    userToken,
    monitoredChannels:   config?.monitoredChannels   ?? [],
    monitorDMs:          config?.monitorDMs           ?? true,
    pollIntervalSeconds: config?.pollIntervalSeconds  ?? 60,
  });
}
