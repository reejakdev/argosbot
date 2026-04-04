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
import type { } from '../../llm/index.js'; // types only — llmCall imported dynamically
import type { Config } from '../../config/schema.js';
import type { CompactableHistory } from '../../llm/compaction.js';
import type { TelegramChannel } from './telegram.js';

const log = createLogger('telegram-bot');

const POLL_TIMEOUT = 30; // seconds (Telegram long-poll)

export interface TelegramBotOptions {
  token: string;
  allowedUsers: string[];  // Telegram user IDs allowed to interact
  llmConfig: LLMConfig;
  config?: Config;          // Full Argos config — used to build system prompt
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
  private lastChatId: string | null = null;
  private pendingConfirmation: Map<string, string> = new Map();
  // Per-user sequential queue — prevents parallel LLM calls for the same user
  private processingQueue: Map<string, Promise<void>> = new Map();
  private approvalChatIdSaved = false;
  private mtprotoChannel: TelegramChannel | undefined;

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

    // Drain and DISCARD all pending updates accumulated while offline.
    // Without this, old messages from other users would trigger LLM calls at boot.
    try {
      let drained = false;
      while (!drained) {
        const res = await this.api('getUpdates', { offset: this.offset, limit: 100, timeout: 0 }) as { result: Array<{ update_id: number }> };
        if (!res.result || res.result.length === 0) {
          drained = true;
        } else {
          const last = res.result[res.result.length - 1];
          this.offset = last.update_id + 1;
        }
      }
      log.info(`Telegram Bot: discarded stale updates, starting fresh from offset ${this.offset}`);
    } catch { /* non-fatal */ }

