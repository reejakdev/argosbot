/**
 * Telegram channel — MTProto user client (gramjs).
 *
 * Uses the owner's OWN Telegram account, not a bot.
 * This means Argos reads messages exactly as the user would see them,
 * from any group or channel they're a member of — no bot invite needed.
 *
 * Authentication flow (first run):
 *   1. Prompt for phone number
 *   2. Prompt for the code Telegram sends
 *   3. Prompt for 2FA password if enabled
 *   4. Session string saved to ~/.argos/telegram_session (encrypted by Telegram)
 *   Subsequent runs: load session silently, no re-auth needed.
 *
 * Approval flow:
 *   - Proposals are sent to Saved Messages (your personal Telegram chat)
 *   - Or to a configurable chat ID (dedicated review chat, spouse, assistant, etc.)
 *   - Replies in that chat drive approval (commands or inline-style via bot bridge)
 *
 * V3 enterprise:
 *   - Swap StringSession for a bot token in config
 *   - The Channel interface stays the same — registry handles the switch
 *
 * Saved Messages as Todo board:
 *   - Argos can write to your Saved Messages as a personal task list
 *   - Each task is a pinnable message with emoji prefix
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import readline from 'readline';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { monotonicFactory } from 'ulid';
import { createLogger } from '../../logger.js';
import { getConfig, ignoreChat, isIgnoredChat } from '../../config/index.js';
import { getDb, audit } from '../../db/index.js';
import { handleCallback, requestApproval } from '../../gateway/approval.js';
import { executeProposal } from '../../workers/index.js';
import type { RawMessage, Proposal, ProposedAction } from '../../types.js';
import type { Channel } from './registry.js';

const ulid = monotonicFactory();
const log = createLogger('telegram');

// ─── Session persistence ──────────────────────────────────────────────────────

function getSessionPath(dataDir: string): string {
  const resolved = dataDir.startsWith('~')
    ? path.join(os.homedir(), dataDir.slice(1))
    : dataDir;
  return path.join(resolved, 'telegram_session');
}

function loadSession(sessionPath: string): string {
  if (fs.existsSync(sessionPath)) {
    return fs.readFileSync(sessionPath, 'utf-8').trim();
  }
  return '';
}

function saveSession(sessionPath: string, session: string): void {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, session, { mode: 0o600 }); // owner-only read
}

// ─── Interactive auth prompts ─────────────────────────────────────────────────

function prompt(question: string, silent = false): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent) {
      process.stdout.write(question);
      process.stdin.once('data', data => {
        process.stdout.write('\n');
        rl.close();
        resolve(data.toString().trim());
      });
    } else {
      rl.question(question, answer => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

// ─── Telegram user channel ────────────────────────────────────────────────────

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private client!: TelegramClient;
  private messageHandler: ((msg: RawMessage) => Promise<void>) | null = null;
  private sessionPath: string;
  // "Me" entity — resolved after auth
  private meId: bigint | null = null;
  // chatId → last notification timestamp (avoid spamming same unknown chat)
  private unknownChatCooldown = new Map<string, number>();

  constructor(
    private apiId: number,
    private apiHash: string,
    dataDir: string,
  ) {
    this.sessionPath = getSessionPath(dataDir);
  }

  onMessage(handler: (msg: RawMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  // ─── Auth + start ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const sessionStr = loadSession(this.sessionPath);
    const session = new StringSession(sessionStr);

    this.client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
    });

    await this.client.start({
      phoneNumber: async () => {
        log.info('First-time Telegram auth — enter your phone number');
        return prompt('📱 Phone number (international format, e.g. +33612345678): ');
      },
      password: async () => {
        return prompt('🔐 Two-factor password (leave empty if none): ', true);
      },
      phoneCode: async () => {
        return prompt('📨 Verification code from Telegram: ');
      },
      onError: (err) => {
        log.error('Telegram auth error', err);
      },
    });

    // Persist session for future runs
    const newSession = String(this.client.session.save());
    saveSession(this.sessionPath, newSession);
    log.info(`Session saved to ${this.sessionPath}`);

    // Resolve "me"
    const me = await this.client.getMe();
    this.meId = BigInt((me as Api.User).id.toString());
    log.info(`Logged in as: ${(me as Api.User).firstName} (@${(me as Api.User).username})`);

    // Register message listener
    this.client.addEventHandler(
      this.onNewMessage.bind(this),
      new NewMessage({}),
    );

    log.info('Telegram user client started — listening to all chats');
  }

  async stop(): Promise<void> {
    await this.client?.disconnect();
    log.info('Telegram client disconnected');
  }

  // ─── Inbound message handler ─────────────────────────────────────────────────

  private async onNewMessage(event: NewMessageEvent): Promise<void> {
    const msg = event.message;
    // Accept messages with text OR media (caption)
    const text = msg?.text || (msg as unknown as { message?: string })?.message || '';
    if (!text && !msg?.media) return;

    const config = getConfig();
    const chatId = String(msg.peerId
      ? (msg.peerId as unknown as { userId?: bigint; channelId?: bigint; chatId?: bigint }).userId
        || (msg.peerId as unknown as { channelId?: bigint }).channelId
        || (msg.peerId as unknown as { chatId?: bigint }).chatId
        || msg.chatId
      : msg.chatId);

    const senderId = String((msg.fromId as { userId?: bigint })?.userId ?? '');

    // Skip messages sent by ourselves (except commands in Saved Messages)
    const isSelf = senderId === String(this.meId ?? '');
    const isSavedMessages = chatId === String(this.meId ?? '');

    // Commands in Saved Messages → handle as control interface
    if (isSavedMessages && isSelf && msg.text.startsWith('/')) {
      await this.handleCommand(msg.text, msg.id);
      return;
    }

    // Skip own messages in group chats
    if (isSelf && !isSavedMessages) return;

    // Resolve monitored chat from config
    const monitored = config.telegram.monitoredChats.find(
      c => c.chatId === chatId || c.chatId === `-100${chatId}`,
    );

    // Unknown chat — notify owner proactively (once per chat, with cooldown)
    if (!monitored) {
      await this.notifyUnknownChat(chatId, msg);
      return;
    }

    const content = msg.text || (msg as unknown as { message?: string }).message || '';
    const msgId   = typeof msg.id === 'number' ? msg.id : Number(msg.id);

    const rawMessage: RawMessage = {
      id:          ulid(),
      source:      'telegram',
      chatId,
      partnerName: monitored.name,
      senderId,
      senderName:  await this.resolveSenderName(msg),
      content,
      messageUrl:  buildTelegramMessageUrl(chatId, msgId, monitored.name),
      links:       extractLinks(content),
      isForward:   !!msg.fwdFrom,
      forwardFrom: resolveForwardSource(msg),
      mediaType:   resolveMediaType(msg),
      replyToId:   msg.replyTo?.replyToMsgId ? String(msg.replyTo.replyToMsgId) : undefined,
      receivedAt:  (msg.date ?? 0) * 1000 || Date.now(),
    };

    log.debug(`Message from ${monitored.name}`, {
      sender: rawMessage.senderName,
      length: msg.text.length,
    });

    if (this.messageHandler) {
      await this.messageHandler(rawMessage);
    }
  }

  // ─── Discovery: proactive notification for unknown chats ─────────────────────

  private async notifyUnknownChat(chatId: string, msg: Api.Message): Promise<void> {
    // Skip if owner explicitly ignored this chat
    if (isIgnoredChat(chatId)) {
      log.debug(`Skipping ignored chat ${chatId}`);
      return;
    }

    // Cooldown: notify at most once per hour per unknown chat
    const COOLDOWN_MS = 60 * 60 * 1000;
    const last = this.unknownChatCooldown.get(chatId) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) return;
    this.unknownChatCooldown.set(chatId, Date.now());

    // Try to resolve chat display name from Telegram
    let displayName = chatId;
    try {
      const entity = await this.client.getEntity(chatId);
      displayName = (entity as unknown as { title?: string; firstName?: string; username?: string })
        .title
        ?? (entity as unknown as { firstName?: string }).firstName
        ?? (entity as unknown as { username?: string }).username
        ?? chatId;
    } catch { /* not critical */ }

    const preview = (msg.text ?? '').slice(0, 80).replace(/\n/g, ' ');
    const isGroup = chatId.startsWith('-');

    // Create a proposal in the web app approval queue
    // Low-risk — owner can approve from Telegram or web app
    const proposalId = ulid();
    const now = Date.now();

    const action: ProposedAction = {
      type: 'scheduler',
      description: `Add "${displayName}" (${chatId}) to monitored chats`,
      risk: 'low',
      payload: {
        tool: 'telegram_add_chat',
        input: { chatId, name: displayName, isGroup },
      },
      requiresApproval: true,
    };

    const proposal: Proposal = {
      id: proposalId,
      contextSummary: `New ${isGroup ? 'group' : 'DM'} detected: "${displayName}" (${chatId})`,
      plan: `A message was received from an unknown chat. Add it to the monitored partner list so future messages are processed by Argos.`,
      actions: [action],
      status: 'proposed',
      createdAt: now,
      expiresAt: now + 7 * 24 * 60 * 60 * 1000, // 7 days — no urgency
    };

    const db = getDb();
    db.prepare(`
      INSERT INTO proposals (id, context_summary, plan, actions, draft_reply, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, NULL, 'proposed', ?, ?)
    `).run(
      proposal.id,
      proposal.contextSummary,
      proposal.plan,
      JSON.stringify(proposal.actions),
      now,
      proposal.expiresAt,
    );

    audit('partner_discovered', proposalId, 'discovery', { chatId, displayName, isGroup });

    await requestApproval(proposal);

    // Informational notification only — no actionable command
    await this.sendToApprovalChat([
      `📥 *Nouveau chat détecté : ${displayName}*`,
      ``,
      `Type : ${isGroup ? 'groupe' : 'DM'} · ID : \`${chatId}\``,
      `Aperçu : _${preview || '(aucun texte)'}_`,
      ``,
      `Une proposition a été créée dans la web app.`,
      `Approuve pour suivre ce chat, ou /ignore-chat ${chatId} pour ignorer.`,
    ].join('\n'));

    log.info(`Unknown chat discovered: ${displayName} (${chatId}) — proposal ${proposalId} created`);
  }

  private async resolveSenderName(msg: Api.Message): Promise<string> {
    try {
      const sender = await msg.getSender();
      if (!sender) return 'unknown';
      const user = sender as Api.User;
      return [user.firstName, user.lastName].filter(Boolean).join(' ')
        || user.username
        || String(user.id);
    } catch {
      return 'unknown';
    }
  }

  // ─── Send message ─────────────────────────────────────────────────────────────

  async sendMessage(chatId: string, text: string, _options?: unknown): Promise<{ message_id: number }> {
    const entity = chatId === 'me' || chatId === String(this.meId) ? 'me' : chatId;
    const result = await this.client.sendMessage(entity, { message: text, parseMode: 'md' });
    return { message_id: typeof result.id === 'number' ? result.id : Number(result.id) };
  }

  async sendToApprovalChat(text: string): Promise<void> {
    const config = getConfig();
    await this.sendMessage(config.telegram.approvalChatId ?? 'me', text);
  }

  // ─── Saved Messages todo board ────────────────────────────────────────────────

  async addTodo(text: string, category: 'task' | 'approval' | 'reminder' | 'tx' = 'task'): Promise<number> {
    const icons = { task: '📋', approval: '⏳', reminder: '⏰', tx: '🔐' };
    const formatted = `${icons[category]} ${text}\n\n_${new Date().toLocaleString('fr-FR')}_`;
    const result = await this.client.sendMessage('me', { message: formatted, parseMode: 'md' });
    return typeof result.id === 'number' ? result.id : Number(result.id);
  }

  async clearDoneTodos(): Promise<void> {
    const messages = await this.client.getMessages('me', { limit: 50 });
    const toDelete = messages
      .filter(m => m.text?.startsWith('✅'))
      .map(m => typeof m.id === 'number' ? m.id : Number(m.id));
    if (toDelete.length > 0) {
      await this.client.deleteMessages('me', toDelete, { revoke: true });
      log.info(`Cleared ${toDelete.length} done todos from Saved Messages`);
    }
  }

  // ─── Command handler (in Saved Messages) ─────────────────────────────────────

  private async handleCommand(text: string, _msgId: number): Promise<void> {
    const [cmd, ...args] = text.trim().split(/\s+/);

    switch (cmd) {
      case '/status':    await this.sendMessage('me', await this.getStatusMessage()); break;
      case '/tasks':     await this.sendMessage('me', this.getTasksMessage()); break;
      case '/memory':    await this.sendMessage('me', this.getMemoryMessage()); break;
      case '/proposals': await this.sendMessage('me', this.getPendingProposals()); break;

      case '/approve': {
        const shortId = args[0];
        if (!shortId) { await this.sendMessage('me', '❌ Usage: /approve <id>'); break; }
        const fullId = this.resolveProposalId(shortId);
        if (!fullId) { await this.sendMessage('me', `❌ Proposal ${shortId} not found`); break; }
        const resp = await handleCallback(
          `approve:${fullId}`, '',
          async (proposal: Proposal, actions: ProposedAction[]) => {
            const config = getConfig();
            await executeProposal(proposal, actions, config, t => this.sendToApprovalChat(t));
          },
        );
        await this.sendMessage('me', resp);
        break;
      }

      case '/reject': {
        const shortId = args[0];
        if (!shortId) { await this.sendMessage('me', '❌ Usage: /reject <id>'); break; }
        const fullId = this.resolveProposalId(shortId);
        if (!fullId) { await this.sendMessage('me', `❌ Proposal ${shortId} not found`); break; }
        await this.sendMessage('me', await handleCallback(`reject:${fullId}`, '', async () => {}));
        break;
      }

      case '/todo':
        if (args.length > 0) await this.addTodo(args.join(' '), 'task');
        break;

      case '/done':
        await this.clearDoneTodos();
        await this.sendMessage('me', '✅ Done todos cleared from Saved Messages');
        break;

      case '/ignore-chat': {
        const targetId = args[0];
        if (!targetId) { await this.sendMessage('me', '❌ Usage: /ignore-chat <chatId>'); break; }
        ignoreChat(targetId);
        await this.sendMessage('me', `🔕 \`${targetId}\` ignored — no more discovery notifications.`);
        break;
      }

      case '/help':
        await this.sendMessage('me', HELP_TEXT);
        break;

      default:
        await this.sendMessage('me', `Unknown command: ${cmd}\n\n${HELP_TEXT}`);
    }
  }

  private resolveProposalId(shortId: string): string | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT id FROM proposals WHERE id LIKE ? AND status = 'awaiting_approval'`,
    ).get(`%${shortId}`) as { id: string } | null;
    return row?.id ?? null;
  }

  // ─── Status helpers ───────────────────────────────────────────────────────────

  private async getStatusMessage(): Promise<string> {
    const db = getDb();
    const openTasks       = (db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE status = 'open'`).get() as { c: number }).c;
    const pendingApprovals = (db.prepare(`SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'`).get() as { c: number }).c;
    const memoriesCount   = (db.prepare(`SELECT COUNT(*) as c FROM memories WHERE expires_at IS NULL OR expires_at > ?`).get(Date.now()) as { c: number }).c;
    const config = getConfig();
    return [
      `🔭 *Argos Status*`, ``,
      `📋 Open tasks: **${openTasks}**`,
      `⏳ Pending approvals: **${pendingApprovals}**`,
      `🧠 Active memories: **${memoriesCount}**`,
      `👤 ${config.owner.name} (${config.owner.teams.join(', ')})`,
      `🔒 Read-only: ${config.readOnly ? 'ON' : 'OFF'}`,
    ].join('\n');
  }

  private getTasksMessage(): string {
    const db = getDb();
    const tasks = db.prepare(`
      SELECT * FROM tasks WHERE status IN ('open', 'in_progress')
      ORDER BY is_my_task DESC, detected_at DESC LIMIT 10
    `).all() as Array<{ title: string; partner_name: string | null; is_my_task: number }>;

    if (tasks.length === 0) return '✅ No open tasks';
    const lines = [`📋 *Open tasks (${tasks.length})*`, ``];
    for (const t of tasks) {
      lines.push(`• ${t.title}${t.is_my_task ? ' 👤' : ''}${t.partner_name ? ` [${t.partner_name}]` : ''}`);
    }
    return lines.join('\n');
  }

  private getMemoryMessage(): string {
    const db = getDb();
    const memories = db.prepare(`
      SELECT * FROM memories WHERE expires_at IS NULL OR expires_at > ?
      ORDER BY importance DESC, created_at DESC LIMIT 5
    `).all(Date.now()) as Array<{ content: string; importance: number }>;

    if (memories.length === 0) return '🧠 No active memories';
    return [`🧠 *Recent memories*`, ``]
      .concat(memories.map(m => `• [${m.importance}/10] ${m.content.slice(0, 100)}`))
      .join('\n');
  }

  private getPendingProposals(): string {
    const db = getDb();
    const proposals = db.prepare(`
      SELECT id, context_summary, expires_at FROM proposals
      WHERE status = 'awaiting_approval'
      ORDER BY created_at DESC LIMIT 5
    `).all() as Array<{ id: string; context_summary: string; expires_at: number }>;

    if (proposals.length === 0) return '✅ No pending proposals';
    return [`⏳ *Pending proposals*`, ``]
      .concat(proposals.map(p => {
        const exp = Math.round((p.expires_at - Date.now()) / 60_000);
        return `• \`${p.id.slice(-8)}\` — ${p.context_summary.slice(0, 80)} _(${exp}min)_\n  → /approve ${p.id.slice(-8)} or /reject ${p.id.slice(-8)}`;
      }))
      .join('\n');
  }
}

