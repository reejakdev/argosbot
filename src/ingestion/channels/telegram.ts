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
  const resolved = dataDir.startsWith('~') ? path.join(os.homedir(), dataDir.slice(1)) : dataDir;
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
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent) {
      process.stdout.write(question);
      process.stdin.once('data', (data) => {
        process.stdout.write('\n');
        rl.close();
        resolve(data.toString().trim());
      });
    } else {
      rl.question(question, (answer) => {
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
  // Bot's own user ID extracted from TELEGRAM_BOT_TOKEN — skip its chatId in notifyUnknownChat
  private botId: string | null = null;
  // chatId → last notification timestamp (avoid spamming same unknown chat)
  private unknownChatCooldown = new Map<string, number>();
  // True while catch-up is draining — unknown chats are silently skipped
  private isCatchingUp = false;
  // chatId → topicId → topicName (in-memory cache, populated on demand)
  private topicNameCache = new Map<string, Map<number, string>>();

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
      connectionRetries: 10,
      retryDelay: 3000,
      autoReconnect: true,
      requestRetries: 5,
      // Use WSS (port 443) — more stable than TCPFull/80, has built-in keepalive,
      // and survives NAT timeouts / router resets much better.
      useWSS: true,
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

    // Extract bot ID from TELEGRAM_BOT_TOKEN (format: <id>:<hash>) so we can
    // skip the bot's own chatId in notifyUnknownChat (it's not a real partner chat).
    const botToken =
      process.env.TELEGRAM_BOT_TOKEN ?? getConfig().channels.telegram.personal.botToken;
    if (botToken) {
      this.botId = botToken.split(':')[0] ?? null;
      if (this.botId)
        log.debug(
          `Bot ID extracted: ${this.botId} — will be filtered from unknown-chat notifications`,
        );
    }

    // Register message listener BEFORE catchUp so missed messages flow through
    this.client.addEventHandler(this.onNewMessage.bind(this), new NewMessage({}));

    // Replay updates missed while the process was down.
    // Rate-limited: at most CATCHUP_MAX messages, one every CATCHUP_INTERVAL_MS.
    // If more messages arrived, we keep only the most recent CATCHUP_MAX.
    const CATCHUP_MAX = 20;
    const CATCHUP_INTERVAL_MS = 5_000; // 5s between messages → max 20 calls over ~100s
    try {
      const originalHandler = this.messageHandler;
      if (originalHandler) {
        const queue: (() => Promise<void>)[] = [];
        let draining = false;
        this.isCatchingUp = true;

        this.messageHandler = async (msg) => {
          if (queue.length >= CATCHUP_MAX) queue.shift(); // drop oldest, keep recent
          queue.push(() => originalHandler(msg));
          if (!draining) {
            draining = true;
            const drain = async () => {
              while (queue.length > 0) {
                const task = queue.shift();
                if (task) await task().catch((e) => log.warn('catchUp message error', e));
                if (queue.length > 0) await new Promise((r) => setTimeout(r, CATCHUP_INTERVAL_MS));
              }
              draining = false;
              this.isCatchingUp = false;
              this.messageHandler = originalHandler;
            };
            drain().catch((e) => log.warn('catchUp drain error', e));
          }
        };
      }

      log.info(
        `Telegram catch-up armed — up to ${CATCHUP_MAX} messages at 1 per ${CATCHUP_INTERVAL_MS / 1000}s`,
      );
    } catch (e) {
      // Non-fatal: if the session is fresh or pts is too old, Telegram may return
      // an error. We continue listening from now.
      log.warn('Telegram catch-up failed (non-fatal):', e instanceof Error ? e.message : String(e));
    }

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
    const chatId = String(
      msg.peerId
        ? (msg.peerId as unknown as { userId?: bigint; channelId?: bigint; chatId?: bigint })
            .userId ||
            (msg.peerId as unknown as { channelId?: bigint }).channelId ||
            (msg.peerId as unknown as { chatId?: bigint }).chatId ||
            msg.chatId
        : msg.chatId,
    );

    const senderId = String((msg.fromId as { userId?: bigint })?.userId ?? '');

    // Skip messages sent by ourselves (except commands in Saved Messages)
    const isSelf = senderId === String(this.meId ?? '');
    const isSavedMessages = chatId === String(this.meId ?? '');

    // Commands in Saved Messages → handle as control interface
    if (isSavedMessages && isSelf && msg.text.startsWith('/')) {
      await this.handleCommand(msg.text, msg.id);
      return;
    }

    // $ prefix anywhere (Saved Messages or monitored channel) → direct todo capture
    // The owner uses this to annotate conversations without going through the full pipeline.
    // e.g. "$follow up with partner about deposit" or "$check contract address"
    if (isSelf && msg.text?.startsWith('$')) {
      await this.captureTodo(msg.text, chatId);
      return;
    }

    // Skip own messages in group chats
    if (isSelf && !isSavedMessages) return;

    // Skip messages sent by bots — automated notifications, not partner messages
    if (senderId) {
      try {
        const senderEntity = (await this.client.getEntity(senderId)) as { bot?: boolean };
        if (senderEntity?.bot === true) {
          log.debug(`[listener] skipping bot sender ${senderId} in chat ${chatId}`);
          return;
        }
      } catch {
        /* non-blocking — if we can't resolve, allow through */
      }
    }

    // Skip messages from ignored senders (by username or user ID)
    const ignoredSenders = config.channels.telegram.listener.ignoredSenders ?? [];
    if (ignoredSenders.length > 0 && senderId) {
      const senderIdStr = String(senderId);
      if (ignoredSenders.includes(senderIdStr)) {
        log.debug(`[listener] skipping ignored sender ${senderId} in chat ${chatId}`);
        return;
      }
      // Also check by username
      try {
        const entity = (await this.client.getEntity(senderId)) as { username?: string };
        if (entity?.username && ignoredSenders.includes(entity.username.toLowerCase())) {
          log.debug(`[listener] skipping ignored sender @${entity.username} in chat ${chatId}`);
          return;
        }
      } catch {
        /* non-blocking */
      }
    }

    log.info(
      `[listener] message received — chatId=${chatId} senderId=${senderId} isSelf=${isSelf}`,
    );

    // Resolve monitored chat from config
    const monitored = config.channels.telegram.listener.monitoredChats.find(
      (c) => c.chatId === chatId || c.chatId === `-100${chatId}`,
    );

    // Unknown chat — notify owner proactively (once per chat, with cooldown)
    if (!monitored) {
      log.info(
        `[listener] unmonitored chat=${chatId} (monitored: ${config.channels.telegram.listener.monitoredChats.map((c) => c.chatId).join(', ')})`,
      );
      await this.notifyUnknownChat(chatId, msg);
      return;
    }

    const content = msg.text || (msg as unknown as { message?: string }).message || '';
    const msgId = typeof msg.id === 'number' ? msg.id : Number(msg.id);

    // Lazy-resolve chat name: if the stored name is the raw chatId (never resolved),
    // fetch the real display name and username from Telegram and patch the config entry.
    let resolvedChatName = monitored.name;
    let resolvedUsername: string | undefined;
    if (
      monitored.name === chatId ||
      monitored.name === `-100${chatId}` ||
      /^\d+$/.test(monitored.name)
    ) {
      try {
        const entity = await this.client.getEntity(chatId);
        const e = entity as unknown as { title?: string; firstName?: string; username?: string };
        resolvedUsername = e.username;
        const realName = e.title ?? e.firstName ?? e.username;
        if (realName) {
          resolvedChatName = realName;
          monitored.name = realName; // patch in-memory config so subsequent messages use real name
          // Persist to disk
          const { patchConfig } = await import('../../config/index.js');
          patchConfig((cfg) => {
            const m = cfg.channels.telegram.listener.monitoredChats.find(
              (c) => c.chatId === chatId || c.chatId === `-100${chatId}`,
            );
            if (m) m.name = realName;
          });
          log.info(`Resolved chat name for ${chatId}: "${realName}" (@${resolvedUsername ?? '?'})`);
        }
      } catch (e) {
        log.debug(`Could not resolve entity name for ${chatId}: ${(e as Error).message}`);
      }
    }

    const rawMessage: RawMessage = {
      id: ulid(),
      channel: 'telegram',
      source: 'telegram',
      chatId,
      chatName: resolvedChatName,
      chatType: resolveChatType(chatId, msg),
      partnerName: resolvedChatName,
      senderId,
      senderName: await this.resolveSenderName(msg),
      content,
      messageUrl: buildTelegramMessageUrl(
        chatId,
        msgId,
        resolvedUsername,
        (msg.replyTo as unknown as { replyToTopId?: number })?.replyToTopId,
      ),
      links: extractLinks(content),
      isForward: !!msg.fwdFrom,
      forwardFrom: resolveForwardSource(msg),
      mediaType: resolveMediaType(msg),
      replyToId: msg.replyTo?.replyToMsgId ? String(msg.replyTo.replyToMsgId) : undefined,
      threadId: (msg.replyTo as unknown as { replyToTopId?: number })?.replyToTopId
        ? String((msg.replyTo as unknown as { replyToTopId?: number }).replyToTopId)
        : undefined,
      threadName: (msg.replyTo as unknown as { replyToTopId?: number })?.replyToTopId
        ? await this.resolveTopicName(
            chatId,
            (msg.replyTo as unknown as { replyToTopId?: number }).replyToTopId!,
          )
        : undefined,
      receivedAt: Date.now(),
      timestamp: msg.date ? msg.date * 1000 : undefined,
      meta: {
        telegram_message_id: msgId,
        telegram_chat_id: chatId,
      },
    };

    // Detect replies to owner's own messages — triggers triage as if @mentioned
    if (rawMessage.replyToId && this.meId) {
      try {
        const replied = await this.client.getMessages(chatId, {
          ids: [Number(rawMessage.replyToId)],
        });
        const repliedMsg = replied?.[0];
        if (repliedMsg) {
          const repliedSenderId = (repliedMsg.fromId as { userId?: bigint })?.userId;
          if (repliedSenderId && String(repliedSenderId) === String(this.meId)) {
            rawMessage.meta = { ...rawMessage.meta, isReplyToMe: true };
            log.debug(
              `Reply to owner's message detected — msgId=${rawMessage.replyToId} in chat ${chatId}`,
            );
          }
        }
      } catch (e) {
        log.debug(
          `Could not check reply-to-me for msg ${rawMessage.replyToId}: ${(e as Error).message}`,
        );
      }
    }

    // Download photo for multimodal LLM processing (cap at 5MB, never logged)
    if (rawMessage.mediaType === 'photo') {
      try {
        const buffer = (await this.client.downloadMedia(msg, { outputFile: undefined })) as Buffer;
        if (buffer && buffer.length < 5 * 1024 * 1024) {
          rawMessage.meta = {
            ...rawMessage.meta,
            imageData: buffer.toString('base64'),
            imageMimeType: 'image/jpeg',
          };
        }
      } catch (e) {
        log.warn(`Photo download failed: ${(e as Error).message}`);
      }
    }

    // Transcribe voice/audio messages via Whisper (opt-in, audio never persisted)
    if (rawMessage.mediaType === 'voice' || rawMessage.mediaType === 'audio') {
      const voiceConfig = getConfig()?.voice;
      if (voiceConfig?.enabled) {
        try {
          const buffer = (await this.client.downloadMedia(msg, {
            outputFile: undefined,
          })) as Buffer;
          if (buffer) {
            const { transcribeAudio } = await import('../../voice/transcribe.js');
            const transcript = await transcribeAudio(buffer, 'voice.ogg', voiceConfig);
            rawMessage.content = `[Voice]: ${transcript}`;
            log.info(`Voice transcribed: ${transcript.slice(0, 80)}`);
          }
        } catch (e) {
          log.warn(`Voice transcription failed: ${(e as Error).message}`);
          rawMessage.content = '[Voice message — transcription unavailable]';
        }
      }
    }

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
    // Feature disabled by default — opt-in via telegram.listener.discoverUnknownChats: true
    if (!getConfig().channels.telegram.listener.discoverUnknownChats) return;

    // Skip if owner explicitly ignored this chat
    if (isIgnoredChat(chatId)) {
      log.debug(`Skipping ignored chat ${chatId}`);
      return;
    }

    // Skip the bot's own chatId — it's not a partner, it's the Argos bot itself.
    // Bot ID is extracted from TELEGRAM_BOT_TOKEN at startup.
    if (this.botId && chatId === this.botId) {
      log.debug(`Skipping bot's own chatId ${chatId} in notifyUnknownChat`);
      return;
    }

    // During catch-up replay, silently skip unknown chats — no LLM calls, no proposals
    if (this.isCatchingUp) {
      log.debug(`[catch-up] skipping unknown chat ${chatId}`);
      return;
    }

    // Cooldown: notify at most once per hour per unknown chat
    const COOLDOWN_MS = 60 * 60 * 1000;
    const last = this.unknownChatCooldown.get(chatId) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) return;
    this.unknownChatCooldown.set(chatId, Date.now());

    // Try to resolve chat display name from Telegram + check if it's a bot
    let displayName = chatId;
    let isBot = false;
    try {
      const entity = await this.client.getEntity(chatId);
      displayName =
        (entity as unknown as { title?: string; firstName?: string; username?: string }).title ??
        (entity as unknown as { firstName?: string }).firstName ??
        (entity as unknown as { username?: string }).username ??
        chatId;
      isBot = (entity as unknown as { bot?: boolean }).bot === true;
    } catch {
      /* not critical */
    }

    // Auto-ignore Telegram bots — they send automated updates, not partner messages
    if (isBot) {
      log.info(`Auto-ignoring bot chatId ${chatId} ("${displayName}") — adding to ignored list`);
      ignoreChat(chatId);
      return;
    }

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
    db.prepare(
      `
      INSERT INTO proposals (id, context_summary, plan, actions, draft_reply, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, NULL, 'proposed', ?, ?)
    `,
    ).run(
      proposal.id,
      proposal.contextSummary,
      proposal.plan,
      JSON.stringify(proposal.actions),
      now,
      proposal.expiresAt,
    );

    audit('partner_discovered', proposalId, 'discovery', { chatId, displayName, isGroup });

    try {
      await requestApproval(proposal);
    } catch (e) {
      log.warn(
        `Unknown chat discovery: could not send approval notification (${e instanceof Error ? e.message : String(e)}) — proposal saved in web app`,
      );
    }

    // Informational notification only — no actionable command
    try {
      await this.sendToApprovalChat(
        [
          `📥 *Nouveau chat détecté : ${displayName}*`,
          ``,
          `Type : ${isGroup ? 'groupe' : 'DM'} · ID : \`${chatId}\``,
          `Aperçu : _${preview || '(aucun texte)'}_`,
          ``,
          `Une proposition a été créée dans la web app.`,
          `Approuve pour suivre ce chat, ou /ignore-chat ${chatId} pour ignorer.`,
        ].join('\n'),
      );
    } catch (e) {
      log.warn(
        `Unknown chat discovery: Telegram notification failed (${e instanceof Error ? e.message : String(e)})`,
      );
    }

    log.info(
      `Unknown chat discovered: ${displayName} (${chatId}) — proposal ${proposalId} created`,
    );
  }

  private async resolveTopicName(chatId: string, topicId: number): Promise<string | undefined> {
    // Check cache first
    const chatCache = this.topicNameCache.get(chatId);
    if (chatCache?.has(topicId)) return chatCache.get(topicId);

    try {
      const entity = await this.client.getEntity(chatId);
      const result = await this.client.invoke(
        new Api.channels.GetForumTopics({
          channel: entity,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
          limit: 100,
        }),
      );
      const topics =
        (result as unknown as { topics: Array<{ id: number; title: string }> }).topics ?? [];
      const map = this.topicNameCache.get(chatId) ?? new Map<number, string>();
      for (const t of topics) map.set(t.id, t.title);
      this.topicNameCache.set(chatId, map);
      return map.get(topicId);
    } catch {
      return undefined;
    }
  }

  private async resolveSenderName(msg: Api.Message): Promise<string> {
    try {
      const sender = await msg.getSender();
      if (!sender) return 'unknown';
      const user = sender as Api.User;
      return (
        [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        user.username ||
        String(user.id)
      );
    } catch {
      return 'unknown';
    }
  }

  // ─── Send message ─────────────────────────────────────────────────────────────

  async sendMessage(
    chatId: string,
    text: string,
    _options?: unknown,
  ): Promise<{ message_id: number }> {
    const entity = chatId === 'me' || chatId === String(this.meId) ? 'me' : chatId;
    const result = await this.client.sendMessage(entity, { message: text, parseMode: 'md' });
    return { message_id: typeof result.id === 'number' ? result.id : Number(result.id) };
  }

  async sendToApprovalChat(text: string): Promise<void> {
    const config = getConfig();
    await this.sendMessage(config.channels.telegram.personal.approvalChatId ?? 'me', text);
  }

  // ─── $ todo capture ───────────────────────────────────────────────────────────
  // Owner sends "$<text>" in any monitored channel or Saved Messages.
  // Saved directly to tasks DB — bypasses classify/plan/approve (owner intent, low-risk).

  private async captureTodo(raw: string, chatId: string): Promise<void> {
    // Strip leading $ and optional whitespace
    const title = raw.replace(/^\$+\s*/, '').trim();
    if (!title) return;

    const { getDb, audit } = await import('../../db/index.js');
    const { monotonicFactory } = await import('ulid');
    const ulid = monotonicFactory();
    const db = getDb();

    const config = getConfig();
    const monitored = config.channels.telegram.listener.monitoredChats.find(
      (c) => c.chatId === chatId || c.chatId === `-100${chatId}`,
    );

    const id = ulid();
    const now = Date.now();

    db.prepare(
      `
      INSERT INTO tasks (id, title, category, source_ref, partner_name, chat_id, is_my_task, status, detected_at)
      VALUES (?, ?, 'task', ?, ?, ?, 1, 'open', ?)
    `,
    ).run(id, title, `telegram:${chatId}`, monitored?.name ?? null, chatId, now);

    audit('todo_captured', id, 'task', { title, chatId, source: 'dollar_prefix' });
    log.info(`Todo captured: "${title.slice(0, 60)}"${monitored ? ` [${monitored.name}]` : ''}`);

    // Confirm in Saved Messages — one line, unobtrusive
    const context = monitored ? ` · ${monitored.name}` : '';
    await this.sendMessage('me', `📋 \`${id.slice(-6)}\` ${title}${context}`).catch(() => {});
  }

  // ─── Saved Messages todo board ────────────────────────────────────────────────

  async addTodo(
    text: string,
    category: 'task' | 'approval' | 'reminder' | 'tx' = 'task',
  ): Promise<number> {
    const icons = { task: '📋', approval: '⏳', reminder: '⏰', tx: '🔐' };
    const formatted = `${icons[category]} ${text}\n\n_${new Date().toLocaleString('fr-FR')}_`;
    const result = await this.client.sendMessage('me', { message: formatted, parseMode: 'md' });
    return typeof result.id === 'number' ? result.id : Number(result.id);
  }

  async clearDoneTodos(): Promise<void> {
    const messages = await this.client.getMessages('me', { limit: 50 });
    const toDelete = messages
      .filter((m) => m.text?.startsWith('✅'))
      .map((m) => (typeof m.id === 'number' ? m.id : Number(m.id)));
    if (toDelete.length > 0) {
      await this.client.deleteMessages('me', toDelete, { revoke: true });
      log.info(`Cleared ${toDelete.length} done todos from Saved Messages`);
    }
  }

  // ─── Command handler (in Saved Messages) ─────────────────────────────────────

  private async handleCommand(text: string, _msgId: number): Promise<void> {
    const [cmd, ...args] = text.trim().split(/\s+/);

    switch (cmd) {
      case '/status':
        await this.sendMessage('me', await this.getStatusMessage());
        break;
      case '/tasks':
        await this.sendMessage('me', this.getTasksMessage());
        break;
      case '/memory':
        await this.sendMessage('me', this.getMemoryMessage());
        break;
      case '/proposals':
        await this.sendMessage('me', this.getPendingProposals());
        break;

      case '/approve': {
        const shortId = args[0];
        if (!shortId) {
          await this.sendMessage('me', '❌ Usage: /approve <id>');
          break;
        }
        const fullId = this.resolveProposalId(shortId);
        if (!fullId) {
          await this.sendMessage('me', `❌ Proposal ${shortId} not found`);
          break;
        }
        const resp = await handleCallback(
          `approve:${fullId}`,
          '',
          async (proposal: Proposal, actions: ProposedAction[], token: string) => {
            const config = getConfig();
            await executeProposal(
              proposal,
              actions,
              config,
              (t) => this.sendToApprovalChat(t),
              token,
            );
          },
        );
        await this.sendMessage('me', resp);
        break;
      }

      case '/reject': {
        const shortId = args[0];
        if (!shortId) {
          await this.sendMessage('me', '❌ Usage: /reject <id>');
          break;
        }
        const fullId = this.resolveProposalId(shortId);
        if (!fullId) {
          await this.sendMessage('me', `❌ Proposal ${shortId} not found`);
          break;
        }
        await this.sendMessage('me', await handleCallback(`reject:${fullId}`, '', async () => {}));
        break;
      }

      case '/todo':
        if (args.length > 0) await this.addTodo(args.join(' '), 'task');
        break;

      case '/todos': {
        await this.sendMessage('me', this.getTodosMessage());
        break;
      }

      case '/done': {
        const shortId = args[0];
        if (shortId) {
          // /done <id> — mark a specific todo complete
          await this.completeTodo(shortId);
        } else {
          await this.clearDoneTodos();
          await this.sendMessage('me', '✅ Done todos cleared from Saved Messages');
        }
        break;
      }

      case '/ignore-chat': {
        const targetId = args[0];
        if (!targetId) {
          await this.sendMessage('me', '❌ Usage: /ignore-chat <chatId>');
          break;
        }
        ignoreChat(targetId);
        await this.sendMessage(
          'me',
          `🔕 \`${targetId}\` ignored — no more discovery notifications.`,
        );
        break;
      }

      case '/help':
        await this.sendMessage('me', HELP_TEXT);
        break;

      default:
        await this.sendMessage('me', `Unknown command: ${cmd}\n\n${HELP_TEXT}`);
    }
  }

  // ─── /add_chat — list dialogs or add by number/id ─────────────────────────────
  // Called by TelegramBot (bot token side) which can't call getDialogs() itself.

  // In-memory cache of last /add_chat listing (number → {chatId, name, isGroup})
  dialogCache: Array<{ chatId: string; name: string; isGroup: boolean }> = [];

  async handleAddChat(
    args: string[],
    sendFn: (text: string) => Promise<void>,
    sendWithKeyboard?: (
      text: string,
      keyboard: Array<Array<{ text: string; callback_data: string }>>,
    ) => Promise<void>,
  ): Promise<void> {
    const { addMonitoredChat } = await import('../../config/index.js');

    // /add_chat <number|chatId> [name] — add from previous listing or by raw ID
    if (args.length > 0) {
      const ref = args[0];
      const customName = args.slice(1).join(' ');

      // Numeric index from last listing
      const idx = parseInt(ref, 10);
      if (!isNaN(idx) && this.dialogCache[idx - 1]) {
        const { chatId, name, isGroup } = this.dialogCache[idx - 1];
        addMonitoredChat(chatId, customName || name, isGroup);
        await sendFn(`✅ *${customName || name}* ajouté aux chats surveillés\n\`${chatId}\``);
        return;
      }

      // Raw chatId
      const label = customName || ref;
      const isGroup = ref.startsWith('-');
      addMonitoredChat(ref, label, isGroup);
      await sendFn(`✅ \`${ref}\` ajouté aux chats surveillés sous le nom *${label}*`);
      return;
    }

    // No args → fetch dialog list
    await sendFn('⏳ Récupération de tes chats…');

    try {
      const dialogs = await this.client.getDialogs({ limit: 50 });
      const config = getConfig();
      const already = new Set(
        config.channels.telegram.listener.monitoredChats.map((c) => c.chatId),
      );

      this.dialogCache = [];
      const entries: Array<{ chatId: string; name: string; isGroup: boolean; monitored: boolean }> =
        [];

      for (const d of dialogs) {
        const entity = d.entity as unknown as
          | {
              id?: bigint | number;
              title?: string;
              firstName?: string;
              lastName?: string;
              username?: string;
              className?: string;
            }
          | undefined;
        if (!entity) continue;

        const rawId = entity.id ? BigInt(entity.id.toString()) : null;
        if (!rawId) continue;

        const className = entity.className ?? '';
        const isGroup =
          className === 'Channel' ||
          className === 'Chat' ||
          className === 'ChatForbidden' ||
          className === 'ChannelForbidden';
        // Telegram supergroups/channels have negative IDs prefixed with -100
        const chatId = isGroup ? `-100${rawId.toString()}` : rawId.toString();
        const name =
          entity.title ??
          [entity.firstName, entity.lastName].filter(Boolean).join(' ') ??
          entity.username ??
          chatId;

        const monitored = already.has(chatId) || already.has(rawId.toString());
        this.dialogCache.push({ chatId, name, isGroup });
        entries.push({ chatId, name, isGroup, monitored });
      }

      if (sendWithKeyboard) {
        // Send as inline keyboard — each dialog = one button row
        // callback_data: "add_chat:<chatId>" (name looked up from dialogCache on click)
        const keyboard = entries.map(({ chatId, name, monitored }) => {
          const label = monitored ? `✅ ${name}` : name;
          const cbData = `add_chat:${chatId}`;
          return [{ text: label.slice(0, 64), callback_data: cbData.slice(0, 64) }];
        });

        // Telegram allows max ~100 buttons; split into chunks of 50
        const CHUNK = 50;
        for (let i = 0; i < keyboard.length; i += CHUNK) {
          const slice = keyboard.slice(i, i + CHUNK);
          const header =
            i === 0 ? '📋 *Tes chats Telegram* — clique pour en surveiller un' : '📋 _(suite…)_';
          await sendWithKeyboard(header, slice);
        }
        if (entries.length === 0) await sendFn('📭 Aucun chat trouvé.');
      } else {
        // Fallback: plain text list
        const lines: string[] = [
          '📋 *Tes chats Telegram* — réponds `/add_chat <n>` pour en surveiller un\n',
        ];
        entries.forEach(({ chatId, name, monitored }, i) => {
          lines.push(`${i + 1}. ${name}${monitored ? ' ✅' : ''}  \`${chatId}\``);
        });
        lines.push(`\n_/add_chat <n>  pour ajouter · /remove_chat <chatId>  pour retirer_`);

        const full = lines.join('\n');
        if (full.length < 4096) {
          await sendFn(full);
        } else {
          const chunks: string[][] = [[]];
          for (const l of lines) {
            if (chunks[chunks.length - 1].length >= 30) chunks.push([]);
            chunks[chunks.length - 1].push(l);
          }
          for (const chunk of chunks) await sendFn(chunk.join('\n'));
        }
      }
    } catch (e) {
      await sendFn(`❌ Erreur lors de la récupération des dialogs: ${(e as Error).message}`);
    }
  }

  // ─── /chats — list currently monitored chats ──────────────────────────────────

  async handleListMonitored(sendFn: (text: string) => Promise<void>): Promise<void> {
    const config = getConfig();
    const chats = config.channels.telegram.listener.monitoredChats;
    if (chats.length === 0) {
      await sendFn('📭 Aucun chat surveillé.\n\nUtilise `/add_chat` pour en ajouter.');
      return;
    }
    const lines = [`📡 *Chats surveillés (${chats.length})*\n`];
    for (const c of chats) {
      const tags = c.tags?.length ? `  [${c.tags.join(', ')}]` : '';
      lines.push(`• *${c.name}*  \`${c.chatId}\`${tags}`);
    }
    lines.push(`\n_/remove-chat <chatId>  pour retirer_`);
    await sendFn(lines.join('\n'));
  }

  // ─── /remove-chat — remove from monitored ─────────────────────────────────────

  async handleRemoveChat(chatId: string, sendFn: (text: string) => Promise<void>): Promise<void> {
    const { patchConfig } = await import('../../config/index.js');
    const config = getConfig();
    const before = config.channels.telegram.listener.monitoredChats.length;
    patchConfig((cfg) => {
      cfg.channels.telegram.listener.monitoredChats =
        cfg.channels.telegram.listener.monitoredChats.filter((c) => c.chatId !== chatId);
    });
    const after = getConfig().channels.telegram.listener.monitoredChats.length;
    if (after < before) {
      await sendFn(`✅ \`${chatId}\` retiré des chats surveillés`);
    } else {
      await sendFn(`❌ Chat \`${chatId}\` pas trouvé dans la liste surveillée`);
    }
  }

  private resolveProposalId(shortId: string): string | null {
    const db = getDb();
    const row = db
      .prepare(`SELECT id FROM proposals WHERE id LIKE ? AND status = 'awaiting_approval'`)
      .get(`%${shortId}`) as { id: string } | null;
    return row?.id ?? null;
  }

  // ─── Status helpers ───────────────────────────────────────────────────────────

  private async getStatusMessage(): Promise<string> {
    const db = getDb();
    const openTasks = (
      db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE status = 'open'`).get() as { c: number }
    ).c;
    const pendingApprovals = (
      db.prepare(`SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'`).get() as {
        c: number;
      }
    ).c;
    const memoriesCount = (
      db
        .prepare(`SELECT COUNT(*) as c FROM memories WHERE expires_at IS NULL OR expires_at > ?`)
        .get(Date.now()) as { c: number }
    ).c;
    const config = getConfig();
    return [
      `🔭 *Argos Status*`,
      ``,
      `📋 Open tasks: **${openTasks}**`,
      `⏳ Pending approvals: **${pendingApprovals}**`,
      `🧠 Active memories: **${memoriesCount}**`,
      `👤 ${config.owner.name} (${config.owner.teams.join(', ')})`,
      `🔒 Read-only: ${config.readOnly ? 'ON' : 'OFF'}`,
    ].join('\n');
  }

  private getTasksMessage(): string {
    const db = getDb();
    const tasks = db
      .prepare(
        `
      SELECT * FROM tasks WHERE status IN ('open', 'in_progress')
      ORDER BY is_my_task DESC, detected_at DESC LIMIT 10
    `,
      )
      .all() as Array<{ title: string; partner_name: string | null; is_my_task: number }>;

    if (tasks.length === 0) return '✅ No open tasks';
    const lines = [`📋 *Open tasks (${tasks.length})*`, ``];
    for (const t of tasks) {
      lines.push(
        `• ${t.title}${t.is_my_task ? ' 👤' : ''}${t.partner_name ? ` [${t.partner_name}]` : ''}`,
      );
    }
    return lines.join('\n');
  }

  private getMemoryMessage(): string {
    const db = getDb();
    const memories = db
      .prepare(
        `
      SELECT * FROM memories WHERE expires_at IS NULL OR expires_at > ?
      ORDER BY importance DESC, created_at DESC LIMIT 5
    `,
      )
      .all(Date.now()) as Array<{ content: string; importance: number }>;

    if (memories.length === 0) return '🧠 No active memories';
    return [`🧠 *Recent memories*`, ``]
      .concat(memories.map((m) => `• [${m.importance}/10] ${m.content.slice(0, 100)}`))
      .join('\n');
  }

  private getTodosMessage(): string {
    const db = getDb();
    const todos = db
      .prepare(
        `
      SELECT id, title, partner_name, detected_at FROM tasks
      WHERE is_my_task = 1 AND status = 'open' AND source_ref LIKE 'telegram:%'
      ORDER BY detected_at DESC LIMIT 20
    `,
      )
      .all() as Array<{
      id: string;
      title: string;
      partner_name: string | null;
      detected_at: number;
    }>;

    if (todos.length === 0) return '📋 No open todos — use $<text> to capture one';

    const lines = [`📋 *Open todos (${todos.length})*`, ``];
    for (const t of todos) {
      const ctx = t.partner_name ? ` · ${t.partner_name}` : '';
      lines.push(`• \`${t.id.slice(-6)}\` ${t.title}${ctx}`);
    }
    lines.push(``, `_/done <id> to complete · /done to clear all_`);
    return lines.join('\n');
  }

  private async completeTodo(shortId: string): Promise<void> {
    const db = getDb();
    const row = db
      .prepare(`SELECT id, title FROM tasks WHERE id LIKE ? AND status = 'open'`)
      .get(`%${shortId}`) as { id: string; title: string } | undefined;

    if (!row) {
      await this.sendMessage('me', `❌ Todo \`${shortId}\` not found`);
      return;
    }

    db.prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`).run(
      Date.now(),
      row.id,
    );

    await this.sendMessage('me', `✅ Done: ${row.title}`);
    log.info(`Todo completed: ${row.id} — ${row.title}`);
  }

  private getPendingProposals(): string {
    const db = getDb();
    const proposals = db
      .prepare(
        `
      SELECT id, context_summary, expires_at FROM proposals
      WHERE status = 'awaiting_approval'
      ORDER BY created_at DESC LIMIT 5
    `,
      )
      .all() as Array<{ id: string; context_summary: string; expires_at: number }>;

    if (proposals.length === 0) return '✅ No pending proposals';
    return [`⏳ *Pending proposals*`, ``]
      .concat(
        proposals.map((p) => {
          const exp = Math.round((p.expires_at - Date.now()) / 60_000);
          return `• \`${p.id.slice(-8)}\` — ${p.context_summary.slice(0, 80)} _(${exp}min)_\n  → /approve ${p.id.slice(-8)} or /reject ${p.id.slice(-8)}`;
        }),
      )
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

