/**
 * Slack channel — User token polling.
 *
 * Supports two auth modes (auto-detected from env vars):
 *
 * ── Mode A: Browser token (recommended, no app needed) ──────────────────────
 *   SLACK_USER_TOKEN   xoxc-... (from localStorage in Slack web)
 *   SLACK_COOKIE_D     xoxd-... (cookie "d" from DevTools → Application → Cookies)
 *
 *   How to get them (one-time, ~2 min):
 *     1. Open Slack in Chrome → F12 → Console
 *        JSON.parse(localStorage.localConfig_v2).teams
 *        Copy the token starting with xoxc-...
 *     2. DevTools → Application → Cookies → https://app.slack.com
 *        Copy the value of cookie "d" (starts with xoxd-...)
 *     3. Set SLACK_USER_TOKEN=xoxc-... and SLACK_COOKIE_D=xoxd-... in config.secrets or .env
 *
 *   Note: xoxc tokens expire on logout or password change. No Slack app needed.
 *
 * ── Mode B: OAuth User Token (requires Slack app) ───────────────────────────
 *   SLACK_USER_TOKEN   xoxp-... (User OAuth Token from api.slack.com/apps)
 *   (no SLACK_COOKIE_D needed — uses @slack/web-api SDK)
 *
 * ─────────────────────────────────────────────────────────────────────────────
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

const log = createLogger('slack');
const ulid = monotonicFactory();

// ─── Config ───────────────────────────────────────────────────────────────────

export interface SlackConfig {
  userToken: string;
  /** xoxd-... cookie value — required when userToken is xoxc- (browser mode) */
  cookieD?: string;
  monitoredChannels: Array<{ channelId: string; name: string; tags?: string[] }>;
  monitorDMs: boolean;
  pollIntervalSeconds: number;
  /**
   * Active listening window (local time, 24h).
   * Polling is skipped if current hour < activeHoursStart or >= activeHoursEnd.
   * Both set to 0 = always active.
   */
  activeHoursStart: number;
  activeHoursEnd: number;
}

