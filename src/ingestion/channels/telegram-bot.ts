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
import type { LLMConfig } from '../../llm/index.js';
import type {} from '../../llm/index.js'; // types only — llmCall imported dynamically
import type { Config } from '../../config/schema.js';
import type { CompactableHistory } from '../../llm/compaction.js';
import type { TelegramChannel } from './telegram.js';
import {
  cmdProposals,
  cmdTasks,
  cmdDone,
  cmdDoneShortcut,
  cmdCancel,
} from './telegram-bot-commands.js';

const log = createLogger('telegram-bot');

const POLL_TIMEOUT = 30; // seconds (Telegram long-poll)

export interface TelegramBotOptions {
  token: string;
  allowedUsers: string[]; // Telegram user IDs allowed to interact
  llmConfig: LLMConfig;
  config?: Config; // Full Argos config — used to build system prompt
  onMessage?: (userId: string, text: string) => Promise<string>;
  mtprotoChannel?: TelegramChannel; // MTProto user client — needed for /add_chat dialog listing
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
  private static readonly MAX_CONVERSATIONS = 100;
  private lastChatId: string | null = null;
  private pendingConfirmation: Map<string, string> = new Map();
  // Per-user sequential queue — prevents parallel LLM calls for the same user
  private processingQueue: Map<string, Promise<void>> = new Map();
  // Per-user abort controllers — allows /stop to cancel an ongoing tool loop
  private abortControllers: Map<string, AbortController> = new Map();
  // Per-user active loop flag — enables non-blocking interrupt injection
  private activeLoops: Set<string> = new Set();
  // Messages received mid-tool-loop — injected at next tool boundary
  private interruptMessages: Map<string, string[]> = new Map();
  private approvalChatIdSaved = false;
  private mtprotoChannel: TelegramChannel | undefined;
  // Rate limiting — sliding window per user (timestamps in ms)
  private rateLimitTimestamps: Map<string, number[]> = new Map();
  private rateLimitNotified: Map<string, number> = new Map();
  private static readonly RATE_LIMIT_PER_MINUTE = 10;
  private static readonly RATE_LIMIT_PER_HOUR = 50;
  private static readonly RATE_LIMIT_NOTIFY_COOLDOWN_MS = 60_000;

  constructor(options: TelegramBotOptions) {
    this.token = options.token;
    this.allowedUsers = new Set(options.allowedUsers);
    this.llmConfig = options.llmConfig;
    this.argosConfig = options.config;
    this.onMessage = options.onMessage ?? this.defaultHandler.bind(this);
    this.mtprotoChannel = options.mtprotoChannel;
  }

  private get baseUrl(): string {
    return `https://api.telegram.org/bot${this.token}`;
  }

  async start(): Promise<void> {
    this.running = true;
    log.info('Telegram Bot started — polling for messages');

    // Force-claim exclusive polling: delete any webhook and drop stale getUpdates sessions.
    // This stops any other instance that might be polling with the same bot token.
    try {
      await this.api('deleteWebhook', { drop_pending_updates: false });
      log.info('Webhook cleared — exclusive polling claimed');
    } catch (e) {
      log.warn(`deleteWebhook failed (non-fatal): ${(e as Error)?.message}`);
    }

    // Drain and DISCARD all pending updates accumulated while offline.
    // Without this, old messages from other users would trigger LLM calls at boot.
    try {
      let drained = false;
      while (!drained) {
        const res = (await this.api('getUpdates', {
          offset: this.offset,
          limit: 100,
          timeout: 0,
        })) as { result: Array<{ update_id: number }> };
        if (!res.result || res.result.length === 0) {
          drained = true;
        } else {
          const last = res.result[res.result.length - 1];
          this.offset = last.update_id + 1;
        }
      }
      log.info(`Telegram Bot: discarded stale updates, starting fresh from offset ${this.offset}`);
    } catch {
      /* non-fatal */
    }

    // Register commands so Telegram shows them when user types /
    this.api('setMyCommands', {
      commands: [
        { command: 'status', description: 'État du système' },
        { command: 'proposals', description: 'Propositions en attente' },
        { command: 'add_chat', description: 'Lister les chats à surveiller' },
        { command: 'chats', description: 'Chats surveillés' },
        { command: 'remove_chat', description: 'Arrêter de surveiller un chat' },
        { command: 'triage', description: 'Config triage (on/off, mention-only, ignore-own)' },
        { command: 'teams', description: 'Lister les équipes' },
        { command: 'add_team', description: 'Créer une équipe' },
        { command: 'team', description: "Détails d'une équipe" },
        { command: 'team_own', description: 'Marquer équipe interne/externe' },
        { command: 'add_handle', description: 'Ajouter un handle à une équipe' },
        { command: 'add_keyword', description: 'Ajouter un keyword à une équipe' },
        { command: 'my_handles', description: 'Mes pseudos personnels' },
        { command: 'add_my_handle', description: 'Ajouter un pseudo personnel' },
        { command: 'whitelist', description: 'Keywords whitelist TX' },
        { command: 'add_whitelist', description: 'Ajouter keyword whitelist TX' },
        { command: 'stop', description: 'Stopper la tâche en cours' },
        { command: 'rerun', description: 'Relancer le dernier script (optionnel: script corrigé)' },
        { command: 'cancel', description: 'Annuler les propositions' },
        { command: 'compact', description: "Compresser l'historique" },
        { command: 'clear', description: 'Réinitialiser la conversation' },
        { command: 'help', description: 'Toutes les commandes' },
      ],
    }).catch(() => {
      /* non-blocking */
    });

    this.poll();
  }

  stop(): void {
    this.running = false;
    log.info('Telegram Bot stopped');
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const data = (await this.api('getUpdates', {
          offset: this.offset,
          timeout: POLL_TIMEOUT,
          allowed_updates: ['message', 'callback_query'],
        })) as { result: TgUpdate[] };

        for (const update of data.result) {
          this.offset = update.update_id + 1;
          if (update.callback_query) {
            void this.handleCallbackQuery(update.callback_query).catch((e) =>
              log.error(`Callback error: ${e}`),
            );
          } else {
            this.handleUpdate(update); // non-blocking — processingQueue handles per-user ordering
          }
        }
      } catch (e) {
        // AbortError = long-poll timeout — normal, just retry immediately
        if ((e as Error)?.name === 'AbortError' || (e as Error)?.name === 'TimeoutError') continue;
        log.error(`Polling error: ${(e as Error)?.message ?? String(e)}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private handleUpdate(update: TgUpdate): void {
    const msg = update.message;
    if (!msg?.from) return;

    const userId = String(msg.from.id);
    const chatId = String(msg.chat.id);
    const text = (msg.text ?? '').trim();

    // If a tool loop is active and this is plain text (not a command), inject as interrupt.
    // Commands (/stop, etc.) still go through the queue so abort/reply logic works.
    if (this.activeLoops.has(userId) && text && !text.startsWith('/')) {
      const queue = this.interruptMessages.get(userId) ?? [];
      queue.push(text);
      this.interruptMessages.set(userId, queue);
      void this.sendMessage(chatId, "💬 Reçu — j'en tiendrai compte à la prochaine étape.");
      return;
    }

    // Serialize per-user to avoid parallel LLM calls (processingQueue handles ordering)
    const prev = this.processingQueue.get(userId) ?? Promise.resolve();
    const next = prev
      .then(() => this._handleUpdateInner(update))
      .catch((e) => {
        log.error(
          `Unhandled queue error for user ${userId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      })
      .finally(() => {
        if (this.processingQueue.get(userId) === next) this.processingQueue.delete(userId);
      });
    this.processingQueue.set(userId, next);
    // Returns immediately — polling loop stays non-blocking
  }

  /** Sliding-window rate limit check. Returns false if user exceeded limits. */
  private checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const HOUR = 3_600_000;
    const MINUTE = 60_000;
    const arr = this.rateLimitTimestamps.get(userId) ?? [];
    // Drop entries older than 1h
    const recent = arr.filter((t) => now - t < HOUR);
    const lastMinute = recent.filter((t) => now - t < MINUTE).length;
    if (lastMinute >= TelegramBot.RATE_LIMIT_PER_MINUTE) {
      this.rateLimitTimestamps.set(userId, recent);
      return false;
    }
    if (recent.length >= TelegramBot.RATE_LIMIT_PER_HOUR) {
      this.rateLimitTimestamps.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.rateLimitTimestamps.set(userId, recent);
    // Periodic cleanup — drop empty/stale user entries (cheap, runs ~1/100 calls)
    if (Math.random() < 0.01) {
      for (const [uid, times] of this.rateLimitTimestamps) {
        const kept = times.filter((t) => now - t < HOUR);
        if (kept.length === 0) this.rateLimitTimestamps.delete(uid);
        else this.rateLimitTimestamps.set(uid, kept);
      }
      for (const [uid, t] of this.rateLimitNotified) {
        if (now - t > HOUR) this.rateLimitNotified.delete(uid);
      }
    }
    return true;
  }