function buildTelegramMessageUrl(
  chatId: string,
  msgId: number,
  username?: string,
  topicId?: number,
): string | undefined {
  // DM (positive chatId = user ID)
  if (!chatId.startsWith('-')) {
    // If we have a username, t.me/{username} opens in app and works universally
    if (username) return `https://t.me/${username}`;
    // No username (user has none set) — open chat via web
    return `https://web.telegram.org/a/#${chatId}`;
  }

  // Supergroup/channel with -100 prefix: use t.me/c/... format
  if (chatId.startsWith('-100') && msgId) {
    const numericId = chatId.slice(4); // strip "-100"
    if (topicId) {
      // Forum topic: https://t.me/c/{numericId}/{topicId}/{msgId}
      return `https://t.me/c/${numericId}/${topicId}/${msgId}`;
    }
    return `https://t.me/c/${numericId}/${msgId}`;
  }

  // Legacy group or no msgId — web anchor
  if (msgId) return `https://web.telegram.org/a/#${chatId}_${msgId}`;
  return `https://web.telegram.org/a/#${chatId}`;
}

// ─── Chat type ────────────────────────────────────────────────────────────────
// Best-effort from peerId — no extra API call needed.
// Supergroups and broadcast channels both have channelId in peerId; we'd need
// to fetch the entity to distinguish them, so we map channelId → 'group'.
// Forum topics (replyToTopId set) → 'thread'.