// ─── URL extraction ───────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

function extractLinks(text: string): string[] {
  return [...new Set(text.match(URL_REGEX) ?? [])];
}

// ─── Telegram message permalink ───────────────────────────────────────────────
// Public channel (username known): https://t.me/{username}/{msgId}
// Private group/channel (-100...): https://t.me/c/{numericId}/{msgId}
// DM: no public permalink

function buildTelegramMessageUrl(chatId: string, msgId: number, chatName?: string): string | undefined {
  if (!msgId) return undefined;

  // Private supergroup/channel — chatId starts with -100
  if (chatId.startsWith('-100')) {
    const numericId = chatId.slice(4); // strip "-100"
    return `https://t.me/c/${numericId}/${msgId}`;
  }

  // Negative chatId (legacy group) — no public link
  if (chatId.startsWith('-')) return undefined;

  // Positive chatId could be a public channel — but we'd need the username,
  // not the numeric ID, to build the link. Leave undefined (no false links).
  void chatName;
  return undefined;
}

// ─── Forward source ───────────────────────────────────────────────────────────

function resolveForwardSource(msg: Api.Message): string | undefined {
  const fwd = msg.fwdFrom as unknown as {
    fromName?: string;
    fromId?: { channelId?: bigint; userId?: bigint };
    channelPost?: number;
  } | undefined;

  if (!fwd) return undefined;
  if (fwd.fromName) return fwd.fromName;
  if (fwd.fromId?.channelId) return `channel:${fwd.fromId.channelId}`;
  if (fwd.fromId?.userId)    return `user:${fwd.fromId.userId}`;
  return undefined;
}

