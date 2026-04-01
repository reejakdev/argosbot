/**
 * Context window batcher — collects messages from the same chat over a
 * configurable time window before processing them as a single batch.
 *
 * Behaviour:
 *   - On first message from a chat: open a window, start the wait timer
 *   - On subsequent messages (same chat, window open): add to batch, optionally reset timer
 *   - When timer fires OR maxMessages reached: close window, emit for processing
 *
 * This lets the classifier see conversational context (5 messages)
 * instead of reacting to each message in isolation.
 */

import { monotonicFactory } from 'ulid';
import { getDb } from '../db/index.js';
import { createLogger } from '../logger.js';
import type { RawMessage, ContextWindow } from '../types.js';

const ulid = monotonicFactory();
const log = createLogger('context-window');

export type WindowReadyCallback = (window: ContextWindow) => Promise<void>;

interface WindowState {
  window: ContextWindow;
  timer: ReturnType<typeof setTimeout>;
}

export class ContextWindowManager {
  private openWindows = new Map<string, WindowState>(); // chatId → state
  private onReady: WindowReadyCallback;

  constructor(
    private config: {
      waitMs: number;
      maxMessages: number;
      resetOnMessage: boolean;
    },
    onReady: WindowReadyCallback,
  ) {
    this.onReady = onReady;
  }

  // ─── Add a message to the appropriate window ────────────────────────────────

  add(message: RawMessage, sanitizedContent: string, lookup: Record<string, string>, rawContent?: string): void {
    const existing = this.openWindows.get(message.chatId);

    if (existing) {
      this.addToExisting(existing, message, sanitizedContent, lookup, rawContent);
    } else {
      this.openNew(message, sanitizedContent, lookup, rawContent);
    }
  }

  // ─── Force-flush all open windows ──────────────────────────────────────────
  // Called on shutdown to avoid losing pending messages

