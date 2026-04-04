/**
 * Decrypt a stored message by ID.
 *
 * Usage:
 *   npm run decrypt -- <message_id>
 *   npm run decrypt -- --list          # show last 20 encrypted messages
 */

import { getDb, initDb } from '../db/index.js';
import { loadEncryptionKey, decryptMessage } from '../privacy/encryption.js';
import { join } from 'path';
import { homedir } from 'os';

const DATA_DIR = process.env.DATA_DIR ?? join(homedir(), '.argos');
initDb(DATA_DIR);
const db  = getDb();
const key = loadEncryptionKey();

const arg = process.argv[2];

if (!arg || arg === '--help') {
  console.log('Usage: npm run decrypt -- <message_id>');
  console.log('       npm run decrypt -- --list');
  process.exit(0);
}

if (arg === '--list') {
  const rows = db.prepare(`
    SELECT id, chat_id, partner_name, sender_name, received_at
    FROM messages
    WHERE encrypted_content IS NOT NULL
    ORDER BY received_at DESC
    LIMIT 20
  `).all() as Array<{ id: string; chat_id: string; partner_name: string | null; sender_name: string | null; received_at: number }>;

  if (rows.length === 0) {
    console.log('No encrypted messages found. Enable privacy.encryptMessages: true in config.');
    process.exit(0);
  }

  console.log(`\n${'ID'.padEnd(28)}  ${'Partner'.padEnd(20)}  ${'Sender'.padEnd(20)}  Date`);
  console.log('─'.repeat(90));
  for (const r of rows) {
    const date = new Date(r.received_at).toISOString().slice(0, 19).replace('T', ' ');
    console.log(`${r.id.padEnd(28)}  ${(r.partner_name ?? r.chat_id).slice(0, 20).padEnd(20)}  ${(r.sender_name ?? '—').slice(0, 20).padEnd(20)}  ${date}`);
  }
  process.exit(0);
}

// Decrypt by ID
const row = db.prepare(`
  SELECT id, chat_id, partner_name, sender_name, received_at, encrypted_content, anon_content
  FROM messages WHERE id = ?
`).get(arg) as { id: string; chat_id: string; partner_name: string | null; sender_name: string | null; received_at: number; encrypted_content: string | null; anon_content: string | null } | undefined;

if (!row) {
  console.error(`Message not found: ${arg}`);
  process.exit(1);
}

if (!row.encrypted_content) {
  console.error(`Message ${arg} has no encrypted content.`);
  if (row.anon_content) {
    console.log('\nAnonymized content (no raw available):');
    console.log(row.anon_content);
  }
  process.exit(1);
}

try {
  const plaintext = decryptMessage(row.encrypted_content, key);
  const date = new Date(row.received_at).toISOString().slice(0, 19).replace('T', ' ');

  console.log(`\n── Message ${row.id} ──`);
  console.log(`From    : ${row.sender_name ?? '—'} (${row.partner_name ?? row.chat_id})`);
  console.log(`At      : ${date}`);
  console.log(`\n${plaintext}`);
} catch (e) {
  console.error('Decryption failed — wrong key or tampered data:', e);
  process.exit(1);
}