function resolveChatType(chatId: string, msg: Api.Message): RawMessage['chatType'] {
  const replyTo = msg.replyTo as unknown as { replyToTopId?: number } | undefined;
  if (replyTo?.replyToTopId) return 'thread';

  const peer = msg.peerId as unknown as
    | { userId?: bigint; channelId?: bigint; chatId?: bigint }
    | undefined;
  if (peer?.userId) return 'dm';
  if (peer?.chatId) return 'group'; // PeerChat — basic group
  if (peer?.channelId) return 'group'; // PeerChannel — supergroup or broadcast channel

  // Fallback: infer from chatId sign (shouldn't reach here with valid peerId)
  if (chatId.startsWith('-')) return 'group';
  return 'dm';
}

// ─── Forward source ───────────────────────────────────────────────────────────

function resolveForwardSource(msg: Api.Message): string | undefined {
  const fwd = msg.fwdFrom as unknown as
    | {
        fromName?: string;
        fromId?: { channelId?: bigint; userId?: bigint };
        channelPost?: number;
      }
    | undefined;

  if (!fwd) return undefined;
  if (fwd.fromName) return fwd.fromName;
  if (fwd.fromId?.channelId) return `channel:${fwd.fromId.channelId}`;
  if (fwd.fromId?.userId) return `user:${fwd.fromId.userId}`;
  return undefined;
}

