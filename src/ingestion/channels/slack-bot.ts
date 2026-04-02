/**
 * Slack Bot — owner-only interactive channel.
 *
 * A bot token (xoxb-) polls the owner's dedicated channel (DM or private channel)
 * for commands and forwards proposals/notifications there.
 *
 * This is the Slack equivalent of telegram-bot.ts.
 * It does NOT observe partner channels — that's the user-token listener (slack.ts).
 *
 * Setup:
 *   1. api.slack.com/apps → Create New App → From scratch
 *   2. Socket Mode OFF (we use polling, no public URL needed)
 *   3. Bot Token Scopes (OAuth & Permissions):
 *        chat:write, channels:history, im:history, im:write,
 *        groups:history, channels:read, im:read, users:read
 *   4. Install to workspace → copy Bot User OAuth Token (xoxb-...)
 *   5. Invite the bot to your approval channel: /invite @argos
 *   6. Copy the channel ID (right-click channel → Copy link → last segment)
 *
 * Commands (send in the approval channel):
 *   /proposals          — pending proposals
 *   /approve <id>       — approve a proposal
 *   /reject <id> [reason]
 *   /status             — system overview
 *   /tasks              — open + in-progress tasks
 *   /memory [query]     — search memories
 *   /help               — command list
 */

import { createLogger } from '../../logger.js';
import type { LLMConfig } from '../../llm/index.js';
import type { Config } from '../../config/schema.js';
import type { CompactableHistory } from '../../llm/compaction.js';

const log = createLogger('slack-bot');

const POLL_INTERVAL_MS = 10_000; // 10 s — tighter than the listener (owner commands)

// ─── Config ───────────────────────────────────────────────────────────────────

export interface SlackBotOptions {
  /** xoxb- bot token */
  token: string;
  /** Channel ID where the bot listens and sends notifications (DM or private channel) */
  approvalChannelId: string;
  /** Slack user IDs allowed to issue commands (owner only) */
  allowedUserIds?: string[];
  llmConfig: LLMConfig;
  config?: Config;
}

// ─── Slack API types ──────────────────────────────────────────────────────────

interface SlackMessage {
  type:    string;
  ts:      string;
  user?:   string;
  bot_id?: string;
  text?:   string;
  subtype?: string;
}

interface SlackApiResponse {
  ok:     boolean;
  error?: string;
  [key: string]: unknown;
}

// ─── SlackBot ─────────────────────────────────────────────────────────────────

export class SlackBot {
  private token: string;
  private approvalChannelId: string;
  private allowedUserIds: Set<string>;
  private llmConfig: LLMConfig;
  private argosConfig: Config | undefined;

  private running  = false;
  private lastTs   = String(Date.now() / 1000 - 5); // start 5 s ago
  private botUserId: string | null = null;
  private conversations: Map<string, CompactableHistory> = new Map();

  constructor(options: SlackBotOptions) {
    this.token             = options.token;
    this.approvalChannelId = options.approvalChannelId;
    this.allowedUserIds    = new Set(options.allowedUserIds ?? []);
    this.llmConfig         = options.llmConfig;
    this.argosConfig       = options.config;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Resolve bot's own user ID (used to skip self-messages)
    try {
      const me = await this.api('auth.test', {}) as { user_id?: string };
      if (me.user_id) this.botUserId = me.user_id;
    } catch { /* non-blocking */ }

    this.running = true;
    log.info(`Slack Bot started — polling #${this.approvalChannelId}`);
    this.poll();
  }

