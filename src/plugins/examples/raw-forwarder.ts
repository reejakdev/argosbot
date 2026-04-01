/**
 * Example plugin — raw-forwarder
 *
 * Demonstrates the Argos plugin pattern:
 *   1. Build a RawMessage with full channel metadata (all standard fields filled).
 *   2. Push it into the core pipeline via the channel registry.
 *
 * This plugin simulates an external data source (e.g. a webhook, a file watcher,
 * or a custom channel adapter) forwarding messages into Argos for classification
 * and planning — without implementing a full channel adapter.
 *
 * Real-world uses:
 *   - Replaying archived messages during development
 *   - Injecting synthetic test messages into the pipeline
 *   - Bridging an unsupported channel (custom webhook → Argos)
 *
 * Usage:
 *   const plugin = new RawForwarderPlugin({ name: 'my-bridge', channel: 'myapp' });
 *   plugin.onBoot?.();
 *   await plugin.forward({ chatId: '-1001234567', content: 'Hello from custom channel' });
 */

import { monotonicFactory } from 'ulid';
import { createLogger } from '../../logger.js';
import type { RawMessage } from '../../types.js';

const ulid = monotonicFactory();
const log   = createLogger('plugin:raw-forwarder');

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal fields required to forward a message. All other RawMessage fields are optional. */
export interface ForwardInput {
  chatId:       string;
  content:      string;
  channel?:     string;   // defaults to plugin.channel
  chatName?:    string;
  chatType?:    RawMessage['chatType'];
  senderId?:    string;
  senderName?:  string;
  partnerName?: string;
  messageUrl?:  string;
  links?:       string[];
  isForward?:   boolean;
  forwardFrom?: string;
  mediaType?:   RawMessage['mediaType'];
  replyToId?:   string;
  threadId?:    string;
  timestamp?:   number;  // original send time — defaults to now
  meta?:        Record<string, unknown>;
}

export interface RawForwarderOptions {
  /** Human label for this forwarder — used in logs and sourceRef */
  name:    string;
  /** Channel identifier written into RawMessage.channel (e.g. 'webhook', 'myapp') */
  channel: string;
  /** Called with each fully-constructed RawMessage before it enters the pipeline */
  onMessage?: (msg: RawMessage) => Promise<void> | void;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export class RawForwarderPlugin {
  readonly name:    string;
  readonly channel: string;

  private readonly onMessage?: RawForwarderOptions['onMessage'];

  constructor(opts: RawForwarderOptions) {
    this.name      = opts.name;
    this.channel   = opts.channel;
    this.onMessage = opts.onMessage;
  }

  /**
   * Forward a message into the pipeline.
   *
   * Constructs a fully-typed RawMessage with all standard channel metadata
   * fields filled, then calls onMessage (if provided) or logs it.
   *
   * In a real integration you would pass the constructed message to
   * your channel registry's ingest function.
   */
  async forward(input: ForwardInput): Promise<RawMessage> {
    const now = Date.now();

    // Build a fully-typed RawMessage — all standard fields populated.
    // Channel adapters (telegram.ts, slack.ts, …) follow exactly this pattern.
    const msg: RawMessage = {
      id:           ulid(),

      // ── Channel identity ────────────────────────────────────────────────
      channel:      input.channel   ?? this.channel,
      source:       (input.channel ?? this.channel) as RawMessage['source'],

      // ── Chat ────────────────────────────────────────────────────────────
      chatId:       input.chatId,
      chatName:     input.chatName,
      chatType:     input.chatType,

      // ── Sender ──────────────────────────────────────────────────────────
      senderId:     input.senderId,
      senderName:   input.senderName,
      partnerName:  input.partnerName,

      // ── Content ─────────────────────────────────────────────────────────
      content:      input.content,
      // anonText is NOT set here — it will be set by the privacy layer later

      // ── Links & media ────────────────────────────────────────────────────
      messageUrl:   input.messageUrl,
      links:        input.links     ?? [],
      isForward:    input.isForward,
      forwardFrom:  input.forwardFrom,
      mediaType:    input.mediaType,

      // ── Threading ────────────────────────────────────────────────────────
      replyToId:    input.replyToId,
      threadId:     input.threadId,

      // ── Timestamps ───────────────────────────────────────────────────────
      receivedAt:   now,
      timestamp:    input.timestamp ?? now,

      // ── Channel-specific extras ──────────────────────────────────────────
      meta:         input.meta,
    };

    log.debug(`[${this.name}] forwarding message`, {
      channel:     msg.channel,
      chatId:      msg.chatId,
      chatName:    msg.chatName,
      chatType:    msg.chatType,
      senderName:  msg.senderName,
      partnerName: msg.partnerName,
      messageUrl:  msg.messageUrl,
      timestamp:   msg.timestamp,
      contentLen:  msg.content.length,
    });

    if (this.onMessage) {
      await this.onMessage(msg);
    }

    return msg;
  }
}

// ─── Standalone helper ────────────────────────────────────────────────────────

/**
 * One-shot helper — build a RawMessage without instantiating the plugin class.
 * Useful for tests and scripts.
 *
 * Example — simulate a Telegram group message:
 *
 *   const msg = buildRawMessage({
 *     channel:     'telegram',
 *     chatId:      '-1001234567890',
 *     chatName:    'Ops Team',
 *     chatType:    'group',
 *     senderId:    '987654321',
 *     senderName:  'Alice',
 *     partnerName: 'ACME Corp',
 *     content:     'Deposit of 500k USDC confirmed on Ethereum',
 *     messageUrl:  'https://t.me/c/1234567890/42',
 *     timestamp:   Date.now() - 5000,
 *     meta:        { telegram_message_id: 42, telegram_chat_id: -1001234567890 },
 *   });
 *
 * When indexing this message to the vector store, pass field1–field4 via chunkText():
 *
 *   chunkText(msg.anonText!, sourceRef, chatName, tags, {
 *     field1: msg.chatId,       // Telegram: chatId for per-channel filtering
 *     field2: msg.chatName,     // Telegram: chatName for display
 *     field3: msg.senderName,   // Telegram: who said it
 *     field4: msg.messageUrl,   // Telegram: permalink back to source
 *   });
 *
 * Then filter by chatId later:
 *
 *   semanticSearch('deposit USDC', config, { field1: '-1001234567890' });
 */
export function buildRawMessage(input: ForwardInput & { channel: string }): RawMessage {
  const now = Date.now();
  return {
    id:          ulid(),
    channel:     input.channel,
    source:      input.channel as RawMessage['source'],
    chatId:      input.chatId,
    chatName:    input.chatName,
    chatType:    input.chatType,
    senderId:    input.senderId,
    senderName:  input.senderName,
    partnerName: input.partnerName,
    content:     input.content,
    messageUrl:  input.messageUrl,
    links:       input.links     ?? [],
    isForward:   input.isForward,
    forwardFrom: input.forwardFrom,
    mediaType:   input.mediaType,
    replyToId:   input.replyToId,
    threadId:    input.threadId,
    receivedAt:  now,
    timestamp:   input.timestamp ?? now,
    meta:        input.meta,
  };
}