  private async _handleUpdateInner(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.from) return;

    const userId = String(msg.from.id);
    const chatId = String(msg.chat.id);

    // Security: auth check first — before any processing including file uploads
    // If allowedUsers is empty, deny everyone (fail-closed — avoids open bot)
    if (this.allowedUsers.size === 0 || !this.allowedUsers.has(userId)) {
      log.warn(`Ignoring message from unauthorized user ${userId}`);
      return;
    }

    // Rate limiting — protect against credit-burning spam
    if (!this.checkRateLimit(userId)) {
      const now = Date.now();
      const lastNotified = this.rateLimitNotified.get(userId) ?? 0;
      if (now - lastNotified > TelegramBot.RATE_LIMIT_NOTIFY_COOLDOWN_MS) {
        this.rateLimitNotified.set(userId, now);
        await this.sendMessage(
          chatId,
          `⏳ Doucement ! Limite atteinte (${TelegramBot.RATE_LIMIT_PER_MINUTE}/min, ${TelegramBot.RATE_LIMIT_PER_HOUR}/h). Réessaie dans un instant.`,
        );
      }
      log.warn(`Rate limit hit for user ${userId} — message dropped`);
      return;
    }

    // Set lastChatId early — needed by defaultHandler for streaming/status msgs
    this.lastChatId = chatId;

    // Handle file uploads (documents, photos)
    if (msg.document || msg.photo) {
      await this.handleFileUpload(msg, userId, chatId);
      return;
    }

    // Handle voice messages — transcribe via Whisper, optionally reply with TTS
    if (msg.voice && this.argosConfig?.voice?.enabled) {
      const voice = msg.voice as { file_id: string; duration: number };
      try {
        // 1. Get file path from Telegram
        const fileInfo = (await this.api('getFile', { file_id: voice.file_id })) as {
          result: { file_path: string };
        };
        const filePath = fileInfo.result.file_path;

        // 2. Download audio (never persisted beyond this scope)
        const fileRes = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
        const buffer = Buffer.from(await fileRes.arrayBuffer());

        // 3. Transcribe
        const { transcribeAudio } = await import('../../voice/transcribe.js');
        const transcript = await transcribeAudio(buffer, 'voice.ogg', this.argosConfig.voice);
        log.info(`Voice transcribed (bot): ${transcript.slice(0, 80)}`);

        // 4. Send typing indicator then process as text
        const typingInterval = setInterval(() => {
          this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
        }, 4000);
        this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

        let reply: string;
        try {
          reply = await this.onMessage(userId, transcript);
          clearInterval(typingInterval);
        } catch (e) {
          clearInterval(typingInterval);
          throw e;
        }

        // 5. Reply with voice note if TTS enabled, otherwise text
        if (this.argosConfig.voice.ttsEnabled && reply) {
          try {
            const { synthesizeSpeech } = await import('../../voice/synthesize.js');
            const ttsConfig = {
              ttsProvider: this.argosConfig.voice.ttsProvider,
              openAiTtsApiKey: this.argosConfig.voice.openAiTtsApiKey,
              openAiTtsModel: this.argosConfig.voice.openAiTtsModel,
              openAiTtsVoice: this.argosConfig.voice.openAiTtsVoice,
              elevenLabsApiKey: this.argosConfig.voice.elevenLabsApiKey,
              elevenLabsVoiceId: this.argosConfig.voice.elevenLabsVoiceId,
            };
            const audioBytes = await synthesizeSpeech(reply, ttsConfig);

            // Send as voice note via multipart/form-data
            const formData = new globalThis.FormData();
            formData.append('chat_id', chatId);
            formData.append('voice', new Blob([audioBytes], { type: 'audio/mpeg' }), 'reply.mp3');
            await fetch(`https://api.telegram.org/bot${this.token}/sendVoice`, {
              method: 'POST',
              body: formData,
            });
          } catch (e) {
            log.warn(`TTS failed, falling back to text reply: ${(e as Error).message}`);
            if (reply) await this.sendMessage(chatId, reply);
          }
        } else if (reply) {
          await this.sendMessage(chatId, reply);
        }
      } catch (e) {
        log.warn(`Voice handling failed: ${(e as Error).message}`);
        await this.sendMessage(
          chatId,
          '⚠️ Could not process voice message. Is whisperApiKey configured?',
        );
      }
      return; // handled
    }

    if (!msg.text) return;
    const text = msg.text.trim();

