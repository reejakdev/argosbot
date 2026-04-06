/**
 * TOTP 2FA — Time-based One-Time Password
 *
 * Uses otpauth library for TOTP generation/verification
 * and qrcode for QR code generation (scannable by Google/Microsoft Authenticator).
 */

import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import { getDb } from '../db/index.js';
import { createLogger } from '../logger.js';
import crypto from 'node:crypto';

const log = createLogger('totp');

// ─── DB setup ─────────────────────────────────────────────────────────────────

export function ensureTotpTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS totp_secrets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT NOT NULL DEFAULT 'default',
      secret      TEXT NOT NULL,
      verified    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token       TEXT PRIMARY KEY,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT NOT NULL,
      method      TEXT NOT NULL DEFAULT 'totp'
    );
  `);
}

// ─── TOTP management ──────────────────────────────────────────────────────────

export function hasTotpConfigured(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as n FROM totp_secrets WHERE verified = 1').get() as {
    n: number;
  };
  return row.n > 0;
}

export function generateTotpSecret(label = 'Argos'): { secret: string; uri: string } {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: 'Argos',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });

  return {
    secret: secret.base32,
    uri: totp.toString(),
  };
}

export async function generateQRCode(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, {
    width: 256,
    margin: 2,
    color: { dark: '#e2e2f0', light: '#0a0a0f' },
  });
}

export function storeTotpSecret(secretBase32: string, label = 'default'): number {
  const db = getDb();
  const result = db
    .prepare('INSERT INTO totp_secrets (label, secret) VALUES (?, ?)')
    .run(label, secretBase32);
  return result.lastInsertRowid as number;
}

export function verifyAndActivateTotp(secretId: number, code: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT secret FROM totp_secrets WHERE id = ?').get(secretId) as
    | { secret: string }
    | undefined;
  if (!row) return false;

  const totp = new TOTP({
    issuer: 'Argos',
    label: 'Argos',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(row.secret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return false;

  db.prepare('UPDATE totp_secrets SET verified = 1 WHERE id = ?').run(secretId);
  log.info('TOTP secret verified and activated');
  return true;
}

export function validateTotpCode(code: string): boolean {
  const db = getDb();
  const rows = db.prepare('SELECT secret FROM totp_secrets WHERE verified = 1').all() as Array<{
    secret: string;
  }>;

  for (const row of rows) {
    const totp = new TOTP({
      issuer: 'Argos',
      label: 'Argos',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(row.secret),
    });

    const delta = totp.validate({ token: code, window: 1 });
    if (delta !== null) return true;
  }

  return false;
}

// ─── Session management ───────────────────────────────────────────────────────

const SESSION_TTL_HOURS = 13;

export function createSession(method = 'totp'): string {
  const token = crypto.randomBytes(32).toString('hex');
  const db = getDb();
  const expires = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO auth_sessions (token, expires_at, method) VALUES (?, ?, ?)').run(
    token,
    expires,
    method,
  );
  return token;
}

export function validateSession(token: string): boolean {
  if (!token) return false;
  const db = getDb();
  const row = db.prepare('SELECT expires_at FROM auth_sessions WHERE token = ?').get(token) as
    | { expires_at: string }
    | undefined;
  if (!row) return false;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    return false;
  }
  return true;
}

export function destroySession(token: string): void {
  const db = getDb();
  db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
}

export function pruneExpiredAuthSessions(): void {
  const db = getDb();
  const result = db.prepare("DELETE FROM auth_sessions WHERE expires_at < datetime('now')").run();
  if (result.changes > 0) log.debug(`Pruned ${result.changes} expired auth sessions`);
}
