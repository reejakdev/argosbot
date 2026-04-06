/**
 * Email send worker — sends emails via SMTP after owner approval.
 *
 * Supports:
 *   - Gmail (smtp.gmail.com:587 + App Password)
 *   - Outlook / Office 365 (smtp.office365.com:587)
 *   - Proton Mail Bridge (127.0.0.1:1025)
 *   - Any generic SMTP server
 *
 * Read-only mode (config.readOnly = true):
 *   Returns a formatted draft — nothing is sent.
 *
 * Write mode (config.readOnly = false, after approval):
 *   Sends via SMTP using nodemailer.
 *
 * Config (config.json → smtp):
 *   host, port, secure, user, password, from, fromName
 */

import { createLogger } from '../logger.js';
import type { Config } from '../config/schema.js';
import type { WorkerResult } from './index.js';

const log = createLogger('email-send');

// ─── Email send worker ────────────────────────────────────────────────────────

export class EmailSendWorker {
  constructor(private config: Config) {}

  async send(input: Record<string, unknown>): Promise<WorkerResult> {
    const to = this.parseRecipients(input.to);
    const cc = this.parseRecipients(input.cc);
    const subject = String(input.subject ?? '(no subject)').trim();
    const body = String(input.body ?? '').trim();
    const replyTo = input.reply_to as string | undefined;

    if (!to.length) {
      return { success: false, dryRun: false, output: 'send_email: "to" is required' };
    }
    if (!body) {
      return { success: false, dryRun: false, output: 'send_email: "body" is required' };
    }

    // ── Draft mode ─────────────────────────────────────────────────────────────
    if (this.config.readOnly || !this.config.smtp) {
      const reason = !this.config.smtp ? '(SMTP not configured)' : '(read-only)';
      const preview = [
        `📧 [DRAFT EMAIL] ${reason}`,
        `To: ${to.join(', ')}`,
        cc.length ? `CC: ${cc.join(', ')}` : null,
        `Subject: ${subject}`,
        ``,
        body.slice(0, 500),
        body.length > 500 ? `…(${body.length} chars total)` : null,
      ]
        .filter(Boolean)
        .join('\n');

      return { success: true, dryRun: true, output: preview, data: { to, cc, subject, body } };
    }

    // ── Send ───────────────────────────────────────────────────────────────────
    try {
      const nodemailer = await import('nodemailer').catch(() => null);
      if (!nodemailer) {
        return {
          success: false,
          dryRun: false,
          output: 'nodemailer not installed. Run: npm install nodemailer',
        };
      }

      const smtp = this.config.smtp;
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.password },
      });

      const fromAddress = smtp.from ?? smtp.user;
      const fromHeader = smtp.fromName ? `${smtp.fromName} <${fromAddress}>` : fromAddress;

      const info = await transporter.sendMail({
        from: fromHeader,
        to: to.join(', '),
        cc: cc.length ? cc.join(', ') : undefined,
        subject,
        text: body,
        // Basic HTML — line breaks preserved
        html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(body)}</pre>`,
        ...(replyTo ? { inReplyTo: replyTo, references: replyTo } : {}),
      });

      log.info(`Email sent to ${to.join(', ')} — messageId: ${info.messageId}`);

      return {
        success: true,
        dryRun: false,
        output: `✅ Email sent to ${to.join(', ')} — subject: "${subject}"`,
        data: { messageId: info.messageId, to, cc, subject },
      };
    } catch (e) {
      log.error('Email send failed', e);
      return {
        success: false,
        dryRun: false,
        output: `❌ Email send failed: ${(e as Error).message}`,
      };
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private parseRecipients(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === 'string')
      return value
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
    return [];
  }
}

// ─── HTML escaping ────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
