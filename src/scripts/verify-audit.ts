/**
 * verify-audit — verifies the tamper-evident hash chain in audit_log.
 *
 * Usage: npm run verify-audit
 *
 * Exit 0 = chain intact. Exit 1 = tampering detected (prints first broken entry).
 */

import { createHash } from 'crypto';
import path from 'path';
import os from 'os';
import { initDb } from '../db/index.js';

const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
const db = initDb(dataDir);

type AuditRow = {
  id: string;
  event_type: string;
  entity_id: string | null;
  entity_type: string | null;
  data: string | null;
  created_at: number;
  prev_hash: string | null;
  entry_hash: string | null;
};

const rows = db.prepare(
  'SELECT * FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY created_at ASC'
).all() as AuditRow[];

if (rows.length === 0) {
  console.log('No hashed audit entries found (entries pre-migration 16 are excluded).');
  process.exit(0);
}

const GENESIS = '0000000000000000000000000000000000000000000000000000000000000000';
let prevHash = GENESIS;
let broken = 0;

for (const row of rows) {
  const expected = createHash('sha256')
    .update(row.id)
    .update(row.event_type)
    .update(row.entity_id ?? '')
    .update(row.entity_type ?? '')
    .update(row.data ?? '')
    .update(String(row.created_at))
    .update(row.prev_hash ?? GENESIS)
    .digest('hex');

  if (expected !== row.entry_hash) {
    console.error(`\n❌ TAMPER DETECTED at entry ${row.id}`);
    console.error(`   event:     ${row.event_type}`);
    console.error(`   created:   ${new Date(row.created_at).toISOString()}`);
    console.error(`   stored:    ${row.entry_hash}`);
    console.error(`   computed:  ${expected}`);
    console.error(`   prev_hash: ${row.prev_hash}`);
    broken++;
  }

  if (row.prev_hash !== null && row.prev_hash !== prevHash) {
    console.error(`\n❌ CHAIN BREAK at entry ${row.id} — prev_hash mismatch`);
    console.error(`   stored prev_hash:   ${row.prev_hash}`);
    console.error(`   expected prev_hash: ${prevHash}`);
    broken++;
  }

  prevHash = row.entry_hash!;
}

if (broken === 0) {
  console.log(`✅ Audit chain intact — ${rows.length} entries verified.`);
  process.exit(0);
} else {
  console.error(`\n⚠️  ${broken} integrity violation(s) found across ${rows.length} entries.`);
  process.exit(1);
}