  stop(): void {
    this.running = false;
    log.info('Slack Bot stopped');
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    await this.api('chat.postMessage', {
      channel: channelId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  /** Convenience — sends to the owner's approval channel */
  async sendToApprovalChat(text: string): Promise<void> {
    await this.sendMessage(this.approvalChannelId, text);
  }

  // ─── Polling ─────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const resp = await this.api('conversations.history', {
          channel: this.approvalChannelId,
          oldest:  this.lastTs,
          limit:   20,
        }) as { messages?: SlackMessage[] };

        const msgs = (resp.messages ?? []).reverse(); // oldest first
        for (const msg of msgs) {
          if (!msg.ts) continue;
          if (parseFloat(msg.ts) <= parseFloat(this.lastTs)) continue;
          this.lastTs = msg.ts;

          // Skip bot messages and system messages
          if (msg.bot_id || msg.subtype || msg.type !== 'message') continue;
          if (!msg.user) continue;
          if (this.botUserId && msg.user === this.botUserId) continue;

          // Auth check
          if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(msg.user)) {
            log.warn(`Ignoring message from unauthorized Slack user ${msg.user}`);
            continue;
          }

          await this.handleMessage(msg);
        }
      } catch (e) {
        log.error(`Slack bot polling error: ${(e as Error)?.message ?? String(e)}`);
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  // ─── Message handling ────────────────────────────────────────────────────────

  private async handleMessage(msg: SlackMessage): Promise<void> {
    const text = (msg.text ?? '').trim();
    if (!text) return;

    log.info(`Slack command from ${msg.user}: ${text.slice(0, 60)}`);

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/);
      const reply = await this.handleCommand(cmd.toLowerCase(), rest);
      await this.sendToApprovalChat(reply);
    } else {
      // Free-form message → LLM chat
      const reply = await this.chat(msg.user ?? 'owner', text);
      await this.sendToApprovalChat(reply);
    }
  }

  // ─── Commands ────────────────────────────────────────────────────────────────

  private async handleCommand(cmd: string, args: string[]): Promise<string> {
    switch (cmd) {
      case '/help':
        return [
          '*Argos — Slack commands*',
          '`/proposals` — pending proposals',
          '`/approve <id>` — approve a proposal',
          '`/reject <id> [reason]` — reject a proposal',
          '`/status` — system overview',
          '`/tasks` — open + in-progress tasks',
          '`/memory [query]` — search memories',
          '`/clear` — reset conversation history',
          '`/help` — this message',
        ].join('\n');

      case '/status': {
        const { getDb } = await import('../../db/index.js');
        const db = getDb();
        const pending   = (db.prepare("SELECT COUNT(*) as c FROM proposals WHERE status IN ('proposed','awaiting_approval')").get() as { c: number }).c;
        const openTasks = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status IN ('open','in_progress')").get() as { c: number }).c;
        const memories  = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE archived = 0").get() as { c: number }).c;
        return [
          `*Argos — Status*`,
          `Model: \`${this.llmConfig.model}\``,
          `Pending proposals: *${pending}*`,
          `Open tasks: *${openTasks}*`,
          `Active memories: *${memories}*`,
        ].join('\n');
      }

      case '/proposals': {
        const { getDb } = await import('../../db/index.js');
        const db = getDb();
        const rows = db.prepare(
          "SELECT id, reasoning, risk_level, created_at FROM proposals WHERE status IN ('proposed','awaiting_approval') ORDER BY created_at DESC LIMIT 10"
        ).all() as Array<{ id: string; reasoning: string; risk_level: string; created_at: number }>;

        if (!rows.length) return '✅ No pending proposals.';
        return ['*Pending proposals:*', ...rows.map(r =>
          `• \`${r.id.slice(-8)}\` [${r.risk_level}] — ${r.reasoning.slice(0, 120)}…\n  → \`/approve ${r.id.slice(-8)}\` or \`/reject ${r.id.slice(-8)}\``
        )].join('\n');
      }

      case '/approve': {
        const shortId = args[0];
        if (!shortId) return '⚠️ Usage: `/approve <id>`';
        const { getDb } = await import('../../db/index.js');
        const db = getDb();
        const row = db.prepare(
          "SELECT id, risk_level FROM proposals WHERE id LIKE ? AND status IN ('proposed','awaiting_approval') LIMIT 1"
        ).get(`%${shortId}`) as { id: string; risk_level: string } | null;

        if (!row) return `❌ Proposal \`${shortId}\` not found or already resolved.`;
        if (row.risk_level === 'high') {
          return `🔒 High-risk proposal \`${shortId}\` must be approved via the web app (2FA required).`;
        }

        // Approve: mirror what the web app does
        const now = Date.now();
        db.prepare("UPDATE proposals SET status = 'approved', updated_at = ? WHERE id = ?").run(now, row.id);
        db.prepare("UPDATE approvals SET status = 'approved', responded_at = ? WHERE proposal_id = ? AND status = 'pending'").run(now, row.id);

        // Execute in background (fire-and-forget)
        import('../../workers/proposal-executor.js').then(async ({ executeApprovedProposal }) => {
          const notify = (text: string) => this.sendToApprovalChat(text);
          await executeApprovedProposal(row.id, this.llmConfig, notify);
        }).catch(e => log.warn('Proposal execution failed:', e));

        return `✅ Proposal \`${shortId}\` approved — executing…`;
      }

      case '/reject': {
        const shortId = args[0];
        if (!shortId) return '⚠️ Usage: `/reject <id> [reason]`';
        const reason = args.slice(1).join(' ') || 'Rejected by owner via Slack';
        const { getDb } = await import('../../db/index.js');
        const db = getDb();
        const updated = db.prepare(
          "UPDATE proposals SET status = 'rejected', rejection_reason = ? WHERE id LIKE ? AND status IN ('proposed','awaiting_approval')"
        ).run(reason, `%${shortId}`);

        if ((updated as { changes: number }).changes === 0) {
          return `❌ Proposal \`${shortId}\` not found or already resolved.`;
        }
        return `🚫 Proposal \`${shortId}\` rejected. Reason: _${reason}_`;
      }

      case '/tasks': {
        const { getDb } = await import('../../db/index.js');
        const db = getDb();
        const rows = db.prepare(
          "SELECT id, title, category, urgency, chat_id, detected_at FROM tasks WHERE status IN ('open','in_progress') ORDER BY detected_at DESC LIMIT 15"
        ).all() as Array<{ id: string; title: string; category: string; urgency: string; chat_id: string; detected_at: number }>;

        if (!rows.length) return '✅ No open tasks.';
        return ['*Open tasks:*', ...rows.map(r =>
          `• [${r.urgency}] *${r.category}* — ${(r.title ?? '').slice(0, 100)}\n  \`${r.chat_id}\` · ${new Date(r.detected_at).toLocaleDateString()}`
        )].join('\n');
      }

      case '/memory': {
        const query = args.join(' ').trim();
        const { getDb } = await import('../../db/index.js');
        const db = getDb();
        const rows = query
          ? db.prepare("SELECT content, importance, partner FROM memories WHERE archived = 0 AND content LIKE ? ORDER BY created_at DESC LIMIT 8").all(`%${query}%`) as Array<{ content: string; importance: number; partner: string }>
          : db.prepare("SELECT content, importance, partner FROM memories WHERE archived = 0 ORDER BY created_at DESC LIMIT 8").all() as Array<{ content: string; importance: number; partner: string }>;

        if (!rows.length) return query ? `🔍 No memories matching "${query}".` : '🧠 No memories yet.';
        return [`*Memories${query ? ` matching "${query}"` : ''}:*`,
          ...rows.map(r => `• [${r.importance}/10] ${r.partner ? `*${r.partner}*: ` : ''}${r.content.slice(0, 150)}`)
        ].join('\n');
      }

      case '/clear':
        this.conversations.clear();
        return '🧹 Conversation history cleared.';

      default:
        return `❓ Unknown command \`${cmd}\`. Type \`/help\` for the command list.`;
    }
  }

  // ─── LLM chat ────────────────────────────────────────────────────────────────

  private async chat(userId: string, text: string): Promise<string> {
    const { llmCall } = await import('../../llm/index.js');
    const { buildSystemPrompt } = await import('../../prompts/index.js');

    const history = this.loadConversation(userId);

    const systemPrompt = this.argosConfig
      ? buildSystemPrompt('chat', this.argosConfig)
      : 'You are Argos, a professional AI assistant. Be concise and helpful.';

    history.messages.push({ role: 'user', content: text });

    // Compact if conversation is getting long
    if (history.messages.length > 30) {
      try {
        const { compactHistory } = await import('../../llm/compaction.js');
        const compacted = await compactHistory(history, this.llmConfig, llmCall);
        this.conversations.set(userId, compacted);
        history.messages = compacted.messages;
        history.compactedSummary = compacted.compactedSummary;
      } catch { /* continue without compaction */ }
    }

    // Prepend system message (llmCall strips it and passes as system param to the provider)
    const messagesWithSystem = [
      { role: 'system' as const, content: systemPrompt },
      ...history.messages,
    ];

    const response = await llmCall(this.llmConfig, messagesWithSystem);

    const reply = typeof response === 'string'
      ? response
      : (response as { content?: string })?.content ?? JSON.stringify(response);

    history.messages.push({ role: 'assistant', content: reply });
    this.conversations.set(userId, history);

    return reply;
  }

  private loadConversation(userId: string): CompactableHistory {
    return this.conversations.get(userId) ?? { messages: [], compactedSummary: undefined };
  }

  // ─── Slack REST helper ────────────────────────────────────────────────────────

  private async api(method: string, params: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json; charset=utf-8',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      throw new Error(`Slack API HTTP ${res.status}: ${method}`);
    }

    const data = await res.json() as SlackApiResponse;
    if (!data.ok) {
      throw new Error(`Slack API error (${method}): ${data.error ?? 'unknown'}`);
    }
    return data;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSlackBot(
  options: {
    botToken:          string;
    approvalChannelId: string;
    allowedUserIds?:   string[];
  },
  llmConfig: LLMConfig,
  config?: Config,
): SlackBot {
  return new SlackBot({
    token:             options.botToken,
    approvalChannelId: options.approvalChannelId,
    allowedUserIds:    options.allowedUserIds,
    llmConfig,
    config,
  });
}
