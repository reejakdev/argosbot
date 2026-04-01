/**
 * Email channel — IMAP ingestion.
 *
 * Monitors an IMAP mailbox for new messages.
 * Supports Gmail (App Password), Outlook, and any standard IMAP server.
 *
 * Reads only:
 *   - Unread messages in the configured mailbox (default: INBOX)
 *   - Marks messages as read after processing (does NOT delete)
 *   - Polls every 60s + listens for IDLE push when supported
 *
 * What gets extracted:
 *   - From name + address
 *   - Subject
 *   - Plain text body (HTML stripped)
 *   - Date
 *
 * Privacy: full body goes through anonymizer before any LLM call.
 */

import { createLogger } from '../../logger.js';
import type { Channel } from './registry.js';
import type { RawMessage } from '../../types.js';

const log = createLogger('email');

// ─── Email channel ────────────────────────────────────────────────────────────

export interface EmailConfig {
  host:     string;    // imap.gmail.com
  port:     number;    // 993
  user:     string;    // you@gmail.com
  password: string;    // App Password or regular password
  mailbox:  string;    // INBOX
  tls:      boolean;   // true for port 993
  pollMs:   number;    // polling interval (default: 60000)
}

export class EmailChannel implements Channel {
  readonly name = 'email';

  private config: EmailConfig;
  private client: unknown = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private onMessageCb: ((msg: RawMessage) => Promise<void>) | null = null;
  private running = false;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000; // 5 min cap

  constructor(config: EmailConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: RawMessage) => Promise<void>): void {
    this.onMessageCb = handler;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
    await this.poll();    // immediate first fetch
    this.schedulePoll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.client) {
      try {
        await (this.client as { logout: () => Promise<void> }).logout();
      } catch {}
      this.client = null;
    }
    log.info('Email channel stopped');
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    try {
      const { ImapFlow } = await import('imapflow').catch(() => ({ ImapFlow: null }));
      if (!ImapFlow) {
        log.warn('imapflow not installed. Run: npm install imapflow');
        return;
      }

      this.client = new ImapFlow({
        host:   this.config.host,
        port:   this.config.port,
        secure: this.config.tls,
        auth: {
          user: this.config.user,
          pass: this.config.password,
        },
        logger: false,
      });

      await (this.client as { connect: () => Promise<void> }).connect();
      log.info(`Email connected to ${this.config.host} as ${this.config.user}`);
      this.reconnectAttempts = 0; // reset on successful connection
    } catch (e) {
      log.error('Email connect failed', e);
      this.client = null;
      throw e; // propagate so start() / reconnect() knows
    }
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(async () => {
      await this.poll();
      this.schedulePoll();
    }, this.config.pollMs);
  }

  private async poll(): Promise<void> {
    if (!this.client || !this.onMessageCb) return;

    try {
      const c = this.client as {
        getMailboxLock: (m: string) => Promise<{ release: () => void }>;
        fetch: (range: string, opts: object) => AsyncIterable<unknown>;
        messageFlagsAdd: (uid: string, flags: string[], opts: object) => Promise<void>;
      };

      const lock = await c.getMailboxLock(this.config.mailbox);

      try {
        const messages: unknown[] = [];
        for await (const msg of c.fetch('1:*', {
          envelope: true,
          bodyParts: ['text/plain', 'text'],
          flags: true,
        })) {
          const m = msg as {
            flags: Set<string>;
            envelope: {
              from?: Array<{ name?: string; address?: string }>;
              subject?: string;
              date?: Date;
              messageId?: string;
            };
            bodyParts?: Map<string, Buffer>;
            uid: number;
          };

          // Only process unread
          if (m.flags.has('\\Seen')) continue;
          messages.push(m);
        }

        for (const msg of messages) {
          const m = msg as typeof messages[0] & {
            flags: Set<string>;
            envelope: {
              from?: Array<{ name?: string; address?: string }>;
              subject?: string;
              date?: Date;
              messageId?: string;
            };
            bodyParts?: Map<string, Buffer>;
            uid: number;
          };

          await this.processEmail(m);

          // Mark as read
          await c.messageFlagsAdd(String(m.uid), ['\\Seen'], { uid: true });
        }
      } finally {
        lock.release();
      }
    } catch (e) {
      log.error('Email poll failed', e);
      this.client = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectAttempts++;
    // Exponential backoff: 2s, 4s, 8s … capped at 5 min
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      EmailChannel.MAX_RECONNECT_DELAY_MS,
    );
    log.warn(`Email reconnect attempt ${this.reconnectAttempts} in ${Math.round(delay / 1000)}s`);
    setTimeout(async () => {
      if (!this.running) return;
      try {
        await this.connect();
        await this.poll();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private async processEmail(msg: {
    envelope: { from?: Array<{ name?: string; address?: string }>; subject?: string; date?: Date; messageId?: string };
    bodyParts?: Map<string, Buffer>;
    uid: number;
  }): Promise<void> {
    if (!this.onMessageCb) return;

    const from = msg.envelope.from?.[0];
    const senderName = from?.name ?? from?.address ?? 'Unknown';
    const subject    = msg.envelope.subject ?? '(no subject)';
    const date       = msg.envelope.date ?? new Date();
    const msgId      = msg.envelope.messageId ?? `email_${msg.uid}`;

    // Extract plain text body
    const bodyBuffer = msg.bodyParts?.get('text/plain') ?? msg.bodyParts?.get('text');
    const rawBody    = bodyBuffer?.toString('utf8') ?? '';
    const body       = stripHtml(rawBody).trim();

    if (!body && !subject) return;

    const content = `Subject: ${subject}\nFrom: ${senderName}\n\n${body}`.slice(0, 4000);

    const raw: RawMessage = {
      id:          `email_${msg.uid}`,
      channel:     'email',
      source:      'email' as const,
      chatId:      from?.address ?? 'unknown',
      chatName:    senderName,    // sender name as "chat" label
      chatType:    'dm',          // email is always 1:1 by nature
      partnerName: from?.address ?? undefined,
      senderName,
      senderId:    from?.address,
      content,
      links:       extractLinks(content),
      receivedAt:  Date.now(),
      timestamp:   date.getTime(),
      meta: {
        email_uid:        msg.uid,
        email_message_id: msgId,
        email_subject:    subject,
      },
    };

    log.info(`Processing email from ${senderName}: ${subject.slice(0, 60)}`);

    try {
      await this.onMessageCb(raw);
    } catch (e) {
      log.error('Email processing failed', e);
    }
  }
}

// ─── Link extraction ──────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

function extractLinks(text: string): string[] {
  return [...new Set(text.match(URL_REGEX) ?? [])];
}

// ─── HTML stripping ────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createEmailChannel(): EmailChannel | null {
  const host     = process.env.EMAIL_IMAP_HOST;
  const portStr  = process.env.EMAIL_IMAP_PORT;
  const user     = process.env.EMAIL_IMAP_USER;
  const password = process.env.EMAIL_IMAP_PASSWORD;

  if (!host || !user || !password) {
    log.warn('Email channel not configured — set EMAIL_IMAP_HOST, EMAIL_IMAP_USER, EMAIL_IMAP_PASSWORD in .env');
    return null;
  }

  return new EmailChannel({
    host,
    port:    parseInt(portStr ?? '993', 10),
    user,
    password,
    mailbox: process.env.EMAIL_MAILBOX ?? 'INBOX',
    tls:     (portStr ?? '993') === '993',
    pollMs:  60_000,
  });
}
