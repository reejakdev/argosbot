/**
 * Telegram Bot channel — interactive chat with Argos via @BotFather bot.
 *
 * Uses long-polling on the Telegram Bot API (no webhook, no dependency).
 * This is the PRIMARY interaction channel — the user talks to Argos here.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../../logger.js';
import type { LLMConfig, LLMMessage } from '../../llm/index.js';
import type { Config } from '../../config/schema.js';
import type { CompactableHistory } from '../../llm/compaction.js';

const log = createLogger('telegram-bot');

const POLL_TIMEOUT = 30; // seconds (Telegram long-poll)

export interface TelegramBotOptions {
  token: string;
  allowedUsers: string[];  // Telegram user IDs allowed to interact
  llmConfig: LLMConfig;
  config?: Config;          // Full Argos config — used to build system prompt
  onMessage?: (userId: string, text: string) => Promise<string>;
}

export class TelegramBot {
  private token: string;
  private allowedUsers: Set<string>;
  private offset = 0;
  private running = false;
  private llmConfig: LLMConfig;
  private argosConfig: Config | undefined;
  private onMessage: (userId: string, text: string) => Promise<string>;
  private conversations: Map<string, CompactableHistory> = new Map();
  private lastChatId: string | null = null;
  private pendingConfirmation: Map<string, string> = new Map();
  private approvalChatIdSaved = false;

  constructor(options: TelegramBotOptions) {
    this.token = options.token;
    this.allowedUsers = new Set(options.allowedUsers);
    this.llmConfig = options.llmConfig;
    this.argosConfig = options.config;
    this.onMessage = options.onMessage ?? this.defaultHandler.bind(this);
  }

  private get baseUrl(): string {
    return `https://api.telegram.org/bot${this.token}`;
  }

  async start(): Promise<void> {
    this.running = true;
    log.info('Telegram Bot started — polling for messages');

    // Clear old updates
    try {
      await this.api('getUpdates', { offset: -1 });
    } catch { /* ignore */ }

    this.poll();
  }

  stop(): void {
    this.running = false;
    log.info('Telegram Bot stopped');
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const data = await this.api('getUpdates', {
          offset: this.offset,
          timeout: POLL_TIMEOUT,
          allowed_updates: ['message'],
        }) as { result: TgUpdate[] };

        for (const update of data.result) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (e) {
        log.error('Polling error:', e);
        // Wait before retrying
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.from) return;

    const userId = String(msg.from.id);
    const chatId = String(msg.chat.id);

    // Handle file uploads (documents, photos)
    if (msg.document || msg.photo) {
      await this.handleFileUpload(msg, userId, chatId);
      return;
    }

    if (!msg.text) return;
    const text = msg.text.trim();

    // Security: only respond to allowed users
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId)) {
      log.warn(`Ignoring message from unauthorized user ${userId}`);
      return;
    }

    // Auto-save approvalChatId on first message (so notifications work)
    if (!this.approvalChatIdSaved) {
      this.approvalChatIdSaved = true;
      try {
        const cfgPath = path.join(os.homedir(), '.argos', 'config.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (!cfg.telegram?.approvalChatId || cfg.telegram.approvalChatId === 'me') {
          cfg.telegram = cfg.telegram ?? {};
          cfg.telegram.approvalChatId = chatId;
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
          log.info(`Auto-saved approvalChatId: ${chatId}`);
        }
      } catch { /* non-blocking */ }
    }

    this.lastChatId = chatId;
    log.info(`Message from ${msg.from.first_name ?? userId}: ${text.slice(0, 50)}…`);

    // Handle pending confirmation (user replied "yes" to sensitive data warning)
    const pending = this.pendingConfirmation.get(userId);
    if (pending) {
      this.pendingConfirmation.delete(userId);
      if (/^(yes|oui|y|o|ok)$/i.test(text.trim())) {
        // User confirmed — process the sanitized message
        const typingInterval = setInterval(() => {
          this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
        }, 4000);
        try {
          const response = await this.onMessage(userId, pending);
          clearInterval(typingInterval);
          await this.sendMessage(chatId, response);
        } catch (e) {
          clearInterval(typingInterval);
          await this.sendMessage(chatId, `⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        await this.sendMessage(chatId, '🚫 Message cancelled. Your sensitive data was not sent.');
      }
      return;
    }

    // Handle commands
    if (text.startsWith('/')) {
      await this.handleCommand(chatId, userId, text);
      return;
    }

    // Chat guard — auto-redact secrets + warn on sensitive data
    const { guardMessage } = await import('../../privacy/chat-guard.js');
    const guard = guardMessage(text);

    if (guard.redacted) {
      log.warn(`🛡️ Auto-redacted ${guard.redactedItems.length} item(s): ${guard.redactedItems.join(', ')}`);
      await this.sendMessage(chatId, `🛡️ Données sensibles détectées et masquées automatiquement:\n${guard.redactedItems.map(i => `• ${i}`).join('\n')}`);
    }

    // If sensitive data detected, ask for confirmation
    if (guard.needsConfirmation) {
      // Store pending message for this user
      this.pendingConfirmation.set(userId, guard.sanitized);
      await this.sendMessage(chatId, guard.warningMessage!);
      return;
    }

    const safeText = guard.sanitized;

    // Send typing indicator — keep refreshing every 4s while processing
    const typingInterval = setInterval(() => {
      this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    }, 4000);
    this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    try {
      const response = await this.onMessage(userId, safeText);
      clearInterval(typingInterval);
      await this.sendMessage(chatId, response);
    } catch (e) {
      clearInterval(typingInterval);
      const errMsg = e instanceof Error ? e.message : JSON.stringify(e);
      log.error(`Error handling message: ${errMsg}`);
      if (e instanceof Error && e.stack) log.error(e.stack);
      await this.sendMessage(chatId, `⚠️ Error: ${errMsg.slice(0, 200)}`);
    }
  }

  private async handleFileUpload(msg: NonNullable<TgUpdate['message']>, userId: string, chatId: string): Promise<void> {
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId)) return;

    const fileId = msg.document?.file_id ?? msg.photo?.[msg.photo.length - 1]?.file_id;
    const fileName = msg.document?.file_name ?? 'photo.jpg';
    const caption = msg.caption ?? '';

    if (!fileId) return;

    this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    try {
      // Get file path from Telegram
      const fileInfo = await this.api('getFile', { file_id: fileId }) as {
        result: { file_path: string };
      };
      const fileUrl = `https://api.telegram.org/file/bot${this.token}/${fileInfo.result.file_path}`;

      // Download file
      const res = await fetch(fileUrl);
      const buffer = Buffer.from(await res.arrayBuffer());

      // Save to context directory
      const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
      const resolvedDir = dataDir.startsWith('~') ? path.join(os.homedir(), dataDir.slice(1)) : dataDir;
      const contextDir = path.join(resolvedDir, 'context', 'uploads');
      fs.mkdirSync(contextDir, { recursive: true });

      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(contextDir, `${Date.now()}_${safeName}`);
      fs.writeFileSync(filePath, buffer);

      log.info(`File saved: ${filePath} (${buffer.length} bytes)`);

      // If it's a text-based file, read and process it
      const ext = path.extname(fileName).toLowerCase();
      const textExts = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.yml', '.yaml', '.toml', '.log', '.py', '.js', '.ts'];

      let fileContent = '';
      if (textExts.includes(ext) || msg.document?.mime_type?.startsWith('text/')) {
        fileContent = buffer.toString('utf8').slice(0, 10000);
      }

      // Send to LLM for analysis
      const prompt = fileContent
        ? `The user sent a file: "${fileName}"\n${caption ? `Caption: "${caption}"\n` : ''}Content:\n\`\`\`\n${fileContent}\n\`\`\`\n\nAnalyze this file and respond helpfully.`
        : `The user sent a file: "${fileName}" (${buffer.length} bytes, type: ${msg.document?.mime_type ?? 'image'})\n${caption ? `Caption: "${caption}"\n` : ''}The file has been saved to your context. Acknowledge receipt and ask if they need anything specific with it.`;

      const response = await this.onMessage(userId, prompt);
      await this.sendMessage(chatId, response);
    } catch (e) {
      log.error(`File upload error: ${e}`);
      await this.sendMessage(chatId, `⚠️ Error processing file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async handleCommand(chatId: string, userId: string, text: string): Promise<void> {
    const [cmd, ...args] = text.split(' ');
    const arg = args.join(' ');

    switch (cmd) {
      case '/start':
        await this.sendMessage(chatId,
          '👋 Hey! I\'m Argos — your AI assistant.\n\n' +
          'Just send me a message and I\'ll help you.\n\n' +
          'Commands:\n' +
          '/status — system status\n' +
          '/clear — reset conversation\n' +
          '/help — all commands',
        );
        break;

      case '/status':
        await this.sendMessage(chatId,
          '🔭 Argos is running\n' +
          `Model: ${this.llmConfig.model}\n` +
          `Provider: ${this.llmConfig.provider}`,
        );
        break;

      case '/clear':
        this.conversations.delete(userId);
        await this.sendMessage(chatId, '🧹 Conversation cleared.');
        break;

      case '/approve':
      case '/reject':
        await this.sendMessage(chatId, '🔒 Approvals are only available on the web app (2FA required).\nOpen the dashboard to approve or reject proposals.');
        break;

      case '/cancel': {
        try {
          const { getDb } = await import('../../db/index.js');
          const db = getDb();
          if (arg) {
            // Cancel specific proposal
            db.prepare("UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by user' WHERE id = ? AND status = 'proposed'").run(arg);
            await this.sendMessage(chatId, `🚫 Proposal ${arg.slice(-8)} cancelled.`);
          } else {
            // Cancel all pending
            const result = db.prepare("UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by user' WHERE status = 'proposed'").run();
            await this.sendMessage(chatId, `🚫 ${result.changes} pending proposal(s) cancelled.`);
          }
        } catch (e) {
          await this.sendMessage(chatId, `⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }

      case '/proposals': {
        try {
          const { getDb } = await import('../../db/index.js');
          const db = getDb();
          const pending = db.prepare(
            "SELECT id, context_summary, plan, created_at FROM proposals WHERE status = 'proposed' ORDER BY created_at DESC LIMIT 10"
          ).all() as Array<{ id: string; context_summary: string; plan: string; created_at: number }>;

          if (pending.length === 0) {
            await this.sendMessage(chatId, '✅ No pending proposals.');
          } else {
            const list = pending.map(p =>
              `📋 \`${p.id}\`\n${p.plan}\n🔒 Approve in web app`
            ).join('\n\n');
            await this.sendMessage(chatId, `📋 Pending proposals (${pending.length}):\n\n${list}\n\n🔒 Open the web app to approve/reject.`);
          }
        } catch (e) {
          await this.sendMessage(chatId, `⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }

      case '/help':
        await this.sendMessage(chatId,
          '🔭 Argos commands:\n\n' +
          '/status — system info\n' +
          '/proposals — pending approvals\n' +
          '/cancel — cancel all pending proposals\n' +
          '/cancel <id> — cancel a specific proposal\n' +
          '/clear — reset conversation history\n' +
          '/help — this message\n\n' +
          '🔒 Approvals: web app only (2FA required)\n\n' +
          'Or just send me any message to chat.',
        );
        break;

      default:
        await this.sendMessage(chatId, `Unknown command: ${cmd}\nType /help for available commands.`);
    }
  }

  private getUserMdPath(): string {
    const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
    return path.join(dataDir.startsWith('~') ? path.join(os.homedir(), dataDir.slice(1)) : dataDir, 'user.md');
  }

  private loadUserMd(): string | null {
    try {
      return fs.readFileSync(this.getUserMdPath(), 'utf8');
    } catch {
      return null;
    }
  }

  private isFirstInteraction(): boolean {
    return !fs.existsSync(this.getUserMdPath());
  }

  private async loadConversation(userId: string): Promise<CompactableHistory> {
    const cached = this.conversations.get(userId);
    if (cached) return cached;

    try {
      const { getDb } = await import('../../db/index.js');
      const db = getDb();
      const row = db.prepare('SELECT messages, compacted_summary FROM conversations WHERE user_id = ?').get(userId) as
        { messages: string; compacted_summary: string | null } | undefined;
      if (row) {
        const conv: CompactableHistory = {
          messages: JSON.parse(row.messages),
          compactedSummary: row.compacted_summary ?? undefined,
        };
        this.conversations.set(userId, conv);
        log.debug(`Loaded conversation for ${userId}: ${conv.messages.length} messages`);
        return conv;
      }
    } catch { /* DB not ready */ }

    const fresh: CompactableHistory = { messages: [] };
    this.conversations.set(userId, fresh);
    return fresh;
  }

  private async saveConversation(userId: string, conv: CompactableHistory): Promise<void> {
    this.conversations.set(userId, conv);
    try {
      const { getDb } = await import('../../db/index.js');
      const db = getDb();
      db.prepare(`
        INSERT INTO conversations (user_id, messages, compacted_summary, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET messages = ?, compacted_summary = ?, updated_at = ?
      `).run(
        userId, JSON.stringify(conv.messages), conv.compactedSummary ?? null, Date.now(),
        JSON.stringify(conv.messages), conv.compactedSummary ?? null, Date.now(),
      );
    } catch (e) {
      log.debug(`Failed to save conversation: ${e}`);
    }
  }

  private async defaultHandler(userId: string, text: string): Promise<string> {
    // Load conversation (from memory cache or DB)
    let conv = await this.loadConversation(userId);

    // Add user message
    conv.messages.push({ role: 'user', content: text });

    // Compact if needed (summarize old messages)
    const { needsCompaction, compactHistory, buildMessagesWithCompaction } = await import('../../llm/compaction.js');
    const { llmCall } = await import('../../llm/index.js');

    if (needsCompaction(conv)) {
      conv = await compactHistory(conv, this.llmConfig, llmCall);
      await this.saveConversation(userId, conv);
      log.info(`Conversation compacted for user ${userId}`);
    }

    // Build system prompt
    let systemPrompt: string;
    if (this.argosConfig) {
      const { buildSystemPrompt } = await import('../../prompts/index.js');
      systemPrompt = buildSystemPrompt('chat', this.argosConfig);
    } else {
      systemPrompt = `You are Argos, a personal AI assistant built with security and privacy as top priorities. Current time: ${new Date().toISOString()}`;
    }

    // Load user.md
    const userMd = this.loadUserMd();
    if (userMd) {
      systemPrompt += `\n\n---\n## User profile:\n${userMd}`;
    }

    // First interaction — onboarding
    if (this.isFirstInteraction()) {
      systemPrompt += `\n\n---\n## ONBOARDING MODE (first interaction)
You are meeting this user for the first time. You MUST:
1. Introduce yourself: "I'm Argos, your personal AI assistant. Security and privacy are my core values — everything stays local, nothing leaves without your approval."
2. Ask: What should I call you? What's your role? What language? What do you expect from me?
3. Be warm, conversational. Reply in the user's language.
4. When you have enough info, output a block wrapped in \`\`\`user.md fences (markdown with YAML frontmatter: name, role, language, preferences).
5. Tell the user you saved their profile.`;
    }

    // Fetch context sources (docs, GitHub, Notion — always included)
    let contextDocs = '';
    try {
      const { getDb } = await import('../../db/index.js');
      const db = getDb();
      const docs = db.prepare(
        "SELECT content FROM memories WHERE category = 'context' AND archived = 1 ORDER BY importance DESC LIMIT 5"
      ).all() as Array<{ content: string }>;
      if (docs.length > 0) {
        // Truncate to avoid exceeding token limits
        const maxChars = 6000;
        let total = 0;
        const truncated = docs.filter(d => {
          if (total > maxChars) return false;
          total += d.content.length;
          return true;
        });
        contextDocs = '\n\n---\n## Reference documentation:\n' +
          truncated.map(d => d.content.slice(0, 2000)).join('\n\n---\n');
      }
    } catch { /* db not ready */ }

    // Fetch relevant memories (past conversations, facts)
    let memoryContext = '';
    try {
      const { search } = await import('../../memory/store.js');
      const memories = search({ query: text, limit: 5 });
      // Filter out context docs (already included above)
      const nonContext = memories.filter(m => String(m.category) !== 'context');
      if (nonContext.length > 0) {
        memoryContext = '\n\n---\n## Relevant memories:\n' +
          nonContext.map(m => `- [${m.category}] ${m.content}`).join('\n');
      }
    } catch { /* memory not initialized */ }

    // Build messages with compaction context + docs
    const messages = buildMessagesWithCompaction(systemPrompt, conv, contextDocs + memoryContext);

    // Call LLM with tool loop (builtin tools + MCP tools)
    const { BUILTIN_TOOLS, executeBuiltinTool } = await import('../../llm/builtin-tools.js');
    const { runToolLoop } = await import('../../llm/tool-loop.js');
    const { callAnthropicBearerRaw } = await import('../../llm/index.js');
    const { getMcpTools, executeMcpToolSafe } = await import('../../mcp/client.js');

    // Merge builtin + MCP tools — MCP writes go through proposal (safe mode)
    const allTools = [...BUILTIN_TOOLS, ...getMcpTools()];
    const combinedExecutor = async (name: string, input: Record<string, unknown>) => {
      if (name.startsWith('mcp_')) return executeMcpToolSafe(name, input);
      return executeBuiltinTool(name, input);
    };

    // Status message — one message that updates in place
    const chatId = this.lastChatId!;
    let statusMsgId: number | null = null;

    const updateStatus = async (text: string) => {
      try {
        if (statusMsgId) {
          await this.api('deleteMessage', { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
        }
        const sent = await this.api('sendMessage', {
          chat_id: chatId,
          text: `⏳ ${text}`,
          parse_mode: 'Markdown',
        }) as { result: { message_id: number } };
        statusMsgId = sent.result.message_id;
      } catch { /* non-blocking */ }
    };

    const toolEmoji: Record<string, string> = {
      web_search: '🔍', fetch_url: '🌐', memory_search: '🧠', memory_store: '💾',
      read_file: '📄', write_file: '✏️', current_time: '🕐',
    };

    let response: { content: string };
    if (this.llmConfig.authMode === 'bearer') {
      response = await runToolLoop(
        this.llmConfig, systemPrompt, messages,
        allTools, combinedExecutor, callAnthropicBearerRaw,
        async (event) => {
          if (event.type === 'tool_call') {
            const emoji = toolEmoji[event.name] ?? '🔧';
            await updateStatus(`${emoji} Using *${event.name}*…`);
          } else if (event.type === 'tool_result' && event.error) {
            await updateStatus(`⚠️ ${event.name} failed`);
          }
        },
      );
    } else {
      response = await llmCall(this.llmConfig, messages);
    }

    // Delete status message before sending final response
    if (statusMsgId) {
      await this.api('deleteMessage', { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
    }

    // Auto-save user.md if present in response
    const userMdMatch = response.content.match(/```user\.md\n([\s\S]*?)```/);
    if (userMdMatch) {
      const mdPath = this.getUserMdPath();
      fs.mkdirSync(path.dirname(mdPath), { recursive: true });
      fs.writeFileSync(mdPath, userMdMatch[1].trim(), 'utf8');
      log.info(`User profile saved to ${mdPath}`);
    }

    // Save important info to memory automatically
    try {
      await this.autoMemorize(userId, text, response.content);
    } catch { /* non-blocking */ }

    // Guard against empty responses
    const finalContent = response.content?.trim() || '(No response generated — try again)';

    // Add assistant response to history + persist
    conv.messages.push({ role: 'assistant', content: finalContent });
    await this.saveConversation(userId, conv);

    return finalContent;
  }

  /**
   * Auto-memorize important facts from conversations.
   * Runs a quick classification on the exchange to decide if it's worth remembering.
   */
  private async autoMemorize(userId: string, userMsg: string, assistantMsg: string): Promise<void> {
    // Skip short exchanges
    if (userMsg.length < 20) return;

    try {
      const { store } = await import('../../memory/store.js');
      const { llmCall } = await import('../../llm/index.js');

      // Quick check: is this worth memorizing?
      const check = await llmCall(this.llmConfig, [
        { role: 'system', content: `You decide if a conversation exchange contains information worth remembering long-term.
Output ONLY a JSON object: { "memorize": true/false, "summary": "one-line summary if true", "category": "preference|fact|task|decision|context" }
Only memorize: user preferences, important facts, decisions made, task outcomes. NOT: greetings, small talk, questions without answers.` },
        { role: 'user', content: `User said: "${userMsg.slice(0, 500)}"\nAssistant replied: "${assistantMsg.slice(0, 500)}"` },
      ]);

      const parsed = JSON.parse(check.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      if (parsed.memorize && parsed.summary) {
        const { storeQuick } = await import('../../memory/store.js');
        storeQuick(parsed.summary, parsed.category ?? 'general', [`user:${userId}`]);
        log.debug(`Auto-memorized: ${parsed.summary}`);
      }
    } catch { /* non-critical */ }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    // Telegram max message length is 4096
    const chunks = this.splitMessage(text, 4096);
    for (const chunk of chunks) {
      await this.api('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'Markdown',
      }).catch(async () => {
        // Retry without markdown if parsing fails
        await this.api('sendMessage', { chat_id: chatId, text: chunk });
      });
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Try to split at newline
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt < maxLen / 2) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }

  private async api(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(POLL_TIMEOUT * 1000 + 10_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Telegram API ${method}: ${res.status} — ${text.slice(0, 200)}`);
    }
    return res.json();
  }
}

// Types
interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string };
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
    date: number;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
  };
}