// ─── Media type ───────────────────────────────────────────────────────────────

function resolveMediaType(msg: Api.Message): RawMessage['mediaType'] {
  const media = msg.media as unknown as Record<string, unknown> | undefined;
  if (!media) return undefined;
  const className = String(media.className ?? '');
  if (className.includes('Photo')) return 'photo';
  if (className.includes('Video')) return 'video';
  if (className.includes('Document')) return 'document';
  if (className.includes('Audio')) return 'audio';
  if (className.includes('Voice')) return 'voice';
  if (className.includes('Sticker')) return 'sticker';
  return undefined;
}

// ─── Factory — reads API credentials from env/config ──────────────────────────

export function createTelegramChannel(dataDir: string): TelegramChannel {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH ?? '';

  if (!apiId || !apiHash) {
    throw new Error(
      'TELEGRAM_API_ID and TELEGRAM_API_HASH are required.\n' +
        'Get them from https://my.telegram.org → API development tools',
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

*Todos*
$<text> — Capture a todo from any monitored channel or here
/todos — List open todos
/done <id> — Mark a todo complete
/done — Clear all done todos from Saved Messages

*Partner management*
/add_chat — List all your chats to pick which ones to monitor
/add_chat <n> — Add chat n° from the last listing
/add_chat <chatId> [name] — Add by raw Telegram ID
/chats — Show currently monitored chats
/remove-chat <chatId> — Remove a chat from monitoring
/ignore-chat <chatId> — Suppress discovery notifications for a chat

*Help*
/help — This message

_Write commands or $todos in your Saved Messages._`;
