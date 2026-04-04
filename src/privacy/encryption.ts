/**
 * AES-256-GCM message encryption for at-rest storage.
 *
 * Key lifecycle:
 *   - Stored at ~/.argos/message.key (32 random bytes, chmod 0o600)
 *   - Generated automatically on first use if absent
 *   - Never goes in config.json or env vars — keyfile only
 *
 * Wire format (stored as base64 in encrypted_content):
 *   <12-byte IV> || <16-byte GCM auth tag> || <ciphertext>
 *   All concatenated, then base64url-encoded.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../logger.js';

const log = createLogger('encryption');

const KEY_PATH = join(homedir(), '.argos', 'message.key');
const IV_LEN   = 12;   // 96-bit IV for GCM
const TAG_LEN  = 16;   // 128-bit auth tag

let _key: Buffer | null = null;

// ─── Key management ───────────────────────────────────────────────────────────

/**
 * Loads the encryption key, generating it on first use.
 * Returns null if encryption is disabled (encryptMessages: false).
 */
export function loadEncryptionKey(): Buffer {
  if (_key) return _key;

  if (existsSync(KEY_PATH)) {
    const raw = readFileSync(KEY_PATH);
    if (raw.length !== 32) throw new Error(`message.key must be 32 bytes, got ${raw.length}`);
    _key = raw;
    log.debug('Encryption key loaded from ~/.argos/message.key');
  } else {
    // Generate + persist
    const dir = join(homedir(), '.argos');
    mkdirSync(dir, { recursive: true });
    _key = randomBytes(32);
    writeFileSync(KEY_PATH, _key, { mode: 0o600 });
    try { chmodSync(KEY_PATH, 0o600); } catch {}
    log.info('Generated new encryption key at ~/.argos/message.key — back this up securely');
  }

  return _key;
}

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────────

/**
 * Encrypts plaintext with AES-256-GCM.
 * Returns a base64url string: IV || authTag || ciphertext
 */
export function encryptMessage(plaintext: string, key: Buffer): string {
  const iv     = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // IV (12) + tag (16) + ciphertext
  const blob = Buffer.concat([iv, tag, ct]);
  return blob.toString('base64');
}

/**
 * Decrypts a value produced by encryptMessage.
 * Throws if auth tag check fails (tampered data).
 */
export function decryptMessage(encrypted: string, key: Buffer): string {
  const blob = Buffer.from(encrypted, 'base64');

  if (blob.length < IV_LEN + TAG_LEN) throw new Error('encrypted_content too short');

  const iv      = blob.subarray(0, IV_LEN);
  const tag     = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct      = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(ct) + decipher.final('utf8');
}