type SlackWebClient = {
  conversations: {
    list: (opts: Record<string, unknown>) => Promise<{
      channels?: Array<{
        id: string;
        name: string;
        is_member?: boolean;
        is_im?: boolean;
        is_mpim?: boolean;
      }>;
    }>;
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
  type: string;
  subtype?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  ts: string;
  thread_ts?: string;
  channel?: string;
};

// ─── Link extraction ──────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"')\]|]+/g;

function extractLinks(text: string): string[] {
  const unwrapped = text.replace(/<(https?:\/\/[^|>]+)[^>]*>/g, '$1');
  return [...new Set(unwrapped.match(URL_REGEX) ?? [])];
}

// ─── Browser-token fetch client (xoxc- + xoxd- cookie) ───────────────────────

/**
 * Thin Slack API client that authenticates via browser token (xoxc-) + cookie (d=xoxd-).
 * Uses the same API endpoints as the SDK — just plain fetch with the right headers.
 * No Slack app or OAuth flow required.
 */
function createBrowserTokenClient(token: string, cookieD: string): SlackWebClient {
  async function post(method: string, params: Record<string, unknown>): Promise<unknown> {
    const body = new URLSearchParams({ token });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) body.set(k, String(v));
    }
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `d=${cookieD}`,
      },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Slack HTTP ${res.status} on ${method}`);
    const json = (await res.json()) as Record<string, unknown>;
    if (!json.ok) throw Object.assign(new Error(`Slack API error: ${json.error}`), { data: json });
    return json;
  }

  return {
    conversations: {
      list: (opts) => post('conversations.list', opts) as ReturnType<SlackWebClient['conversations']['list']>,
      history: (opts) => post('conversations.history', opts) as ReturnType<SlackWebClient['conversations']['history']>,
    },
    users: {
      info: (opts) => post('users.info', opts) as ReturnType<SlackWebClient['users']['info']>,
    },
    auth: {
      test: () => post('auth.test', {}) as ReturnType<SlackWebClient['auth']['test']>,
    },
  };
}

// ─── SlackChannel class ───────────────────────────────────────────────────────

export class SlackChannel implements Channel {
  readonly name = 'slack';

  private config: SlackConfig;
  private webClient: SlackWebClient | null = null;
  private onMessageCb: ((msg: RawMessage) => Promise<void>) | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private botUserId: string | null = null;
  private userCache: Map<string, string> = new Map();
  private static readonly MAX_USER_CACHE = 1000;
  // cursor per channelId: last ts seen — only fetch messages newer than this
  private cursors: Map<string, string> = new Map();

  constructor(config: SlackConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: RawMessage) => Promise<void>): void {
    this.onMessageCb = handler;
  }

  async start(): Promise<void> {
    try {
      if (this.config.cookieD) {
        // Browser-token mode: xoxc- + xoxd- cookie, no SDK needed
        this.webClient = createBrowserTokenClient(this.config.userToken, this.config.cookieD);
        log.info('Slack: using browser token (xoxc- + cookie)');
      } else {
        // OAuth mode: xoxp- token via @slack/web-api SDK
        const { WebClient } = (await import('@slack/web-api')) as unknown as {
          WebClient: new (token: string) => SlackWebClient;
        };
        this.webClient = new WebClient(this.config.userToken);
        log.info('Slack: using OAuth user token (xoxp-)');
      }

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

      // Start polling loop with randomized interval (±30% jitter) to avoid detectable patterns
      this.scheduleNextPoll();

      log.info(
        `Slack polling started (~${this.config.pollIntervalSeconds}s ± 30% jitter)`,
      );
    } catch (e) {
      log.error('Slack start failed', e);
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('Slack channel stopped');
  }

  /**
   * Schedule next poll after a randomized delay.
   * Base = pollIntervalSeconds, jitter = ±30% uniform random.
   * This makes the polling pattern indistinguishable from normal human activity.
   */
  private scheduleNextPoll(): void {
    const base = this.config.pollIntervalSeconds * 1000;
    const jitter = base * 0.3 * (Math.random() * 2 - 1); // ±30%
    const delay = Math.round(base + jitter);
    this.pollTimer = setTimeout(() => {
      this.poll()
        .catch((e) => log.warn('Slack poll error:', e))
        .finally(() => {
          if (this.pollTimer !== null) this.scheduleNextPoll();
        });
    }, delay);
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
      return this.config.monitoredChannels.map((c) => ({
        id: c.channelId,
        name: c.name,
        isDM: false,
      }));
    }

    const result: Array<{ id: string; name: string; isDM: boolean }> = [];

    try {
      // Public + private channels the user is in
      const chRes = await this.webClient.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
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

    // Active-hours gate — no HTTP requests made outside the window (no presence signal to Slack)
    const { activeHoursStart: start, activeHoursEnd: end } = this.config;
    if (start !== 0 || end !== 0) {
      const hour = new Date().getHours();
      if (hour < start || hour >= end) {
        log.debug(`Slack polling paused — outside active hours (${start}:00–${end}:00, current: ${hour}:xx)`);
        return;
      }
    }

    const channels = await this.resolveChannels();

    for (const ch of channels) {
      if (ch.isDM && !this.config.monitorDMs) continue;

      const oldest = this.cursors.get(ch.id) ?? (Date.now() / 1000 - 120).toFixed(6);

      let messages: SlackMessage[] = [];
      try {
        const res = await this.webClient.conversations.history({
          channel: ch.id,
          oldest,
          limit: 50,
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
          id: ulid(),
          source: 'slack',
          channel: 'slack',
          chatId: ch.id,
          chatName: ch.name,
          chatType: ch.isDM ? 'dm' : msg.thread_ts ? 'thread' : 'channel',
          partnerName: senderName ?? ch.name,
          senderName,
          senderId: msg.user,
          content: msg.text!,
          links: extractLinks(msg.text!),
          receivedAt: Date.now(),
          timestamp: ts,
          meta: {
            slack_channel: ch.id,
            slack_ts: msg.ts,
            slack_thread_ts: msg.thread_ts,
          },
        };

        log.info(
          `Slack message from ${senderName ?? 'unknown'} in ${ch.name}: ${msg.text!.slice(0, 60)}`,
        );

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
      const res = await this.webClient!.users.info({ user: userId });
      const name = res.user?.real_name ?? res.user?.name ?? userId;
      this.userCache.set(userId, name);
      // LRU eviction
      if (this.userCache.size > SlackChannel.MAX_USER_CACHE) {
        const oldest = this.userCache.keys().next().value;
        if (oldest !== undefined) this.userCache.delete(oldest);
      }
      return name;
    } catch {
      return userId;
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSlackChannel(config?: {
  monitoredChannels?: Array<{ channelId: string; name: string; tags?: string[] }>;
  monitorDMs?: boolean;
  pollIntervalSeconds?: number;
  activeHoursStart?: number;
  activeHoursEnd?: number;
}): SlackChannel | null {
  const userToken = process.env.SLACK_USER_TOKEN;
  const cookieD = process.env.SLACK_COOKIE_D;

  if (!userToken) {
    log.debug('Slack not configured — set SLACK_USER_TOKEN (xoxc-... + SLACK_COOKIE_D, or xoxp-...)');
    return null;
  }

  if (userToken.startsWith('xoxc-') && !cookieD) {
    log.warn('Slack: SLACK_USER_TOKEN is xoxc- but SLACK_COOKIE_D is not set — set cookie d from browser DevTools');
    return null;
  }

  return new SlackChannel({
    userToken,
    cookieD: cookieD || undefined,
    monitoredChannels: config?.monitoredChannels ?? [],
    monitorDMs: config?.monitorDMs ?? true,
    pollIntervalSeconds: config?.pollIntervalSeconds ?? 300,
    activeHoursStart: config?.activeHoursStart ?? 9,
    activeHoursEnd: config?.activeHoursEnd ?? 22,
  });
}
