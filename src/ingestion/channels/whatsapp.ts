/**
 * WhatsApp channel — Baileys (WhatsApp Web protocol).
 *
 * Connects as your personal WhatsApp account (not a Business API).
 * First run: shows a QR code in terminal → scan with WhatsApp app.
 * Session persisted to ~/.argos/whatsapp_session/ (multi-file auth).
 *
 * Read-only on partner chats — Argos only writes to the approval chat.
 * Write mode: only when config.readOnly = false AND explicitly triggered.
 */

import path from 'path';
import fs from 'fs';
import { createLogger } from '../../logger.js';
import type { Channel } from './registry.js';
import type { RawMessage } from '../../types.js';

const log = createLogger('whatsapp');

// ─── Types (minimal — avoid importing Baileys types until available) ──────────

interface WAMessage {
  key: { remoteJid?: string; id?: string; fromMe?: boolean };
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
  };
  messageTimestamp?: number | bigint;
  pushName?: string;
}

// ─── WhatsApp channel ─────────────────────────────────────────────────────────

export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp';

  private sock: unknown = null;
  private dataDir: string;
  private onMessageCb: ((msg: RawMessage) => Promise<void>) | null = null;
  private partnerJids: Map<string, string> = new Map(); // jid → partnerName
  private approvalJid: string | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  onMessage(handler: (msg: RawMessage) => Promise<void>): void {
    this.onMessageCb = handler;
  }

  configure(options: {
    partnerJids: Record<string, string>;  // { 'jid@g.us': 'Partner Alpha' }
    approvalJid?: string;                 // JID for approval notifications
  }): void {
    this.partnerJids = new Map(Object.entries(options.partnerJids));
    this.approvalJid = options.approvalJid ?? null;
  }

  async start(): Promise<void> {

    try {
      // Baileys is optional — only load if installed
      const baileys = await import('@whiskeysockets/baileys').catch(() => null);
      if (!baileys) {
        log.warn('WhatsApp (Baileys) not installed. Run: npm install @whiskeysockets/baileys');
        return;
      }

      const {
        makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        fetchLatestBaileysVersion,
      } = baileys;

      const sessionDir = path.join(this.dataDir, 'whatsapp_session');
      fs.mkdirSync(sessionDir, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion();

      log.info(`Starting WhatsApp (Baileys v${version.join('.')})`);

      const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: undefined as any,
        syncFullHistory: false,
      });

      this.sock = sock;

      // Save credentials on update
      sock.ev.on('creds.update', saveCreds);

      // Connection state changes
      sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          log.info('WhatsApp QR code displayed in terminal — scan with WhatsApp app');
          console.log('\n  \x1b[33m▸ Scan this QR code with WhatsApp → Linked Devices → Link a Device\x1b[0m\n');
        }

        if (connection === 'close') {
          const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          const shouldReconnect = code !== DisconnectReason.loggedOut;
          log.warn(`WhatsApp disconnected (code ${code}), reconnecting: ${shouldReconnect}`);
          if (shouldReconnect) {
            setTimeout(() => this.start(), 5000);
          } else {
            log.error('WhatsApp logged out. Delete ~/.argos/whatsapp_session and re-run setup.');
          }
        } else if (connection === 'open') {
          log.info('WhatsApp connected');
        }
      });

      // Incoming messages
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages as WAMessage[]) {
          await this.handleMessage(msg);
        }
      });

    } catch (e) {
      log.error('WhatsApp start failed', e);
    }
  }

  async stop(): Promise<void> {
    if (this.sock) {
      try {
        await (this.sock as { end?: () => void }).end?.();
      } catch {}
      this.sock = null;
    }
    log.info('WhatsApp disconnected');
  }

  // ── Send a message ──────────────────────────────────────────────────────────

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.sock) {
      log.warn('WhatsApp not connected — cannot send message');
      return;
    }
    try {
      await (this.sock as { sendMessage: (j: string, c: { text: string }) => Promise<void> })
        .sendMessage(jid, { text });
    } catch (e) {
      log.error(`WhatsApp send failed to ${jid}`, e);
    }
  }

  async sendToApprovalChat(text: string): Promise<void> {
    if (!this.approvalJid) return;
    await this.sendMessage(this.approvalJid, text);
  }

  // ── Private: process incoming message ──────────────────────────────────────

  private async handleMessage(msg: WAMessage): Promise<void> {
    if (!this.onMessageCb) return;
    if (msg.key.fromMe) return;  // skip our own messages

    const jid = msg.key.remoteJid;
    if (!jid) return;

    // Extract text
    const content =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      msg.message?.imageMessage?.caption;

    if (!content) return;

    // Only process configured partner JIDs (or all if none configured)
    const partnerName = this.partnerJids.get(jid);
    if (this.partnerJids.size > 0 && !partnerName) return;

    const ts = typeof msg.messageTimestamp === 'bigint'
      ? Number(msg.messageTimestamp) * 1000
      : (msg.messageTimestamp ?? Date.now() / 1000) * 1000;

    const raw: RawMessage = {
      id:          `wa_${msg.key.id ?? Date.now()}`,
      channel:     'whatsapp',
      source:      'whatsapp',   // @deprecated — use channel
      chatId:      jid,
      chatName:    partnerName ?? msg.pushName,
      chatType:    resolveWAChatType(jid),
      partnerName: partnerName ?? msg.pushName,
      senderName:  msg.pushName,
      content,
      links:       [],
      receivedAt:  Date.now(),
      timestamp:   ts,
      meta: {
        whatsapp_jid:        jid,
        whatsapp_message_id: msg.key.id,
      },
    };

    try {
      await this.onMessageCb(raw);
    } catch (e) {
      log.error('WhatsApp message processing failed', e);
    }
  }
}

// ─── Chat type ────────────────────────────────────────────────────────────────
// WhatsApp JID format:
//   123456789@s.whatsapp.net  → DM
//   groupId@g.us              → group
//   broadcast@broadcast       → broadcast list

function resolveWAChatType(jid: string): RawMessage['chatType'] {
  if (jid.endsWith('@g.us'))        return 'group';
  if (jid.endsWith('@broadcast'))   return 'channel';
  return 'dm';
}

export function createWhatsAppChannel(dataDir: string): WhatsAppChannel {
  return new WhatsAppChannel(dataDir);
}