// ─── Media type ───────────────────────────────────────────────────────────────

function resolveMediaType(msg: Api.Message): RawMessage['mediaType'] {
  const media = msg.media as unknown as Record<string, unknown> | undefined;
  if (!media) return undefined;
  const className = String(media.className ?? '');
  if (className.includes('Photo'))    return 'photo';
  if (className.includes('Video'))    return 'video';
  if (className.includes('Document')) return 'document';
  if (className.includes('Audio'))    return 'audio';
  if (className.includes('Voice'))    return 'voice';
  if (className.includes('Sticker'))  return 'sticker';
  return undefined;
}

// ─── Factory — reads API credentials from env/config ──────────────────────────

export function createTelegramChannel(dataDir: string): TelegramChannel {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH ?? '';

  if (!apiId || !apiHash) {
    throw new Error(
      'TELEGRAM_API_ID and TELEGRAM_API_HASH are required.\n' +
      'Get them from https://my.telegram.org → API development tools'
    );
  }

  return new TelegramChannel(apiId, apiHash, dataDir);
}

const HELP_TEXT = `🔭 *Argos — Commands* (in Saved Messages)

*Approvals*
/approve <id> — Approve a proposal (low-risk only)
/reject <id> — Reject a proposal
/proposals — Pending approvals

*Tasks & memory*
/tasks — Open tasks
/memory — Active memories
/status — System overview

*Partner management*
/ignore-chat <chatId> — Ignore discovery notifications for a chat
_(To add a partner, approve the proposal in the web app)_

*Utilities*
/todo <text> — Add a todo
/done — Clear completed todos
/help — This message

_Write commands in your Saved Messages chat._`;