    // Register commands so Telegram shows them when user types /
    this.api('setMyCommands', {
      commands: [
        { command: 'status',          description: 'État du système' },
        { command: 'proposals',       description: 'Propositions en attente' },
        { command: 'add_chat',        description: 'Lister les chats à surveiller' },
        { command: 'chats',           description: 'Chats surveillés' },
        { command: 'remove_chat',     description: 'Arrêter de surveiller un chat' },
        { command: 'triage',          description: 'Config triage (on/off, mention-only, ignore-own)' },
        { command: 'teams',           description: 'Lister les équipes' },
        { command: 'add_team',        description: 'Créer une équipe' },
        { command: 'team',            description: 'Détails d\'une équipe' },
        { command: 'team_own',        description: 'Marquer équipe interne/externe' },
        { command: 'add_handle',      description: 'Ajouter un handle à une équipe' },
        { command: 'add_keyword',     description: 'Ajouter un keyword à une équipe' },
        { command: 'my_handles',      description: 'Mes pseudos personnels' },
        { command: 'add_my_handle',   description: 'Ajouter un pseudo personnel' },
        { command: 'whitelist',       description: 'Keywords whitelist TX' },
        { command: 'add_whitelist',   description: 'Ajouter keyword whitelist TX' },
        { command: 'cancel',          description: 'Annuler les propositions' },
        { command: 'compact',         description: 'Compresser l\'historique' },
        { command: 'clear',           description: 'Réinitialiser la conversation' },
        { command: 'help',            description: 'Toutes les commandes' },
      ],
    }).catch(() => { /* non-blocking */ });

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
          allowed_updates: ['message', 'callback_query'],
        }) as { result: TgUpdate[] };

        for (const update of data.result) {
          this.offset = update.update_id + 1;
          if (update.callback_query) {
            await this.handleCallbackQuery(update.callback_query);
          } else {
            await this.handleUpdate(update);
          }
        }
      } catch (e) {
        // AbortError = long-poll timeout — normal, just retry immediately
        if ((e as Error)?.name === 'AbortError' || (e as Error)?.name === 'TimeoutError') continue;
        log.error(`Polling error: ${(e as Error)?.message ?? String(e)}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.from) return;

    // Serialize per-user to avoid parallel LLM calls (prevents rate limit bursts)
    const userId = String(msg.from.id);
    const prev = this.processingQueue.get(userId) ?? Promise.resolve();
    const next = prev.then(() => this._handleUpdateInner(update)).catch((e) => {
      log.error(`Unhandled queue error for user ${userId}: ${e instanceof Error ? e.message : String(e)}`);
    });
    this.processingQueue.set(userId, next);
    await next;
    if (this.processingQueue.get(userId) === next) this.processingQueue.delete(userId);
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
        const fileInfo = await this.api('getFile', { file_id: voice.file_id }) as { result: { file_path: string } };
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
              ttsProvider:       this.argosConfig.voice.ttsProvider,
              openAiTtsApiKey:   this.argosConfig.voice.openAiTtsApiKey,
              openAiTtsModel:    this.argosConfig.voice.openAiTtsModel,
              openAiTtsVoice:    this.argosConfig.voice.openAiTtsVoice,
              elevenLabsApiKey:  this.argosConfig.voice.elevenLabsApiKey,
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
        await this.sendMessage(chatId, '⚠️ Could not process voice message. Is whisperApiKey configured?');
      }
      return; // handled
    }

    if (!msg.text) return;
    const text = msg.text.trim();

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
      // Empty string means the handler already sent the reply (streaming mode)
      if (response) await this.sendMessage(chatId, response);
    } catch (e) {
      clearInterval(typingInterval);
      const errMsg = e instanceof Error ? e.message : JSON.stringify(e);
      log.error(`Error handling message: ${errMsg}`);
      if (e instanceof Error && e.stack) log.error(e.stack);
      const isRateLimit = errMsg.includes('429') || errMsg.includes('rate_limit');
      const userMsg = isRateLimit
        ? '⏳ Rate limit reached — please wait a few seconds and try again.'
        : `⚠️ Error: ${errMsg.slice(0, 200)}`;
      await this.sendMessage(chatId, userMsg);
    }
  }

  private async handleFileUpload(msg: NonNullable<TgUpdate['message']>, userId: string, chatId: string): Promise<void> {
    if (this.allowedUsers.size === 0 || !this.allowedUsers.has(userId)) return;

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

      const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
      const resolvedDir = dataDir.startsWith('~') ? path.join(os.homedir(), dataDir.slice(1)) : dataDir;
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');

      // Caption "knowledge" (or starts with /knowledge) → save to ~/.argos/knowledge/
      const isKnowledge = /^\/?(knowledge|ref|reference)\b/i.test(caption.trim());

      let filePath: string;
      let savedTo: string;
      if (isKnowledge) {
        const knowledgeDir = path.join(resolvedDir, 'knowledge');
        fs.mkdirSync(knowledgeDir, { recursive: true });
        filePath = path.join(knowledgeDir, safeName);
        savedTo  = `knowledge/${safeName}`;
      } else {
        const contextDir = path.join(resolvedDir, 'context', 'uploads');
        fs.mkdirSync(contextDir, { recursive: true });
        filePath = path.join(contextDir, `${Date.now()}_${safeName}`);
        savedTo  = `context/uploads/${Date.now()}_${safeName}`;
      }

      fs.writeFileSync(filePath, buffer);
      log.info(`File saved: ${filePath} (${buffer.length} bytes)${isKnowledge ? ' [knowledge]' : ''}`);

      // If it's a text-based file, read and process it
      const ext = path.extname(fileName).toLowerCase();
      const textExts = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.yml', '.yaml', '.toml', '.log', '.py', '.js', '.ts'];
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
        await this.sendMessage(chatId,
          `📚 Saved to knowledge base: \`${savedTo}\`${indexMsg}\n` +
          `Use \`read_file(path="${savedTo}", search="<keyword>")\` for exact lookups.`
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
        const { buildMessagesWithCompaction, needsCompaction, compactHistory } = await import('../../llm/compaction.js');

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
                { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: imageData } },
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
        const { buildMessagesWithCompaction, needsCompaction, compactHistory } = await import('../../llm/compaction.js');
        conv.messages.push({ role: 'user', content: caption ? `[PDF: ${fileName}] ${caption}` : `[PDF: ${fileName}]` });
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
                { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: pdfData } },
              ],
            };
          }
          return m;
        });

        const pdfResponse = await _llmCall(this.llmConfig, pdfMessages as Parameters<typeof _llmCall>[1]);
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
      await this.sendMessage(chatId, `⚠️ Error processing file: ${e instanceof Error ? e.message : String(e)}`);
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
      const cached  = this.mtprotoChannel?.dialogCache.find(d => d.chatId === rawChatId);
      const name    = cached?.name ?? rawChatId;
      const isGroup = cached?.isGroup ?? rawChatId.startsWith('-');

      const { addMonitoredChat } = await import('../../config/index.js');
      const config = (await import('../../config/index.js')).getConfig();
      const already = config.channels.telegram.listener.monitoredChats.some(c => c.chatId === rawChatId);
      if (already) {
        await this.api('answerCallbackQuery', { callback_query_id: cb.id, text: `${name} déjà surveillé`, show_alert: false });
        return;
      }
      addMonitoredChat(rawChatId, name, isGroup);
      // Edit the clicked button to show ✅
      await this.api('editMessageReplyMarkup', {
        chat_id:    chatId,
        message_id: cb.message?.message_id,
        reply_markup: { inline_keyboard: [[{ text: `✅ ${name}`, callback_data: 'noop' }]] },
      }).catch(() => {});
      await this.sendMessage(chatId, `✅ *${name}* ajouté aux chats surveillés\n\`${rawChatId}\``);
      return;
    }

    if (data === 'noop') return;

    // approve:<proposalId> / reject:<proposalId> — inline button callbacks
    if (data.startsWith('approve:') || data.startsWith('reject:') || data.startsWith('snooze:') || data.startsWith('details:')) {
      const { handleCallback } = await import('../../gateway/approval.js');
      const { executeProposal } = await import('../../workers/index.js');
      const { getConfig } = await import('../../config/index.js');

      const response = await handleCallback(
        data, cb.id,
        async (proposal, actions, token) => {
          const config = getConfig();
          await executeProposal(proposal, actions, config, t => this.sendMessage(chatId, t), token);
        },
      );

      // Edit the original message to reflect the new status
      if (data.startsWith('approve:') || data.startsWith('reject:')) {
        await this.api('editMessageReplyMarkup', {
          chat_id:    chatId,
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
      const shortId = doneShortcut[1];
      try {
        const { getDb } = await import('../../db/index.js');
        const db = getDb();
        const row = db.prepare(
          "SELECT id, title FROM tasks WHERE id LIKE ? AND status IN ('open','in_progress','done_inferred') LIMIT 1"
        ).get(`%${shortId}`) as { id: string; title: string } | null;
        if (!row) {
          await this.sendMessage(chatId, `⚠️ Task \`${shortId}\` not found or already closed.`);
        } else {
          db.prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(Date.now(), row.id);
          await this.sendMessage(chatId, `✅ *${row.title.slice(0, 80)}* marked as done.`);
        }
      } catch (e) {
        await this.sendMessage(chatId, `⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    const [cmd, ...args] = text.split(' ');
    const arg = args.join(' ');

    switch (cmd) {
      case '/start':
        await this.sendMessage(chatId,
          '👋 Hey! I\'m Argos — your AI assistant.\n\n' +
          'Just send me a message and I\'ll help you.\n\n' +
          'Commands:\n' +
          '/status — system status\n' +
          '/compact — summarize history to save tokens\n' +
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

      case '/compact': {
        const conv = await this.loadConversation(userId);
        const msgCount = conv.messages.length;
        if (msgCount === 0) {
          await this.sendMessage(chatId, '💬 Nothing to compact — conversation is empty.');
          break;
        }
        if (msgCount < 4 && !conv.compactedSummary) {
          await this.sendMessage(chatId, `💬 Only ${msgCount} message(s) — not worth compacting yet.`);
          break;
        }
        await this.sendMessage(chatId, `🗜 Compacting ${msgCount} messages…`);
        try {
          const { compactHistory } = await import('../../llm/compaction.js');
          const { llmCall } = await import('../../llm/index.js');
          // Force compaction regardless of threshold by temporarily inflating message count
          const forceConv = { ...conv, messages: [...conv.messages, ...Array(20).fill({ role: 'user', content: '' })] };
          const compacted = await compactHistory(forceConv, this.llmConfig, llmCall);
          // Restore real recent messages (strip the padding we added)
          const realRecent = compacted.messages.filter(m => m.content !== '');
          const result = { compactedSummary: compacted.compactedSummary, messages: realRecent };
          await this.saveConversation(userId, result);
          await this.sendMessage(chatId,
            `✅ Compacted ${msgCount} messages → ${realRecent.length} kept verbatim\n` +
            `📝 Summary: ${(result.compactedSummary ?? '').slice(0, 200)}…`,
          );
        } catch (e) {
          await this.sendMessage(chatId, `⚠️ Compaction failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }

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
            db.prepare("UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by user' WHERE id = ? AND status IN ('proposed', 'awaiting_approval')").run(arg);
            await this.sendMessage(chatId, `🚫 Proposal ${arg.slice(-8)} cancelled.`);
          } else {
            // Cancel all pending
            const result = db.prepare("UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by user' WHERE status IN ('proposed', 'awaiting_approval')").run();
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
            "SELECT id, context_summary, plan, created_at FROM proposals WHERE status IN ('proposed', 'awaiting_approval') ORDER BY created_at DESC LIMIT 10"
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

      case '/tasks': {
        try {
          const { getDb } = await import('../../db/index.js');
          const db = getDb();
          const rows = db.prepare(
            "SELECT id, title, status, partner_name, message_url, detected_at FROM tasks WHERE status IN ('open','in_progress','done_inferred') ORDER BY detected_at DESC LIMIT 15"
          ).all() as Array<{ id: string; title: string; status: string; partner_name: string | null; message_url: string | null; detected_at: number }>;
          if (!rows.length) {
            await this.sendMessage(chatId, '✅ No open tasks.');
          } else {
            const list = rows.map(r => {
              const partner = r.partner_name ? ` _${r.partner_name}_` : '';
              const link = r.message_url ? `\n  [↗ source](${r.message_url})` : '';
              return `• \`${r.id.slice(-6)}\` ${r.title.slice(0, 80)}${partner}${link}\n  /done_${r.id.slice(-6)}`;
            }).join('\n\n');
            await this.sendMessage(chatId, `📋 *Open tasks (${rows.length}):*\n\n${list}`);
          }
        } catch (e) {
          await this.sendMessage(chatId, `⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }

      case '/done': {
        try {
          const { getDb } = await import('../../db/index.js');
          const db = getDb();
          const now = Date.now();
          if (arg === 'all') {
            const result = db.prepare(
              "UPDATE tasks SET status = 'completed', completed_at = ? WHERE status IN ('open','in_progress')"
            ).run(now) as { changes: number };
            await this.sendMessage(chatId, `✅ Marked *${result.changes}* tasks as completed.`);
          } else if (arg) {
            const row = db.prepare(
              "SELECT id, title FROM tasks WHERE id LIKE ? AND status IN ('open','in_progress') LIMIT 1"
            ).get(`%${arg}`) as { id: string; title: string } | null;
            if (!row) {
              await this.sendMessage(chatId, `⚠️ Task \`${arg}\` not found.`);
            } else {
              db.prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(now, row.id);
              await this.sendMessage(chatId, `✅ *${row.title.slice(0, 80)}* marked as done.`);
            }
          } else {
            await this.sendMessage(chatId, '⚠️ Usage: `/done <id>` or `/done all`');
          }
        } catch (e) {
          await this.sendMessage(chatId, `⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }

      case '/add_chat':
      case '/add-chat': {
        if (!this.mtprotoChannel) {
          await this.sendMessage(chatId, '❌ Telegram MTProto listener not running — cannot list dialogs.\nConfigure api_id + api_hash in setup.');
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
        if (!targetId) { await this.sendMessage(chatId, '❌ Usage: /remove_chat <chatId>'); break; }
        if (!this.mtprotoChannel) {
          await this.sendMessage(chatId, '❌ MTProto listener not running.');
          break;
        }
        await this.mtprotoChannel.handleRemoveChat(targetId, (text) => this.sendMessage(chatId, text));
        break;
      }

      // ── Triage management ────────────────────────────────────────────────────
      case '/triage': {
        const { cmdTriage } = await import('./triage-commands.js');
        await cmdTriage(args, t => this.sendMessage(chatId, t));
        break;
      }
      case '/teams': {
        const { cmdTeams } = await import('./triage-commands.js');
        await cmdTeams(t => this.sendMessage(chatId, t));
        break;
      }
      case '/add_team': {
        const { cmdAddTeam } = await import('./triage-commands.js');
        await cmdAddTeam(args, t => this.sendMessage(chatId, t));
        break;
      }
      case '/team': {
        const { cmdTeam } = await import('./triage-commands.js');
        await cmdTeam(args, t => this.sendMessage(chatId, t));
        break;
      }
      case '/remove_team': {
        const { cmdRemoveTeam } = await import('./triage-commands.js');
        await cmdRemoveTeam(args, t => this.sendMessage(chatId, t));
        break;
      }
      case '/team_own': {
        const { cmdTeamOwn } = await import('./triage-commands.js');
        await cmdTeamOwn(args, t => this.sendMessage(chatId, t));
        break;
      }
      case '/add_handle': {
        const { cmdAddHandle } = await import('./triage-commands.js');
        await cmdAddHandle(args, t => this.sendMessage(chatId, t));
        break;
      }
      case '/remove_handle': {
        const { cmdRemoveHandle } = await import('./triage-commands.js');
        await cmdRemoveHandle(args, t => this.sendMessage(chatId, t));
        break;
      }
      case '/add_keyword': {
        const { cmdAddKeyword } = await import('./triage-commands.js');
        await cmdAddKeyword(args, t => this.sendMessage(chatId, t));
        break;
      }
      case '/remove_keyword': {
        const { cmdRemoveKeyword } = await import('./triage-commands.js');
        await cmdRemoveKeyword(args, t => this.sendMessage(chatId, t));
        break;
      }
      case '/my_handles': {
        const { cmdMyHandles } = await import('./triage-commands.js');
        await cmdMyHandles(t => this.sendMessage(chatId, t));
        break;
      }
      case '/add_my_handle': {
        const { cmdAddMyHandle } = await import('./triage-commands.js');
        await cmdAddMyHandle(args, t => this.sendMessage(chatId, t));
        break;
      }
      case '/remove_my_handle': {
        const { cmdRemoveMyHandle } = await import('./triage-commands.js');
        await cmdRemoveMyHandle(args, t => this.sendMessage(chatId, t));
        break;
      }
      case '/whitelist': {
        const { cmdWhitelist } = await import('./triage-commands.js');
        await cmdWhitelist(t => this.sendMessage(chatId, t));
        break;
      }
      case '/add_whitelist': {
        const { cmdAddWhitelist } = await import('./triage-commands.js');
        await cmdAddWhitelist(args, t => this.sendMessage(chatId, t));
        break;
      }
      case '/remove_whitelist': {
        const { cmdRemoveWhitelist } = await import('./triage-commands.js');
        await cmdRemoveWhitelist(args, t => this.sendMessage(chatId, t));
        break;
      }

      case '/sources': {
        const { cmdSources } = await import('./knowledge-commands.js');
        await cmdSources(this.argosConfig ?? (await import('../../config/index.js')).getConfig(), t => this.sendMessage(chatId, t));
        break;
      }
      case '/add_source': {
        const { cmdAddSource } = await import('./knowledge-commands.js');
        await cmdAddSource(args, this.argosConfig ?? (await import('../../config/index.js')).getConfig(), t => this.sendMessage(chatId, t));
        break;
      }
      case '/remove_source': {
        const { cmdRemoveSource } = await import('./knowledge-commands.js');
        await cmdRemoveSource(args, this.argosConfig ?? (await import('../../config/index.js')).getConfig(), t => this.sendMessage(chatId, t));
        break;
      }
      case '/refresh_sources': {
        const { cmdRefreshSources } = await import('./knowledge-commands.js');
        await cmdRefreshSources(this.argosConfig ?? (await import('../../config/index.js')).getConfig(), t => this.sendMessage(chatId, t));
        break;
      }

      case '/help':
        await this.sendMessage(chatId,
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
          '*Système*\n' +
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

  /** Detect task completion signals in owner chat messages and update DB immediately. */
  private async detectAndCompleteTasksFromChat(text: string): Promise<void> {
    try {
      const { getDb } = await import('../../db/index.js');
      const db = getDb();
      const openTasks = db.prepare(
        "SELECT id, title FROM tasks WHERE status IN ('open','in_progress') ORDER BY detected_at DESC LIMIT 20"
      ).all() as Array<{ id: string; title: string }>;
      if (!openTasks.length) return;

      const { llmCall, extractJson } = await import('../../llm/index.js');
      const taskList = openTasks.map(t => `[${t.id}] ${t.title}`).join('\n');

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
        if (!openTasks.some(t => t.id === taskId)) continue;
        db.prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(now, taskId);
        log.info(`Task completed by owner via Telegram chat: ${taskId} — ${result.reasoning?.slice(0, 80)}`);
      }
    } catch (e) {
      log.warn(`Task completion detection failed: ${(e as Error).message}`);
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

    // Fetch relevant memories (past conversations, facts) — context docs excluded (on-demand via semantic_search)
    let memoryContext = '';
    try {
      const { search } = await import('../../memory/store.js');
      const memories = search({ query: text, limit: 5 });
      const nonContext = memories.filter(m => String(m.category) !== 'context');
      if (nonContext.length > 0) {
        memoryContext = '\n\n---\n## Relevant memories:\n' +
          nonContext.map(m => `- [${m.category}] ${m.content}`).join('\n');
      }
    } catch { /* memory not initialized */ }

    // Build messages with compaction context
    const messages = buildMessagesWithCompaction(systemPrompt, conv, memoryContext);

    // Call LLM with tool loop (builtin tools + MCP tools)
    const { BUILTIN_TOOLS, executeBuiltinTool } = await import('../../llm/builtin-tools.js');
    const { runToolLoop } = await import('../../llm/tool-loop.js');
    const { callAnthropicBearerRaw } = await import('../../llm/index.js');
    const { getMcpTools, executeMcpToolSafe } = await import('../../mcp/client.js');

    // Merge builtin + MCP tools — exclude notion-mcp (use notion_* builtins instead)
    const allTools = [...BUILTIN_TOOLS, ...getMcpTools().filter(t => !t.name.startsWith('mcp_notion-mcp_'))];
    const combinedExecutor = async (name: string, input: Record<string, unknown>) => {
      if (name.startsWith('mcp_')) return executeMcpToolSafe(name, input);
      return executeBuiltinTool(name, input);
    };

    const chatId = this.lastChatId!;

    // ── Streaming state ────────────────────────────────────────────────────────
    let statusMsgId: number | null = null;   // tool-use status bubble
    let streamMsgId: number | null = null;   // live response bubble
    let accText = '';
    let lastEditMs = 0;
    const STREAM_THROTTLE = 900; // ms between Telegram edits (rate limit safety)

    const sendOrEdit = async (msgId: number | null, text: string, markdown = false): Promise<number> => {
      try {
        if (msgId) {
          await this.api('editMessageText', {
            chat_id: chatId, message_id: msgId, text,
            ...(markdown && { parse_mode: 'Markdown' }),
          }).catch(() => {});
          return msgId;
        }
        const sent = await this.api('sendMessage', {
          chat_id: chatId, text,
          ...(markdown && { parse_mode: 'Markdown' }),
        }) as { result: { message_id: number } };
        return sent.result.message_id;
      } catch { return msgId ?? 0; }
    };

    const toolEmoji: Record<string, string> = {
      web_search: '🔍', fetch_url: '🌐', memory_search: '🧠', memory_store: '💾',
      read_file: '📄', write_file: '✏️', current_time: '🕐', spawn_agent: '🤖',
      semantic_search: '🔎', create_proposal: '📋', list_knowledge: '📚',
    };

    const onEvent = async (event: import('../../llm/tool-loop.js').ToolLoopEvent) => {
      if (event.type === 'tool_call') {
        const emoji = toolEmoji[event.name] ?? '🔧';
        const hint = event.name === 'web_search'
          ? ` _${String((event.input as Record<string,unknown>).query ?? '').slice(0, 50)}_`
          : '';
        // Delete streaming bubble if open — switch to tool status
        if (streamMsgId) {
          await this.api('deleteMessage', { chat_id: chatId, message_id: streamMsgId }).catch(() => {});
          streamMsgId = null; accText = '';
        }
        statusMsgId = await sendOrEdit(statusMsgId, `${emoji} *${event.name}*${hint}…`, true);
      } else if (event.type === 'tool_result') {
        if (event.error) statusMsgId = await sendOrEdit(statusMsgId, `⚠️ *${event.name}* failed`, true);
      } else if (event.type === 'text_chunk') {
        accText += event.text;
        const now = Date.now();
        if (now - lastEditMs > STREAM_THROTTLE) {
          if (!streamMsgId) {
            // Hide tool status while streaming response
            if (statusMsgId) {
              await this.api('deleteMessage', { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
              statusMsgId = null;
            }
            const sent = await this.api('sendMessage', { chat_id: chatId, text: accText + ' ▌' }) as { result: { message_id: number } };
            streamMsgId = sent.result.message_id;
          } else {
            await this.api('editMessageText', { chat_id: chatId, message_id: streamMsgId, text: accText + ' ▌' }).catch(() => {});
          }
          lastEditMs = now;
        }
      }
    };

    let response: { content: string; inputTokens?: number; outputTokens?: number };

    const { callAnthropicBearerRaw: _bearerRaw } = await import('../../llm/index.js');
    const providerRaw = this.llmConfig.authMode === 'bearer'
      ? _bearerRaw
      : async (cfg: import('../../llm/index.js').LLMConfig, body: Record<string, unknown>, onDelta?: (d: string) => void) => {
          // OpenAI-compat raw (Gemini, etc.) — stream via fetch
          const { streamLlmResponse } = await import('../../llm/index.js');
          // Build minimal messages from body
          const msgs = body.messages as import('../../llm/index.js').LLMMessage[];
          const sys = body.system as string | undefined;
          const allMsgs = sys ? [{ role: 'system' as const, content: sys }, ...msgs] : msgs;
          let fullText = '';
          const toolBlocks: Array<{ type: string; id: string; name: string; input: Record<string, unknown> }> = [];
          // For OpenAI-compat we can't do tool use in streaming easily — use llmCall
          const { llmCall: _lc } = await import('../../llm/index.js');
          const r = await _lc(cfg, allMsgs);
          if (onDelta && r.content) onDelta(r.content);
          fullText = r.content;
          void toolBlocks;
          return {
            content: [{ type: 'text', text: fullText }],
            stop_reason: 'end_turn',
            usage: { input_tokens: r.inputTokens ?? 0, output_tokens: r.outputTokens ?? 0 },
            model: cfg.model,
          };
        };

    response = await runToolLoop(
      this.llmConfig, systemPrompt, messages,
      allTools, combinedExecutor, providerRaw, onEvent,
    );

    // Delete only the status/tool bubble (not the stream bubble — we'll edit it in place)
    if (statusMsgId) await this.api('deleteMessage', { chat_id: chatId, message_id: statusMsgId }).catch(() => {});

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

    // Token footer (debug info)
    const inTok  = (response as { inputTokens?: number }).inputTokens;
    const outTok = (response as { outputTokens?: number }).outputTokens;
    const footer = inTok != null ? `\n\n_${inTok}↑ ${outTok}↓ tokens_` : '';

    const displayContent = finalContent + footer;

    // Final render: edit stream bubble in place (no flicker) or send fresh if no stream bubble
    if (streamMsgId) {
      // Try Markdown first; fall back to plain edit (NOT sendMessage — avoid duplicate)
      const edited = await this.api('editMessageText', {
        chat_id: chatId,
        message_id: streamMsgId,
        text: displayContent,
        parse_mode: 'Markdown',
      }).catch(() => null) ??
      await this.api('editMessageText', {
        chat_id: chatId,
        message_id: streamMsgId,
        text: displayContent,
      }).catch(() => null);
      // Only send fresh if both edits failed (e.g. message deleted by user)
      if (!edited) await this.sendMessage(chatId, displayContent);
    } else {
      await this.sendMessage(chatId, displayContent);
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
      const anonConfig = this.argosConfig?.anonymizer ?? { mode: 'regex' as const, bucketAmounts: true, anonymizeCryptoAddresses: false, knownPersons: [], customPatterns: [] };
      const anonymizer = getAnonymizer(anonConfig);

      // Anonymize both sides before sending to LLM — never expose raw PII/addresses
      const anonUser      = anonymizer.anonymize(userMsg.slice(0, 500)).text;
      const anonAssistant = anonymizer.anonymize(assistantMsg.slice(0, 500)).text;

      // Quick check: is this worth memorizing?
      const check = await llmCall(this.llmConfig, [
        { role: 'system', content: `You decide if a conversation exchange contains information worth remembering long-term.
Output ONLY a JSON object: { "memorize": true/false, "summary": "one-line summary if true", "category": "preference|fact|task|decision|context" }
Only memorize: user preferences, important facts, decisions made, task outcomes. NOT: greetings, small talk, questions without answers.` },
        { role: 'user', content: `User said: "${anonUser}"\nAssistant replied: "${anonAssistant}"` },
      ]);

      const parsed = JSON.parse(check.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      if (parsed.memorize && parsed.summary) {
        const { storeQuick } = await import('../../memory/store.js');
        storeQuick(parsed.summary, parsed.category ?? 'general', [`user:${userId}`]);
        log.debug(`Auto-memorized: ${parsed.summary}`);
      }
    } catch { /* non-critical */ }
  }

  async sendMessageWithKeyboard(chatId: string, text: string, keyboard: TgInlineKeyboard): Promise<void> {
    await this.api('sendMessage', {
      chat_id:      chatId,
      text,
      parse_mode:   'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    });
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
        await this.api('sendMessage', { chat_id: chatId, text: chunk });
      });
    }

    // Store notifications sent to the owner in conversation history
    // so the bot has full context when the owner replies ("c'est bon je l'ai fait")
    const approvalChatId = this.allowedUsers.size === 1
      ? [...this.allowedUsers][0]
      : chatId;
    if (chatId === approvalChatId) {
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
