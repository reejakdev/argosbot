/**
 * TOTP setup script — run once to configure 2FA for the web app.
 *
 * Usage: npm run totp-setup
 *
 * Generates a TOTP secret, prints the otpauth:// URI and the raw base32 secret,
 * then marks it as active in the database. After running this, you can log in
 * at http://localhost:3000 using Google Authenticator / Authenticator app.
 */

import 'dotenv/config';
import { loadConfig, getDataDir } from '../config/index.js';
import { initDb } from '../db/index.js';
import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import crypto from 'node:crypto';

const config = loadConfig();
const db = initDb(getDataDir());

// Ensure TOTP tables exist
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

// Check if TOTP already configured
const existing = db.prepare('SELECT COUNT(*) as n FROM totp_secrets WHERE verified = 1').get() as { n: number };
if (existing.n > 0) {
  console.log('⚠️  TOTP already configured. To reset, delete the totp_secrets table in argos.db.');
  console.log('   Run: sqlite3 ~/.argos/argos.db "DELETE FROM totp_secrets;"');
  process.exit(0);
}

// Generate secret
const secret = new Secret({ size: 20 });
const label = config.owner?.name ?? 'Argos';

const totp = new TOTP({
  issuer: 'Argos',
  label,
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  secret,
});

const uri = totp.toString();
const base32 = secret.base32;

// Store as verified immediately (CLI setup = trusted)
const result = db.prepare("INSERT INTO totp_secrets (label, secret, verified) VALUES (?, ?, 1)").run('default', base32);
const secretId = result.lastInsertRowid;

console.log('\n🔐 Argos TOTP Setup\n');
console.log('Scan this QR code with Google Authenticator / Authy / 1Password:\n');

// Print QR code in terminal
const qrText = await QRCode.toString(uri, { type: 'terminal', small: true });
console.log(qrText);

console.log(`\nOr manually enter this secret in your app:`);
console.log(`  ${base32}\n`);
console.log(`URI: ${uri}\n`);
console.log(`✅ Secret saved to DB (id=${secretId})`);
console.log(`\nNow visit http://localhost:3000 and log in with the 6-digit code from your app.`);
console.log(`Session lasts 13 hours.\n`);

// Also generate a one-time login token valid for 5 minutes so you can access immediately
const token = crypto.randomBytes(32).toString('hex');
const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
db.prepare('INSERT INTO auth_sessions (token, expires_at, method) VALUES (?, ?, ?)').run(token, expires, 'cli-setup');

const port = process.env.WEBAPP_PORT ?? 3000;
console.log(`\n🚀 One-time access token (valid 5 min — open this URL now):`);
console.log(`   http://localhost:${port}/auth/session?token=${token}\n`);