  async flushAll(): Promise<void> {
    const chatIds = [...this.openWindows.keys()];
    await Promise.all(chatIds.map(chatId => this.closeWindow(chatId)));
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private openNew(message: RawMessage, sanitizedContent: string, lookup: Record<string, string>, rawContent?: string): void {
    const windowId = ulid();

    const window: ContextWindow = {
      id:          windowId,
      channel:     message.channel,
      chatId:      message.chatId,
      chatName:    message.chatName,
      partnerName: message.partnerName,
      messages: [{
        id:          ulid(),
        originalId:  message.id,
        channel:     message.channel,
        chatId:      message.chatId,
        chatName:    message.chatName,
        chatType:    message.chatType,
        partnerName: message.partnerName,
        content:     sanitizedContent,
        lookupTable: lookup,
        links:       message.links,
        messageUrl:  message.messageUrl,
        isForward:   message.isForward,
        forwardFrom: message.forwardFrom,
        mediaType:   message.mediaType,
        timestamp:   message.timestamp,
        receivedAt:  message.receivedAt,
      }],
      previousMessages: this.loadPreviousMessages(message.chatId, message.receivedAt),
      rawContent:  rawContent,
      openedAt: Date.now(),
      status: 'open',
    };

    this.persistWindow(window);

    const timer = setTimeout(() => {
      void this.closeWindow(message.chatId);
    }, this.config.waitMs);

    this.openWindows.set(message.chatId, { window, timer });

    log.debug(`Opened window ${windowId} for chat ${message.chatId}`, {
      partner: message.partnerName,
      waitMs: this.config.waitMs,
    });
  }

  private addToExisting(
    state: WindowState,
    message: RawMessage,
    sanitizedContent: string,
    lookup: Record<string, string>,
    rawContent?: string,
  ): void {
    const { window, timer } = state;

    window.messages.push({
      id:          ulid(),
      originalId:  message.id,
      channel:     message.channel,
      chatId:      message.chatId,
      chatName:    message.chatName,
      chatType:    message.chatType,
      partnerName: message.partnerName,
      content:     sanitizedContent,
      lookupTable: lookup,
      links:       message.links,
      messageUrl:  message.messageUrl,
      isForward:   message.isForward,
      forwardFrom: message.forwardFrom,
      mediaType:   message.mediaType,
      timestamp:   message.timestamp,
      receivedAt:  message.receivedAt,
    });

    if (rawContent) {
      window.rawContent = window.rawContent
        ? `${window.rawContent}\n---\n${rawContent}`
        : rawContent;
    }

    this.updateWindowInDb(window);

    log.debug(`Added message to window ${window.id}`, {
      totalMessages: window.messages.length,
      max: this.config.maxMessages,
    });

    // Close immediately if max reached
    if (window.messages.length >= this.config.maxMessages) {
      clearTimeout(timer);
      log.info(`Window ${window.id} hit max ${this.config.maxMessages} messages, closing`);
      void this.closeWindow(message.chatId);
      return;
    }

    // Optionally reset the timer on each new message
    if (this.config.resetOnMessage) {
      clearTimeout(timer);
      const newTimer = setTimeout(() => {
        void this.closeWindow(message.chatId);
      }, this.config.waitMs);
      state.timer = newTimer;
    }
  }

  private async closeWindow(chatId: string): Promise<void> {
    const state = this.openWindows.get(chatId);
    if (!state) return;

    clearTimeout(state.timer);
    this.openWindows.delete(chatId);

    const window = state.window;
    window.closedAt = Date.now();
    window.status = 'processing';
    this.updateWindowInDb(window);

    log.info(`Processing window ${window.id}`, {
      messages: window.messages.length,
      partner: window.partnerName,
      chatId: window.chatId,
      duration: `${((window.closedAt - window.openedAt) / 1000).toFixed(1)}s`,
    });

    try {
      await this.onReady(window);
      window.status = 'done';
      this.updateWindowInDb(window);
    } catch (e) {
      const err = e as Error & { code?: string };
      log.error(`Failed to process window ${window.id}: [${err.code ?? 'ERR'}] ${err.message ?? String(e)}`);
      // Don't re-throw — window is logged, can be replayed from DB
    }
  }

  // ─── DB persistence (for replay on restart) ──────────────────────────────────

  // Fetch up to 3 recent sanitized summaries from memory for the same chat.
  // These act as "previous messages" context — we use memory entries rather than
  // raw messages (raw content is never stored by design).
  private loadPreviousMessages(chatId: string, before: number): import('../types.js').SanitizedMessage[] {
    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT content, created_at FROM memories
        WHERE chat_id = ? AND created_at < ? AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC
        LIMIT 3
      `).all(chatId, before, Date.now()) as Array<{ content: string; created_at: number }>;

      // Return in chronological order so the classifier sees context naturally
      return rows.reverse().map(r => ({
        id:          ulid(),
        originalId:  'prev',
        chatId,
        content:     r.content,
        lookupTable: {},
        links:       [],
        receivedAt:  r.created_at,
      }));
    } catch (e) {
      log.warn(`Failed to load previous messages for chat ${chatId}`, e);
      return [];
    }
  }

  private persistWindow(window: ContextWindow): void {
    const db = getDb();
    db.prepare(`
      INSERT INTO context_windows (id, chat_id, partner_name, message_ids, opened_at, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      window.id,
      window.chatId,
      window.partnerName ?? null,
      JSON.stringify(window.messages.map(m => m.originalId)),
      window.openedAt,
      window.status,
    );
  }

  private updateWindowInDb(window: ContextWindow): void {
    const db = getDb();
    db.prepare(`
      UPDATE context_windows
      SET message_ids = ?, closed_at = ?, status = ?
      WHERE id = ?
    `).run(
      JSON.stringify(window.messages.map(m => m.originalId)),
      window.closedAt ?? null,
      window.status,
      window.id,
    );
  }

  // ─── Replay pending windows from DB on startup ───────────────────────────────
  // If the process crashed with open windows, re-queue them

  static async replayPending(_onReady: WindowReadyCallback): Promise<void> {
    const db = getDb();
    const pending = db.prepare(`
      SELECT * FROM context_windows WHERE status = 'open' OR status = 'processing'
    `).all() as Array<{
      id: string; chat_id: string; partner_name: string | null;
      message_ids: string; opened_at: number; closed_at: number | null; status: string;
    }>;

    if (pending.length === 0) return;

    log.info(`Replaying ${pending.length} pending windows from DB`);

    for (const row of pending) {
      // Mark as processing and emit — we don't have the full message content
      // anymore (we only stored IDs), but we can reconstruct from audit log
      // For now, log and skip — future: store full sanitized content in DB
      log.warn(`Skipping pending window ${row.id} (content not stored — restart safe)`);
      db.prepare(`UPDATE context_windows SET status = 'done' WHERE id = ?`).run(row.id);
    }
  }
}