    // Auto-save approvalChatId on first message (so notifications work)
    if (!this.approvalChatIdSaved) {
      this.approvalChatIdSaved = true;
      try {
        const cfgPath = path.join(os.homedir(), '.argos', '.config.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (!cfg.telegram?.approvalChatId || cfg.telegram.approvalChatId === 'me') {
          cfg.telegram = cfg.telegram ?? {};
          cfg.telegram.approvalChatId = chatId;
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
          log.info(`Auto-saved approvalChatId: ${chatId}`);
        }
      } catch {
        /* non-blocking */
      }
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
      log.warn(
        `🛡️ Auto-redacted ${guard.redactedItems.length} item(s): ${guard.redactedItems.join(', ')}`,
      );
      await this.sendMessage(
        chatId,
        `🛡️ Données sensibles détectées et masquées automatiquement:\n${guard.redactedItems.map((i) => `• ${i}`).join('\n')}`,
      );
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
      // Empty string means the handler already sent the reply (streaming mode)
      if (response) await this.sendMessage(chatId, response);
    } catch (e) {
      clearInterval(typingInterval);
      const errMsg = e instanceof Error ? e.message : JSON.stringify(e);
      if (errMsg === 'CANCELLED') {
        log.info(`Tool loop cancelled by user ${userId}`);
        await this.sendMessage(chatId, '⏹️ Arrêté.');
        return;
      }
      log.error(`Error handling message: ${errMsg}`);
      if (e instanceof Error && e.stack) log.error(e.stack);
      const isRateLimit = errMsg.includes('429') || errMsg.includes('rate_limit');
      const userMsg = isRateLimit
        ? '⏳ Rate limit reached — please wait a few seconds and try again.'
        : `⚠️ Error: ${errMsg.slice(0, 200)}`;
      await this.sendMessage(chatId, userMsg);
    }
  }

  private async handleFileUpload(
    msg: NonNullable<TgUpdate['message']>,
    userId: string,
    chatId: string,
  ): Promise<void> {
    if (this.allowedUsers.size === 0 || !this.allowedUsers.has(userId)) return;

    const fileId = msg.document?.file_id ?? msg.photo?.[msg.photo.length - 1]?.file_id;
    const fileName = msg.document?.file_name ?? 'photo.jpg';
    const caption = msg.caption ?? '';

    if (!fileId) return;

    this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    try {
      // Get file path from Telegram
      const fileInfo = (await this.api('getFile', { file_id: fileId })) as {
        result: { file_path: string };
      };
      const fileUrl = `https://api.telegram.org/file/bot${this.token}/${fileInfo.result.file_path}`;

      // Download file
      const res = await fetch(fileUrl);
      const buffer = Buffer.from(await res.arrayBuffer());

      const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
      const resolvedDir = dataDir.startsWith('~')
        ? path.join(os.homedir(), dataDir.slice(1))
        : dataDir;
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');

      // Caption "/train" → style training from file content
      if (/^\/train\b/i.test(caption.trim())) {
        let fileContent = '';
        try { fileContent = buffer.toString('utf8'); } catch { /* binary file */ }
        if (fileContent.length > 50) {
          // Reuse the /train command handler
          const fakeText = `/train ${fileContent}`;
          await this.handleCommand(chatId, userId, fakeText);
        } else {
          await this.sendMessage(chatId, '⚠️ File too short or not text — need at least 50 chars of conversation sample.');
        }
        return;
      }

      // Caption "knowledge" (or starts with /knowledge) → save to ~/.argos/knowledge/
      const isKnowledge = /^\/?(knowledge|ref|reference)\b/i.test(caption.trim());

      let filePath: string;
      let savedTo: string;
      if (isKnowledge) {
        const knowledgeDir = path.join(resolvedDir, 'knowledge');
        fs.mkdirSync(knowledgeDir, { recursive: true });
        filePath = path.join(knowledgeDir, safeName);
        savedTo = `knowledge/${safeName}`;
      } else {
        const contextDir = path.join(resolvedDir, 'context', 'uploads');
        fs.mkdirSync(contextDir, { recursive: true });
        filePath = path.join(contextDir, `${Date.now()}_${safeName}`);
        savedTo = `context/uploads/${Date.now()}_${safeName}`;
      }

      fs.writeFileSync(filePath, buffer);
      log.info(
        `File saved: ${filePath} (${buffer.length} bytes)${isKnowledge ? ' [knowledge]' : ''}`,
      );

      // If it's a text-based file, read and process it
      const ext = path.extname(fileName).toLowerCase();
      const textExts = [
        '.txt',
        '.md',
        '.json',
        '.csv',
        '.xml',
        '.html',
        '.yml',
        '.yaml',
        '.toml',
        '.log',
        '.py',
        '.js',
        '.ts',
      ];
      const isText = textExts.includes(ext) || msg.document?.mime_type?.startsWith('text/');

      if (isKnowledge) {
        // Knowledge files: confirm save, auto-index if embeddings enabled
        let indexMsg = '';
        if (isText) {
          try {
            const { chunkText, indexChunks } = await import('../../vector/store.js');
            const { getEmbeddingsConfig } = await import('../../config/index.js');
            const embCfg = getEmbeddingsConfig();
            if (embCfg) {
              const content = buffer.toString('utf8');
              const sourceRef = `knowledge:${safeName}`;
              const chunks = chunkText(content, sourceRef, safeName);
              await indexChunks(chunks, embCfg);
              indexMsg = ` + indexed ${chunks.length} chunks for semantic search`;
            }
          } catch (e) {
            log.warn(`Failed to index knowledge file: ${e}`);
          }
        }
        await this.sendMessage(
          chatId,
          `📚 Saved to knowledge base: \`${savedTo}\`${indexMsg}\n` +
            `Use \`read_file(path="${savedTo}", search="<keyword>")\` for exact lookups.`,
        );
        return;
      }

      // Photo upload — pass as multimodal LLMMessage directly (cap at 5MB)
      if (msg.photo && buffer.length < 5 * 1024 * 1024) {
        const { llmCall: _llmCall } = await import('../../llm/index.js');
        const imageData = buffer.toString('base64');
        const textPrompt = caption
          ? `The user sent a photo with caption: "${caption}". Describe what you see and answer their question.`
          : 'The user sent a photo. Describe what you see and respond helpfully.';

        // Build multimodal message and inject into conversation, then call LLM directly
        let conv = await this.loadConversation(userId);
        const { buildMessagesWithCompaction, needsCompaction, compactHistory } =
          await import('../../llm/compaction.js');

        // Add multimodal user turn to conversation history as text-only summary (for history)
        conv.messages.push({ role: 'user', content: caption ? `[Photo] ${caption}` : '[Photo]' });

        if (needsCompaction(conv)) {
          conv = await compactHistory(conv, this.llmConfig, _llmCall);
          await this.saveConversation(userId, conv);
        }

        let systemPrompt = `You are Argos, a personal AI assistant. Current time: ${new Date().toISOString()}`;
        if (this.argosConfig) {
          const { buildSystemPrompt } = await import('../../prompts/index.js');
          systemPrompt = buildSystemPrompt('chat', this.argosConfig);
        }

        // Build history messages then replace last user message with multimodal version
        const historyMessages = buildMessagesWithCompaction(systemPrompt, conv, '');
        // Override the last user message with multimodal content
        const multimodalMessages = historyMessages.map((m, i) => {
          if (i === historyMessages.length - 1 && m.role === 'user') {
            return {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: textPrompt },
                {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: 'image/jpeg' as const,
                    data: imageData,
                  },
                },
              ],
            };
          }
          return m;
        });

        const imgResponse = await _llmCall(this.llmConfig, multimodalMessages);
        const finalContent = imgResponse.content?.trim() || '(No response generated)';

        conv.messages.push({ role: 'assistant', content: finalContent });
        await this.saveConversation(userId, conv);
        await this.sendMessage(chatId, finalContent);
        return;
      }

      // PDF — pass as native document block to Anthropic (Claude reads PDFs natively)
      const isPdf = ext === '.pdf' || msg.document?.mime_type === 'application/pdf';
      if (isPdf && buffer.length < 20 * 1024 * 1024) {
        const { llmCall: _llmCall } = await import('../../llm/index.js');
        const pdfData = buffer.toString('base64');
        const textPrompt = caption
          ? `The user sent a PDF: "${fileName}" with note: "${caption}". Read and analyze it.`
          : `The user sent a PDF: "${fileName}". Read it and give a useful summary or answer any question about it.`;

        let conv = await this.loadConversation(userId);
        const { buildMessagesWithCompaction, needsCompaction, compactHistory } =
          await import('../../llm/compaction.js');
        conv.messages.push({
          role: 'user',
          content: caption ? `[PDF: ${fileName}] ${caption}` : `[PDF: ${fileName}]`,
        });
        if (needsCompaction(conv)) {
          conv = await compactHistory(conv, this.llmConfig, _llmCall);
          await this.saveConversation(userId, conv);
        }

        let systemPrompt = `You are Argos, a personal AI assistant. Current time: ${new Date().toISOString()}`;
        if (this.argosConfig) {
          const { buildSystemPrompt } = await import('../../prompts/index.js');
          systemPrompt = buildSystemPrompt('chat', this.argosConfig);
        }

        const historyMessages = buildMessagesWithCompaction(systemPrompt, conv, '');
        const pdfMessages = historyMessages.map((m, i) => {
          if (i === historyMessages.length - 1 && m.role === 'user') {
            return {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: textPrompt },
                {
                  type: 'document' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: 'application/pdf' as const,
                    data: pdfData,
                  },
                },
              ],
            };
          }
          return m;
        });

        const pdfResponse = await _llmCall(
          this.llmConfig,
          pdfMessages as Parameters<typeof _llmCall>[1],
        );
        const pdfContent = pdfResponse.content?.trim() || '(Impossible de lire le PDF)';
        conv.messages.push({ role: 'assistant', content: pdfContent });
        await this.saveConversation(userId, conv);
        await this.sendMessage(chatId, pdfContent);
        return;
      }

      // Regular upload: send to LLM for analysis
      let fileContent = '';
      if (isText) {
        fileContent = buffer.toString('utf8').slice(0, 10000);
      }

      const prompt = fileContent
        ? `The user sent a file: "${fileName}"\n${caption ? `Caption: "${caption}"\n` : ''}Content:\n\`\`\`\n${fileContent}\n\`\`\`\n\nAnalyze this file and respond helpfully. If it looks like a reference file (addresses, configs, deployments), suggest saving it to the knowledge base by resending with caption "knowledge".`
        : `The user sent a file: "${fileName}" (${buffer.length} bytes, type: ${msg.document?.mime_type ?? 'image'})\n${caption ? `Caption: "${caption}"\n` : ''}The file has been saved. Acknowledge receipt and ask if they need anything specific with it.`;

      const response = await this.onMessage(userId, prompt);
      const safeResponse = response?.trim() || 'Fichier reçu et sauvegardé.';
      await this.sendMessage(chatId, safeResponse);
    } catch (e) {
      log.error(`File upload error: ${e}`);
      await this.sendMessage(
        chatId,
        `⚠️ Error processing file: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async handleCallbackQuery(cb: TgCallbackQuery): Promise<void> {
    const chatId = String(cb.message?.chat.id ?? '');
    const userId = String(cb.from.id);

    // Auth check
    if (this.allowedUsers.size === 0 || !this.allowedUsers.has(userId)) return;

    // Always answer the callback to remove the loading spinner
    this.api('answerCallbackQuery', { callback_query_id: cb.id }).catch((e: unknown) => {
      log.warn('answerCallbackQuery failed — Telegram spinner may persist', e);
    });

    const data = cb.data ?? '';

    // add_chat:<chatId>
    if (data.startsWith('add_chat:')) {
      const rawChatId = data.slice('add_chat:'.length);
      // Look up name + isGroup from the MTProto dialogCache
      const cached = this.mtprotoChannel?.dialogCache.find((d) => d.chatId === rawChatId);
      const name = cached?.name ?? rawChatId;
      const isGroup = cached?.isGroup ?? rawChatId.startsWith('-');

      const { addMonitoredChat } = await import('../../config/index.js');
      const config = (await import('../../config/index.js')).getConfig();
      const already = config.channels.telegram.listener.monitoredChats.some(
        (c) => c.chatId === rawChatId,
      );
      if (already) {
        await this.api('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: `${name} déjà surveillé`,
          show_alert: false,
        });
        return;
      }
      addMonitoredChat(rawChatId, name, isGroup);
      // Edit the clicked button to show ✅
      await this.api('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: cb.message?.message_id,
        reply_markup: { inline_keyboard: [[{ text: `✅ ${name}`, callback_data: 'noop' }]] },
      }).catch(() => {});
      await this.sendMessage(chatId, `✅ *${name}* ajouté aux chats surveillés\n\`${rawChatId}\``);
      return;
    }

    if (data === 'noop') return;

    // approve:<proposalId> / reject:<proposalId> — inline button callbacks
    if (
      data.startsWith('approve:') ||
      data.startsWith('reject:') ||
      data.startsWith('snooze:') ||
      data.startsWith('details:')
    ) {
      const { handleCallback } = await import('../../gateway/approval.js');
      const { executeProposal } = await import('../../workers/index.js');
      const { getConfig } = await import('../../config/index.js');

      const response = await handleCallback(data, cb.id, async (proposal, actions, token) => {
        const config = getConfig();
        const notify = (t: string) => this.sendMessage(chatId, t);
        await executeProposal(proposal, actions, config, notify, token);

        // Proactive follow-up: feed execution result back to LLM so it continues the conversation
        if (data.startsWith('approve:')) {
          const db = (await import('../../db/index.js')).getDb();
          const row = db.prepare('SELECT status FROM proposals WHERE id = ?').get(proposal.id) as
            | { status: string }
            | undefined;
          const wasExecuted = row?.status === 'executed';
          const summary = wasExecuted
            ? `Script/action executed successfully for proposal ${proposal.id.slice(-8)}.`
            : `Proposal ${proposal.id.slice(-8)} execution completed with possible errors.`;
          // Trigger bot to analyze and continue
          void this.injectAndProcess(userId, chatId, summary);
        }
      });

      // Edit the original message to reflect the new status
      if (data.startsWith('approve:') || data.startsWith('reject:')) {
        await this.api('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: cb.message?.message_id,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      }

      await this.sendMessage(chatId, response).catch(() => {});
      return;
    }
  }

  private async handleCommand(chatId: string, userId: string, text: string): Promise<void> {
    // /done_XXXXXX shortcut (Telegram inline command with underscore-separated ID)
    const doneShortcut = text.match(/^\/done_([A-Z0-9]+)(@\S+)?$/i);
    if (doneShortcut) {
      await cmdDoneShortcut(doneShortcut[1], (t) => this.sendMessage(chatId, t));
      return;
    }

    const [cmd, ...args] = text.split(' ');
    const arg = args.join(' ');

    switch (cmd) {
      case '/start':
        await this.sendMessage(
          chatId,
          "👋 Hey! I'm Argos — your AI assistant.\n\n" +
            "Just send me a message and I'll help you.\n\n" +
            'Commands:\n' +
            '/status — system status\n' +
            '/compact — summarize history to save tokens\n' +
            '/clear — reset conversation\n' +
            '/help — all commands',
        );
        break;

      case '/status':
        await this.sendMessage(
          chatId,
          '🔭 Argos is running\n' +
            `Model: ${this.llmConfig.model}\n` +
            `Provider: ${this.llmConfig.provider}`,
        );
        break;

      case '/clear':
        this.conversations.delete(userId);
        await this.sendMessage(chatId, '🧹 Conversation cleared.');
        break;

      case '/compact': {
        const conv = await this.loadConversation(userId);
        const msgCount = conv.messages.length;
        if (msgCount === 0) {
          await this.sendMessage(chatId, '💬 Nothing to compact — conversation is empty.');
          break;
        }
        if (msgCount < 4 && !conv.compactedSummary) {
          await this.sendMessage(
            chatId,
            `💬 Only ${msgCount} message(s) — not worth compacting yet.`,
          );
          break;
        }
        await this.sendMessage(chatId, `🗜 Compacting ${msgCount} messages…`);
        try {
          const { compactHistory } = await import('../../llm/compaction.js');
          const { llmCall } = await import('../../llm/index.js');
          // Force compaction regardless of threshold by temporarily inflating message count
          const forceConv = {
            ...conv,
            messages: [...conv.messages, ...Array(20).fill({ role: 'user', content: '' })],
          };
          const compacted = await compactHistory(forceConv, this.llmConfig, llmCall);
          // Restore real recent messages (strip the padding we added)
          const realRecent = compacted.messages.filter((m) => m.content !== '');
          const result = { compactedSummary: compacted.compactedSummary, messages: realRecent };
          await this.saveConversation(userId, result);
          await this.sendMessage(
            chatId,
            `✅ Compacted ${msgCount} messages → ${realRecent.length} kept verbatim\n` +
              `📝 Summary: ${(result.compactedSummary ?? '').slice(0, 200)}…`,
          );
        } catch (e) {
          await this.sendMessage(
            chatId,
            `⚠️ Compaction failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        break;
      }

      case '/approve':
      case '/reject':
        await this.sendMessage(
          chatId,
          '🔒 Approvals are only available on the web app (2FA required).\nOpen the dashboard to approve or reject proposals.',
        );
        break;

      case '/stop': {
        const ctrl = this.abortControllers.get(userId);
        if (ctrl) {
          ctrl.abort();
          await this.sendMessage(chatId, '⏹️ Annulation en cours…');
        } else {
          await this.sendMessage(chatId, 'Aucune tâche en cours.');
        }
        break;
      }

      case '/rerun': {
        // Re-run the last approved script. Optionally pass a corrected script after the command (multi-line ok).
        const lastScriptPath = path.join(
          process.env.DATA_DIR ?? path.join(os.homedir(), '.argos'),
          'last_script.json',
        );
        try {
          const saved = JSON.parse(fs.readFileSync(lastScriptPath, 'utf8')) as {
            script: string;
            lang: string;
            timeout: number;
          };
          // Everything after /rerun (supports multi-line paste) is the new script
          const newScript = text.slice(cmd.length).trim() || saved.script;
          const lang = saved.lang ?? 'node';
          const timeout = saved.timeout ?? 300;

          await this.sendMessage(chatId, `▶️ Relancement du script (${lang}, ${timeout}s)…`);
          const { runScriptDirect } = await import('../../workers/proposal-executor.js');
          const result = await runScriptDirect(newScript, lang, timeout, (t) =>
            this.sendMessage(chatId, t),
          );

          // Update saved script if user provided a new one
          if (text.slice(cmd.length).trim()) {
            fs.writeFileSync(
              lastScriptPath,
              JSON.stringify({ script: newScript, lang, timeout, ts: Date.now() }),
              'utf8',
            );
          }

          const status = result.success ? '✅ Script terminé' : '❌ Script échoué';
          const finalOutput = result.output.trim().slice(-2000);
          await this.sendMessage(
            chatId,
            finalOutput ? `${status}\n\`\`\`\n${finalOutput}\n\`\`\`` : status,
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            await this.sendMessage(
              chatId,
              "❌ Aucun script récent. Lance d'abord un script via une proposition.",
            );
          } else {
            await this.sendMessage(
              chatId,
              `❌ Erreur: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        break;
      }

      case '/cancel':
        await cmdCancel(arg, (t) => this.sendMessage(chatId, t));
        break;

      case '/proposals':
        await cmdProposals((t) => this.sendMessage(chatId, t));
        break;

      case '/tasks':
        await cmdTasks((t) => this.sendMessage(chatId, t));
        break;

      case '/done':
        await cmdDone(arg, (t) => this.sendMessage(chatId, t));
        break;

      case '/add_chat':
      case '/add-chat': {
        if (!this.mtprotoChannel) {
          await this.sendMessage(
            chatId,
            '❌ Telegram MTProto listener not running — cannot list dialogs.\nConfigure api_id + api_hash in setup.',
          );
          break;
        }
        await this.mtprotoChannel.handleAddChat(
          args,
          (text) => this.sendMessage(chatId, text),
          (text, kb) => this.sendMessageWithKeyboard(chatId, text, kb),
        );
        break;
      }

      case '/chats': {
        if (!this.mtprotoChannel) {
          await this.sendMessage(chatId, '❌ MTProto listener not running.');
          break;
        }
        await this.mtprotoChannel.handleListMonitored((text) => this.sendMessage(chatId, text));
        break;
      }

      case '/remove-chat':
      case '/remove_chat': {
        const targetId = arg;
        if (!targetId) {
          await this.sendMessage(chatId, '❌ Usage: /remove_chat <chatId>');
          break;
        }
        if (!this.mtprotoChannel) {
          await this.sendMessage(chatId, '❌ MTProto listener not running.');
          break;
        }
        await this.mtprotoChannel.handleRemoveChat(targetId, (text) =>
          this.sendMessage(chatId, text),
        );
        break;
      }

      // ── Triage management ────────────────────────────────────────────────────
      case '/triage': {
        const { cmdTriage } = await import('./triage-commands.js');
        await cmdTriage(args, (t) => this.sendMessage(chatId, t));
        break;
      }
      case '/teams': {
        const { cmdTeams } = await import('./triage-commands.js');
        await cmdTeams((t) => this.sendMessage(chatId, t));
        break;
      }
      case '/add_team': {
        const { cmdAddTeam } = await import('./triage-commands.js');
        await cmdAddTeam(args, (t) => this.sendMessage(chatId, t));
        break;
      }
      case '/team': {
        const { cmdTeam } = await import('./triage-commands.js');
        await cmdTeam(args, (t) => this.sendMessage(chatId, t));
        break;
      }
      case '/remove_team': {
        const { cmdRemoveTeam } = await import('./triage-commands.js');
        await cmdRemoveTeam(args, (t) => this.sendMessage(chatId, t));
        break;
      }
      case '/team_own': {
        const { cmdTeamOwn } = await import('./triage-commands.js');
        await cmdTeamOwn(args, (t) => this.sendMessage(chatId, t));
        break;
      }
      case '/add_handle': {
        const { cmdAddHandle } = await import('./triage-commands.js');
        await cmdAddHandle(args, (t) => this.sendMessage(chatId, t));
        break;
      }
      case '/remove_handle': {
        const { cmdRemoveHandle } = await import('./triage-commands.js');
        await cmdRemoveHandle(args, (t) => this.sendMessage(chatId, t));
        break;
      }
      case '/add_keyword': {
        const { cmdAddKeyword } = await import('./triage-commands.js');
        await cmdAddKeyword(args, (t) => this.sendMessage(chatId, t));
        break;
      }
      case '/remove_keyword': {
        const { cmdRemoveKeyword } = await import('./triage-commands.js');
        await cmdRemoveKeyword(args, (t) => this.sendMessage(chatId, t));
        break;
      }
      case '/my_handles': {
        const { cmdMyHandles } = await import('./triage-commands.js');
        await cmdMyHandles((t) => this.sendMessage(chatId, t));
        break;
      }
      case '/add_my_handle': {
        const { cmdAddMyHandle } = await import('./triage-commands.js');
        await cmdAddMyHandle(args, (t) => this.sendMessage(chatId, t));
        break;
      }
      case '/remove_my_handle': {
        const { cmdRemoveMyHandle } = await import('./triage-commands.js');
        await cmdRemoveMyHandle(args, (t) => this.sendMessage(chatId, t));
        break;
      }
      case '/whitelist': {
        const { cmdWhitelist } = await import('./triage-commands.js');
        await cmdWhitelist((t) => this.sendMessage(chatId, t));
        break;
      }
      case '/add_whitelist': {
        const { cmdAddWhitelist } = await import('./triage-commands.js');
        await cmdAddWhitelist(args, (t) => this.sendMessage(chatId, t));
        break;
      }
      case '/remove_whitelist': {
        const { cmdRemoveWhitelist } = await import('./triage-commands.js');
        await cmdRemoveWhitelist(args, (t) => this.sendMessage(chatId, t));
        break;
      }

      case '/sources': {
        const { cmdSources } = await import('./knowledge-commands.js');
        await cmdSources(
          this.argosConfig ?? (await import('../../config/index.js')).getConfig(),
          (t) => this.sendMessage(chatId, t),
        );
        break;
      }
      case '/add_source': {
        const { cmdAddSource } = await import('./knowledge-commands.js');
        await cmdAddSource(
          args,
          this.argosConfig ?? (await import('../../config/index.js')).getConfig(),
          (t) => this.sendMessage(chatId, t),
        );
        break;
      }
      case '/remove_source': {
        const { cmdRemoveSource } = await import('./knowledge-commands.js');
        await cmdRemoveSource(
          args,
          this.argosConfig ?? (await import('../../config/index.js')).getConfig(),
          (t) => this.sendMessage(chatId, t),
        );
        break;
      }
      case '/refresh_sources': {
        const { cmdRefreshSources } = await import('./knowledge-commands.js');
        await cmdRefreshSources(
          this.argosConfig ?? (await import('../../config/index.js')).getConfig(),
          (t) => this.sendMessage(chatId, t),
        );
        break;
      }

      case '/ignore': {
        const { patchConfig } = await import('../../config/index.js');
        const { getConfig } = await import('../../config/index.js');
        const cfg = getConfig();
        const current = cfg.channels.telegram.listener.ignoredSenders ?? [];

        if (!arg) {
          // List ignored senders
          if (current.length === 0) {
            await this.sendMessage(
              chatId,
              '📋 No ignored senders.\nUsage: `/ignore @username` or `/ignore 123456789`',
            );
          } else {
            await this.sendMessage(
              chatId,
              `📋 *Ignored senders:*\n${current.map((s) => `• ${s}`).join('\n')}\n\nRemove with \`/unignore username\``,
            );
          }
          break;
        }
        const sender = arg.replace(/^@/, '').toLowerCase().trim();
        if (current.includes(sender)) {
          await this.sendMessage(chatId, `Already ignoring \`${sender}\``);
          break;
        }
        patchConfig((c) => {
          c.channels.telegram.listener.ignoredSenders = [...current, sender];
        });
        await this.sendMessage(
          chatId,
          `🔇 \`${sender}\` added to ignored senders. Their messages won't create tasks.`,
        );
        break;
      }

      case '/unignore': {
        const { patchConfig } = await import('../../config/index.js');
        const { getConfig } = await import('../../config/index.js');
        const cfg = getConfig();
        const current = cfg.channels.telegram.listener.ignoredSenders ?? [];
        const sender = arg.replace(/^@/, '').toLowerCase().trim();

        if (!sender) {
          await this.sendMessage(chatId, 'Usage: `/unignore username`');
          break;
        }
        if (!current.includes(sender)) {
          await this.sendMessage(chatId, `\`${sender}\` is not in the ignore list.`);
          break;
        }
        patchConfig((c) => {
          c.channels.telegram.listener.ignoredSenders = current.filter((s) => s !== sender);
        });
        await this.sendMessage(chatId, `🔊 \`${sender}\` removed from ignored senders.`);
        break;
      }

      case '/train': {
        // Analyze writing style from the message text (everything after /train)
        const sample = text.slice('/train'.length).trim();
        if (!sample || sample.length < 50) {
          await this.sendMessage(chatId,
            '📝 *Style training*\n\n' +
            'Paste a conversation or text sample after the command:\n' +
            '`/train Hey John, just checking in on the redemption — can you confirm the USDC amount? We need to process it today. Thanks`\n\n' +
            'Or send a file with `/train` as caption.\n' +
            'I\'ll analyze your writing style and update my drafting profile.'
          );
          break;
        }
        await this.sendMessage(chatId, '🔍 Analyzing your writing style…');
        try {
          const { llmCall } = await import('../../llm/index.js');
          const styleAnalysis = await llmCall(this.llmConfig, [
            { role: 'system', content: 'You are a writing style analyst. Analyze the text sample and extract writing patterns. Output a markdown section that can be appended to a user profile. Include: tone, sentence structure, vocabulary habits, formality level, language mixing patterns, greeting/closing habits, punctuation style. Be specific with examples from the text.' },
            { role: 'user', content: `Analyze this writing sample and extract my style:\n\n${sample}` },
          ]);

          // Append to user.md
          const userMdPath = this.getUserMdPath();
          let existing = '';
          try { existing = fs.readFileSync(userMdPath, 'utf8'); } catch { /* new file */ }

          const styleSection = `\n\n## Writing Style (trained from sample)\n\n${styleAnalysis.content}`;

          // Replace existing style section or append
          if (existing.includes('## Writing Style')) {
            const before = existing.split('## Writing Style')[0];
            fs.writeFileSync(userMdPath, before.trimEnd() + styleSection, 'utf8');
          } else {
            fs.writeFileSync(userMdPath, existing.trimEnd() + styleSection, 'utf8');
          }

          await this.sendMessage(chatId,
            '✅ Style profile updated!\n\n' +
            styleAnalysis.content.slice(0, 500) +
            '\n\n_Saved to user.md — I\'ll use this style for all future drafts._'
          );
        } catch (e) {
          await this.sendMessage(chatId, `⚠️ Style analysis failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }

      case '/help':
        await this.sendMessage(
          chatId,
          '🔭 *Argos commands*\n\n' +
            '*Monitoring*\n' +
            '/add_chat — lister tes chats\n' +
            '/chats — chats surveillés\n' +
            '/remove_chat <id>\n\n' +
            '*Triage*\n' +
            '/triage — config & statut\n' +
            '/triage on|off\n' +
            '/triage mention-only on|off\n' +
            '/triage ignore-own on|off\n' +
            '/my_handles — mes pseudos\n' +
            '/add_my_handle @pseudo\n\n' +
            '*Équipes*\n' +
            '/teams — lister les équipes\n' +
            '/add_team <nom> [desc]\n' +
            '/team <nom>\n' +
            '/team_own <nom> on|off\n' +
            '/add_handle <équipe> @pseudo\n' +
            '/add_keyword <équipe> <mot>\n' +
            '/remove_team <nom>\n\n' +
            '*Whitelist TX*\n' +
            '/whitelist\n' +
            '/add_whitelist <mot>\n' +
            '/remove_whitelist <mot>\n\n' +
            '*Knowledge*\n' +
            '/sources — sources indexées\n' +
            '/add_source <url> — ajouter une URL\n' +
            '/add_source github owner/repo\n' +
            '/remove_source <index>\n' +
            '/refresh_sources — re-indexer\n\n' +
            '*Style*\n' +
          '/train <texte> — analyser ton style d\'écriture\n' +
          'Envoie un fichier avec caption /train\n\n' +
          '*Filtres*\n' +
            '/ignore @user — ignorer un sender (pas de tâches)\n' +
            '/unignore @user — ne plus ignorer\n' +
            '/ignore — lister les ignorés\n\n' +
            '*Système*\n' +
            '/stop — stopper la tâche en cours\n' +
            '/status · /proposals · /tasks · /done <id>|all · /cancel · /compact · /clear\n\n' +
            '🔒 Approvals: web app only\n\n' +
            '*Setup & maintenance*\n' +
            '`npm run setup -- --step 1` — LLM / API keys\n' +
            '`npm run setup -- --step 4` — Telegram credentials\n' +
            '`npm run setup -- --step 6` — Voice, Cloudflare, MCP\n' +
            '`npm run doctor` — health check',
        );
        break;

      default:
        await this.sendMessage(
          chatId,
          `Unknown command: ${cmd}\nType /help for available commands.`,
        );
    }
  }

  private getUserMdPath(): string {
    const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
    return path.join(
      dataDir.startsWith('~') ? path.join(os.homedir(), dataDir.slice(1)) : dataDir,
      'user.md',
    );
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

  /** Evict oldest conversations when cache exceeds limit (simple LRU via Map insertion order). */
  private evictConversations(): void {
    while (this.conversations.size > TelegramBot.MAX_CONVERSATIONS) {
      const oldest = this.conversations.keys().next().value;
      if (oldest !== undefined) this.conversations.delete(oldest);
    }
  }

  private async loadConversation(userId: string): Promise<CompactableHistory> {
    const cached = this.conversations.get(userId);
    if (cached) {
      // Move to end (refresh LRU position)
      this.conversations.delete(userId);
      this.conversations.set(userId, cached);
      return cached;
    }

    try {
      const { getDb } = await import('../../db/index.js');
      const db = getDb();
      const row = db
        .prepare('SELECT messages, compacted_summary FROM conversations WHERE user_id = ?')
        .get(userId) as { messages: string; compacted_summary: string | null } | undefined;
      if (row) {
        const rawMsgs: CompactableHistory['messages'] = JSON.parse(row.messages);
        // Sanitize: remove consecutive messages with the same role (causes API 400)
        const deduped: CompactableHistory['messages'] = [];
        for (const msg of rawMsgs) {
          if (deduped.length > 0 && deduped[deduped.length - 1].role === msg.role) {
            // Merge content to preserve info
            const prev = deduped[deduped.length - 1];
            prev.content = String(prev.content) + '\n' + String(msg.content);
          } else {
            deduped.push({ ...msg });
          }
        }
        const conv: CompactableHistory = {
          messages: deduped,
          compactedSummary: row.compacted_summary ?? undefined,
        };
        this.conversations.set(userId, conv);
        log.debug(`Loaded conversation for ${userId}: ${conv.messages.length} messages`);
        return conv;
      }
    } catch {
      /* DB not ready */
    }

    const fresh: CompactableHistory = { messages: [] };
    this.conversations.set(userId, fresh);
    return fresh;
  }

  private async saveConversation(userId: string, conv: CompactableHistory): Promise<void> {
    this.conversations.set(userId, conv);
    this.evictConversations();
    try {
      const { getDb } = await import('../../db/index.js');
      const db = getDb();
      db.prepare(
        `
        INSERT INTO conversations (user_id, messages, compacted_summary, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET messages = ?, compacted_summary = ?, updated_at = ?
      `,
      ).run(
        userId,
        JSON.stringify(conv.messages),
        conv.compactedSummary ?? null,
        Date.now(),
        JSON.stringify(conv.messages),
        conv.compactedSummary ?? null,
        Date.now(),
      );
    } catch (e) {
      log.debug(`Failed to save conversation: ${e}`);
    }
  }

  /** Detect task completion signals in owner chat messages and update DB immediately. */
  private async detectAndCompleteTasksFromChat(text: string): Promise<void> {
    try {
      const { getDb } = await import('../../db/index.js');
      const db = getDb();
      const openTasks = db
        .prepare(
          "SELECT id, title FROM tasks WHERE status IN ('open','in_progress') ORDER BY detected_at DESC LIMIT 20",
        )
        .all() as Array<{ id: string; title: string }>;
      if (!openTasks.length) return;

      const { llmCall, extractJson } = await import('../../llm/index.js');
      const taskList = openTasks.map((t) => `[${t.id}] ${t.title}`).join('\n');

      const response = await llmCall(this.llmConfig, [
        {
          role: 'system',
          content: `You are a task completion detector. Given an owner message, determine which open tasks are now completed.
A task is completed if the message says it's done, sent, confirmed, or resolved.
Respond ONLY with valid JSON: {"completed": ["task_id_1"], "reasoning": "brief reason"}
If nothing is completed, return {"completed": [], "reasoning": ""}`,
        },
        {
          role: 'user',
          content: `Open tasks:\n${taskList}\n\nOwner message: ${text.slice(0, 500)}`,
        },
      ]);

      const result = extractJson<{ completed: string[]; reasoning: string }>(response.content);
      if (!result.completed?.length) return;

      const now = Date.now();
      for (const taskId of result.completed) {
        if (!openTasks.some((t) => t.id === taskId)) continue;
        db.prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(
          now,
          taskId,
        );
        log.info(
          `Task completed by owner via Telegram chat: ${taskId} — ${result.reasoning?.slice(0, 80)}`,
        );
      }
    } catch (e) {
      log.warn(`Task completion detection failed: ${(e as Error).message}`);
    }
  }

  /**
   * Inject a system result (e.g. script output) into a user's conversation and trigger
   * the LLM to analyze it and react. Used after proposal execution so Argos continues
   * the conversation proactively instead of just dumping output.
   */
  async injectAndProcess(userId: string, chatId: string, resultText: string): Promise<void> {
    log.info(`injectAndProcess: userId=${userId} chatId=${chatId} resultLen=${resultText.length}`);
    this.lastChatId = chatId;
    try {
      // Run defaultHandler as if the user sent the result — LLM will see it as context
      const syntheticMessage = `[System — Script execution result]\n\n${resultText}\n\nAnalyze this result. If it failed, explain why and suggest or try a fix. If it succeeded, summarize the outcome.`;
      await this.defaultHandler(userId, syntheticMessage);
      log.info('injectAndProcess: defaultHandler completed');
    } catch (e) {
      log.error(`injectAndProcess failed: ${(e as Error)?.message}`);
    }
  }

  private async defaultHandler(userId: string, text: string): Promise<string> {
    // Detect completion signals — update DB before generating reply
    await this.detectAndCompleteTasksFromChat(text);

    // Load conversation (from memory cache or DB)
    let conv = await this.loadConversation(userId);

    // Add user message
    conv.messages.push({ role: 'user', content: text });

    // Compact if needed (summarize old messages)
    const { needsCompaction, compactHistory, buildMessagesWithCompaction } =
      await import('../../llm/compaction.js');
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

    // Fetch relevant memories (past conversations, facts) — context docs excluded (on-demand via semantic_search)
    let memoryContext = '';
    try {
      const { search } = await import('../../memory/store.js');
      const memories = search({ query: text, limit: 5 });
      const nonContext = memories.filter((m) => String(m.category) !== 'context');
      if (nonContext.length > 0) {
        memoryContext =
          '\n\n---\n## Relevant memories:\n' +
          nonContext.map((m) => `- [${m.category}] ${m.content}`).join('\n');
      }
    } catch {
      /* memory not initialized */
    }

    // Build messages with compaction context
    const messages = buildMessagesWithCompaction(systemPrompt, conv, memoryContext);

    // Call LLM with tool loop (builtin tools + MCP tools)
    const { BUILTIN_TOOLS, executeBuiltinTool } = await import('../../llm/builtin-tools.js');
    const { runToolLoop } = await import('../../llm/tool-loop.js');
    const { callAnthropicBearerRaw: _callAnthropicBearerRaw } = await import('../../llm/index.js');
    const { getMcpTools, executeMcpToolSafe } = await import('../../mcp/client.js');

    // Merge builtin + MCP tools — exclude notion-mcp (use notion_* builtins instead)
    const allTools = [
      ...BUILTIN_TOOLS,
      ...getMcpTools().filter((t) => !t.name.startsWith('mcp_notion-mcp_')),
    ];
    const combinedExecutor = async (name: string, input: Record<string, unknown>) => {
      if (name.startsWith('mcp_')) return executeMcpToolSafe(name, input);
      return executeBuiltinTool(name, input);
    };

    const chatId = this.lastChatId!;

    // ── Streaming state ────────────────────────────────────────────────────────
    let statusMsgId: number | null = null; // tool-use status bubble
    let streamMsgId: number | null = null; // live response bubble
    let accText = '';
    let lastEditMs = 0;
    const STREAM_THROTTLE = 900; // ms between Telegram edits (rate limit safety)

    const sendOrEdit = async (
      msgId: number | null,
      text: string,
      markdown = false,
    ): Promise<number> => {
      try {
        if (msgId) {
          await this.api('editMessageText', {
            chat_id: chatId,
            message_id: msgId,
            text,
            ...(markdown && { parse_mode: 'Markdown' }),
          }).catch(() => {});
          return msgId;
        }
        const sent = (await this.api('sendMessage', {
          chat_id: chatId,
          text,
          ...(markdown && { parse_mode: 'Markdown' }),
        })) as { result: { message_id: number } };
        return sent.result.message_id;
      } catch {
        return msgId ?? 0;
      }
    };

    const toolEmoji: Record<string, string> = {
      web_search: '🔍',
      fetch_url: '🌐',
      memory_search: '🧠',
      memory_store: '💾',
      read_file: '📄',
      write_file: '✏️',
      current_time: '🕐',
      spawn_agent: '🤖',
      semantic_search: '🔎',
      create_proposal: '📋',
      list_knowledge: '📚',
    };

    let toolStatusLine = ''; // persisted tool status shown above stream text

    // Serialize Telegram API calls — prevents race conditions when chunks arrive faster than API responds
    let eventQueue: Promise<void> = Promise.resolve();
    const onEvent = async (event: import('../../llm/tool-loop.js').ToolLoopEvent) => {
      // Queue events so they execute one at a time
      eventQueue = eventQueue.then(() => onEventInner(event)).catch(() => {});
      return eventQueue;
    };

    const onEventInner = async (event: import('../../llm/tool-loop.js').ToolLoopEvent) => {
      if (event.type === 'tool_call') {
        const emoji = toolEmoji[event.name] ?? '🔧';
        const hint =
          event.name === 'web_search'
            ? ` _${String((event.input as Record<string, unknown>).query ?? '').slice(0, 50)}_`
            : '';
        toolStatusLine = `${emoji} *${event.name}*${hint}…`;

        // Reuse existing bubble (stream or status) — never delete
        const bubble = streamMsgId ?? statusMsgId;
        const displayText = accText ? `${accText}\n\n${toolStatusLine}` : toolStatusLine;
        if (bubble) {
          await this.api('editMessageText', {
            chat_id: chatId,
            message_id: bubble,
            text: displayText,
            parse_mode: 'Markdown',
          }).catch(() => {});
          statusMsgId = bubble;
          streamMsgId = null; // tool phase — stream will reattach on next text_chunk
        } else {
          statusMsgId = await sendOrEdit(null, displayText, true);
        }
      } else if (event.type === 'tool_result') {
        if (event.error) {
          toolStatusLine = `⚠️ *${event.name}* failed`;
          const bubble = statusMsgId ?? streamMsgId;
          if (bubble)
            await this.api('editMessageText', {
              chat_id: chatId,
              message_id: bubble,
              text: accText ? `${accText}\n\n${toolStatusLine}` : toolStatusLine,
              parse_mode: 'Markdown',
            }).catch(() => {});
        } else {
          toolStatusLine = ''; // tool succeeded — clear status for next text
        }
      } else if (event.type === 'text_chunk') {
        accText += event.text;
        const now = Date.now();
        if (now - lastEditMs > STREAM_THROTTLE) {
          const displayText = accText + ' ▌';
          // Reuse status bubble as stream bubble — no delete
          if (!streamMsgId && statusMsgId) {
            streamMsgId = statusMsgId;
            statusMsgId = null;
          }
          if (streamMsgId) {
            await this.api('editMessageText', {
              chat_id: chatId,
              message_id: streamMsgId,
              text: displayText,
            }).catch(() => {});
          } else {
            const sent = (await this.api('sendMessage', {
              chat_id: chatId,
              text: displayText,
            })) as { result: { message_id: number } };
            streamMsgId = sent.result.message_id;
          }
          lastEditMs = now;
        }
      }
    };

    // Register abort controller — allows /stop to cancel this loop
    const abortController = new AbortController();
    this.abortControllers.set(userId, abortController);
    this.activeLoops.add(userId);

    // Inject abort check into onEvent — throws on /stop
    const originalOnEvent = onEvent;
    const onEventWithAbort = async (event: import('../../llm/tool-loop.js').ToolLoopEvent) => {
      if (abortController.signal.aborted) throw new Error('CANCELLED');
      return originalOnEvent(event);
    };

    // Drain one interrupt per tool boundary — injected into the LLM context
    const getInterrupt = (): string | undefined => {
      const queue = this.interruptMessages.get(userId);
      if (queue && queue.length > 0) return queue.shift();
      return undefined;
    };

    let response: { content: string; inputTokens?: number; outputTokens?: number };

    const { callAnthropicBearerRaw: _bearerRaw } = await import('../../llm/index.js');

    // Build the compatible (OpenAI) provider function for fallback use
    const compatProvider = async (
            cfg: import('../../llm/index.js').LLMConfig,
            body: Record<string, unknown>,
            onDelta?: (d: string) => void,
          ) => {
            // OpenAI-compat streaming (Ollama, Gemini, etc.)
            const msgs = body.messages as import('../../llm/index.js').LLMMessage[];
            const sys = body.system as string | undefined;
            const allMsgs = sys ? [{ role: 'system' as const, content: sys }, ...msgs] : msgs;
            const tools = body.tools as unknown[] | undefined;
            const baseURL = cfg.baseUrl ?? 'https://api.openai.com/v1';

            // Convert Anthropic message format → OpenAI format
            const mappedMessages: Array<Record<string, unknown>> = [];
            for (const m of allMsgs) {
              if (!Array.isArray(m.content)) {
                mappedMessages.push({ role: m.role, content: m.content });
                continue;
              }
              const blocks = m.content as Array<Record<string, unknown>>;

              // Anthropic assistant with tool_use blocks → OpenAI assistant with tool_calls
              if (m.role === 'assistant') {
                const textParts = blocks
                  .filter((b) => b.type === 'text')
                  .map((b) => b.text as string)
                  .join('');
                const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use');
                if (toolUseBlocks.length > 0) {
                  mappedMessages.push({
                    role: 'assistant',
                    content: textParts || null,
                    tool_calls: toolUseBlocks.map((b) => ({
                      id: b.id as string,
                      type: 'function',
                      function: {
                        name: b.name as string,
                        arguments: JSON.stringify(b.input ?? {}),
                      },
                    })),
                  });
                } else {
                  mappedMessages.push({ role: 'assistant', content: textParts });
                }
                continue;
              }

              // Anthropic user with tool_result blocks → OpenAI tool messages
              const toolResults = blocks.filter((b) => b.type === 'tool_result');
              if (toolResults.length > 0) {
                for (const tr of toolResults) {
                  mappedMessages.push({
                    role: 'tool',
                    tool_call_id: tr.tool_use_id as string,
                    content: tr.content as string,
                  });
                }
                // Also add any non-tool-result content as a regular user message
                const otherBlocks = blocks.filter((b) => b.type !== 'tool_result');
                if (otherBlocks.length > 0) {
                  mappedMessages.push({
                    role: 'user',
                    content: otherBlocks.map((b) => b.text ?? '').join(''),
                  });
                }
                continue;
              }

              // Default: extract text
              mappedMessages.push({
                role: m.role,
                content: blocks.map((b) => (b.type === 'text' ? (b.text as string) : '')).join(''),
              });
            }

            // Map Anthropic tool format → OpenAI function format
            const openaiTools = tools?.map((t: unknown) => {
              const tool = t as { name: string; description?: string; input_schema?: unknown };
              return {
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description ?? '',
                  parameters: tool.input_schema ?? { type: 'object', properties: {} },
                },
              };
            });

            const res = await fetch(`${baseURL}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
              },
              body: JSON.stringify({
                model: cfg.model,
                messages: mappedMessages,
                max_tokens: cfg.maxTokens ?? 4096,
                ...(cfg.temperature !== undefined && { temperature: cfg.temperature }),
                ...(openaiTools?.length ? { tools: openaiTools } : {}),
                stream: true,
              }),
            });

            if (!res.ok) {
              const errBody = await res.text();
              throw new Error(`LLM streaming error ${res.status}: ${errBody.slice(0, 300)}`);
            }

            // Parse SSE stream
            const content: Array<{
              type: string;
              text?: string;
              id?: string;
              name?: string;
              input?: Record<string, unknown>;
            }> = [];
            let fullText = '';
            const toolCalls: Record<number, { id: string; name: string; args: string }> = {};
            let inputTokens = 0,
              outputTokens = 0;

            const { _readSseJson } = await import('../../llm/index.js');
            for await (const parsed of _readSseJson(res)) {
              const usage = parsed.usage as
                | { prompt_tokens?: number; completion_tokens?: number }
                | undefined;
              if (usage) {
                inputTokens = usage.prompt_tokens ?? inputTokens;
                outputTokens = usage.completion_tokens ?? outputTokens;
              }
              const choices = parsed.choices as
                | Array<{
                    delta: {
                      content?: string;
                      reasoning?: string;
                      tool_calls?: Array<{
                        index: number;
                        id?: string;
                        function?: { name?: string; arguments?: string };
                      }>;
                    };
                  }>
                | undefined;
              const delta = choices?.[0]?.delta;
              // Some models (Qwen) put text in content, reasoning in a separate field
              const textChunk = delta?.content || (delta as Record<string,string>)?.reasoning || '';
              if (textChunk) {
                fullText += textChunk;
                if (onDelta) onDelta(textChunk);
              }
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (!toolCalls[tc.index])
                    toolCalls[tc.index] = { id: tc.id ?? `call_${tc.index}`, name: '', args: '' };
                  if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
                  if (tc.function?.arguments) toolCalls[tc.index].args += tc.function.arguments;
                }
              }
            }

            if (fullText) content.push({ type: 'text', text: fullText });
            for (const tc of Object.values(toolCalls)) {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(tc.args);
              } catch {
                /* empty */
              }
              content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
            }

            const hasToolUse = content.some((b) => b.type === 'tool_use');
            return {
              content,
              stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
              usage: { input_tokens: inputTokens, output_tokens: outputTokens },
              model: cfg.model,
            };
          };

    // Select primary provider + wrap with fallback on retryable errors (429, 5xx, timeout)
    const primaryProvider = this.llmConfig.provider === 'anthropic' ? _bearerRaw : compatProvider;
    const fallbackCfg = this.llmConfig.fallback;

    const providerWithFallback: typeof _bearerRaw = async (cfg, body, onDelta) => {
      try {
        return await primaryProvider(cfg, body, onDelta);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const retryable = /\b(5\d\d|429|402|rate.limit|timeout|overloaded|ECONNREFUSED|credit)/i.test(msg);
        if (retryable && fallbackCfg) {
          log.warn(`Primary LLM failed (${msg.slice(0, 100)}), falling back to ${fallbackCfg.provider}/${fallbackCfg.model}`);
          // Switch config to fallback and use the appropriate provider
          const fbProvider = fallbackCfg.provider === 'anthropic' ? _bearerRaw : compatProvider;
          return fbProvider(fallbackCfg, body, onDelta);
        }
        throw e;
      }
    };

    try {
      response = await runToolLoop(
        this.llmConfig,
        systemPrompt,
        messages,
        allTools,
        combinedExecutor,
        providerWithFallback,
        onEventWithAbort,
        getInterrupt,
      );
    } finally {
      this.abortControllers.delete(userId);
      this.activeLoops.delete(userId);
      this.interruptMessages.delete(userId);
    }

    // If a status bubble is still showing (no text was streamed), convert it to the stream bubble
    // so the final response replaces it in-place instead of creating a new message
    if (statusMsgId && !streamMsgId) {
      streamMsgId = statusMsgId;
      statusMsgId = null;
    }
    // Clean up any remaining status bubble (should be rare — only if both exist)
    if (statusMsgId && statusMsgId !== streamMsgId) {
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
    } catch {
      /* non-blocking */
    }

    // Guard against empty responses
    const finalContent = response.content?.trim() || '(No response generated — try again)';

    // Add assistant response to history + persist
    conv.messages.push({ role: 'assistant', content: finalContent });
    await this.saveConversation(userId, conv);

    // Token footer (debug info)
    const inTok = (response as { inputTokens?: number }).inputTokens;
    const outTok = (response as { outputTokens?: number }).outputTokens;
    const footer = inTok !== null && inTok !== undefined ? `\n\n_${inTok}↑ ${outTok}↓ tokens_` : '';

    const displayContent = finalContent + footer;

    // Final render: edit stream bubble in place (no flicker) or send fresh if no stream bubble
    if (streamMsgId) {
      // Try Markdown first; fall back to plain edit (NOT sendMessage — avoid duplicate)
      const edited =
        (await this.api('editMessageText', {
          chat_id: chatId,
          message_id: streamMsgId,
          text: displayContent,
          parse_mode: 'Markdown',
        }).catch(() => null)) ??
        (await this.api('editMessageText', {
          chat_id: chatId,
          message_id: streamMsgId,
          text: displayContent,
        }).catch(() => null));
      // Only send fresh if both edits failed (e.g. message deleted by user)
      // Delete the stale ▌ bubble first to avoid double-message
      if (!edited) {
        await this.api('deleteMessage', { chat_id: chatId, message_id: streamMsgId }).catch(
          () => {},
        );
        await this.sendMessage(chatId, displayContent, false);
      }
    } else {
      await this.sendMessage(chatId, displayContent, false);
    }

    // TTS — speak the response via configured triggers
    if (this.argosConfig?.voice?.ttsEnabled && finalContent) {
      try {
        const { speak } = await import('../../voice/speak.js');
        const voiceCfg = this.argosConfig.voice as unknown as import('../../voice/speak.js').VoiceOutputConfig;
        const trigger = 'always' as const;
        const sendVoice = async (audio: Buffer, filename: string) => {
          const blob = new Blob([audio]);
          const form = new globalThis.FormData();
          form.append('chat_id', chatId);
          form.append('voice', blob, filename);
          await fetch(`https://api.telegram.org/bot${this.token}/sendVoice`, {
            method: 'POST', body: form,
          });
        };
        speak(finalContent, voiceCfg, trigger, sendVoice).catch(e => {
          log.warn(`TTS speak failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      } catch (e) { log.warn(`TTS init failed: ${e}`); }
    }

    // Signal to handleUpdate that the reply was already sent
    return '';
  }

  /**
   * Auto-memorize important facts from conversations.
   * Runs a quick classification on the exchange to decide if it's worth remembering.
   */
  private async autoMemorize(userId: string, userMsg: string, assistantMsg: string): Promise<void> {
    // Skip short exchanges
    if (userMsg.length < 20) return;

    try {
      const { llmCall } = await import('../../llm/index.js');
      const { getAnonymizer } = await import('../../privacy/anonymizer.js');
      const anonConfig = this.argosConfig?.anonymizer ?? {
        mode: 'regex' as const,
        bucketAmounts: true,
        anonymizeCryptoAddresses: false,
        knownPersons: [],
        customPatterns: [],
      };
      const anonymizer = getAnonymizer(anonConfig);

      // Anonymize both sides before sending to LLM — never expose raw PII/addresses
      const anonUser = anonymizer.anonymize(userMsg.slice(0, 500)).text;
      const anonAssistant = anonymizer.anonymize(assistantMsg.slice(0, 500)).text;

      // Quick check: is this worth memorizing?
      const check = await llmCall(this.llmConfig, [
        {
          role: 'system',
          content: `You decide if a conversation exchange contains information worth remembering long-term.
Output ONLY a JSON object: { "memorize": true/false, "summary": "one-line summary if true", "category": "preference|fact|task|decision|context" }
Only memorize: user preferences, important facts, decisions made, task outcomes. NOT: greetings, small talk, questions without answers.`,
        },
        {
          role: 'user',
          content: `User said: "${anonUser}"\nAssistant replied: "${anonAssistant}"`,
        },
      ]);

      const parsed = JSON.parse(
        check.content
          .replace(/```json?\n?/g, '')
          .replace(/```/g, '')
          .trim(),
      );
      if (parsed.memorize && parsed.summary) {
        const { storeQuick } = await import('../../memory/store.js');
        storeQuick(parsed.summary, parsed.category ?? 'general', [`user:${userId}`]);
        log.debug(`Auto-memorized: ${parsed.summary}`);
      }
    } catch {
      /* non-critical */
    }
  }

  async sendMessageWithKeyboard(
    chatId: string,
    text: string,
    keyboard: TgInlineKeyboard,
  ): Promise<void> {
    await this.api('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async sendMessage(chatId: string, text: string, saveConv = true): Promise<void> {
    // Telegram max message length is 4096
    const chunks = this.splitMessage(text, 4096);
    for (const chunk of chunks) {
      await this.api('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'Markdown',
      }).catch(async () => {
        await this.api('sendMessage', { chat_id: chatId, text: chunk });
      });
    }

    // Store notifications sent to the owner in conversation history
    // so the bot has full context when the owner replies ("c'est bon je l'ai fait")
    const approvalChatId = this.allowedUsers.size === 1 ? [...this.allowedUsers][0] : chatId;
    if (saveConv && chatId === approvalChatId) {
      const conv = await this.loadConversation(chatId);
      conv.messages.push({ role: 'assistant', content: text });
      await this.saveConversation(chatId, conv);
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
export type TgInlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

interface TgCallbackQuery {
  id: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

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
    voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  };
  callback_query?: TgCallbackQuery;
}
