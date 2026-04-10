import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('db');

let _db: Database.Database | null = null;

function resolvePath(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('DB not initialized. Call initDb() first.');
  return _db;
}

export function initDb(dataDir: string): Database.Database {
  const resolved = resolvePath(dataDir);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });

  // Harden directory permissions in case it already existed with looser perms
  try {
    fs.chmodSync(resolved, 0o700);
  } catch {}

  const dbPath = path.join(resolved, 'argos.db');
  log.info(`Opening database at ${dbPath}`);

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

  // Harden DB file permissions — should only be readable by the owner
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {}

  runMigrations(_db);
  log.info('Database ready');

  return _db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
    v: number | null;
  };
  const current = row.v ?? 0;

  const migrations: Array<{ version: number; sql: string }> = [
    { version: 1, sql: MIGRATION_1 },
    { version: 2, sql: MIGRATION_2 },
    { version: 3, sql: MIGRATION_3 },
    { version: 4, sql: MIGRATION_4 },
    { version: 5, sql: MIGRATION_5 },
    { version: 6, sql: MIGRATION_6 },
    { version: 7, sql: MIGRATION_7 },
    { version: 8, sql: MIGRATION_8 },
    { version: 9, sql: MIGRATION_9 },
    { version: 10, sql: MIGRATION_10 },
    { version: 11, sql: MIGRATION_11 },
    { version: 12, sql: MIGRATION_12 },
    { version: 13, sql: MIGRATION_13 },
    { version: 14, sql: MIGRATION_14 },
    { version: 15, sql: MIGRATION_15 },
    { version: 16, sql: MIGRATION_16 },
    { version: 17, sql: MIGRATION_17 },
    { version: 18, sql: MIGRATION_18 },
    { version: 19, sql: MIGRATION_19 },
  ];

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    log.info(`Applying migration ${migration.version}`);
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_version VALUES (?, ?)').run(migration.version, Date.now());
  }
}

// ─── Migration 1: full schema ─────────────────────────────────────────────────
const MIGRATION_1 = `
  -- Raw inbound messages (references only — no full content stored permanently)
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    chat_id     TEXT NOT NULL,
    partner_name TEXT,
    sender_id   TEXT,
    sender_name TEXT,
    content_hash TEXT,              -- SHA-256 of raw content for dedup
    received_at INTEGER NOT NULL,
    processed_at INTEGER,
    status      TEXT NOT NULL DEFAULT 'pending',
    window_id   TEXT                -- context window this message belongs to
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, received_at);
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

  -- Context windows: batched message groups from same chat
  CREATE TABLE IF NOT EXISTS context_windows (
    id           TEXT PRIMARY KEY,
    chat_id      TEXT NOT NULL,
    partner_name TEXT,
    message_ids  TEXT NOT NULL,     -- JSON array of message ids
    opened_at    INTEGER NOT NULL,
    closed_at    INTEGER,
    status       TEXT NOT NULL DEFAULT 'open'
  );
  CREATE INDEX IF NOT EXISTS idx_windows_chat ON context_windows(chat_id, status);

  -- Memories: anonymized summaries with TTL
  CREATE TABLE IF NOT EXISTS memories (
    id           TEXT PRIMARY KEY,
    content      TEXT NOT NULL,
    tags         TEXT NOT NULL DEFAULT '[]',  -- JSON array
    category     TEXT NOT NULL,
    source_ref   TEXT,
    partner_name TEXT,
    chat_id      TEXT,
    importance   INTEGER NOT NULL DEFAULT 0,
    archived     INTEGER NOT NULL DEFAULT 0,
    expires_at   INTEGER,           -- NULL = permanent
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_memories_partner ON memories(partner_name);
  CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id);
  -- FTS for semantic-ish search without vector DB
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, tags, category,
    content=memories,
    content_rowid=rowid
  );
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, tags, category)
    VALUES (new.rowid, new.content, new.tags, new.category);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags, category)
    VALUES ('delete', old.rowid, old.content, old.tags, old.category);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags, category)
    VALUES ('delete', old.rowid, old.content, old.tags, old.category);
    INSERT INTO memories_fts(rowid, content, tags, category)
    VALUES (new.rowid, new.content, new.tags, new.category);
  END;

  -- Tasks: detected actionable items
  CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    description   TEXT,
    category      TEXT NOT NULL,
    source_ref    TEXT,
    partner_name  TEXT,
    chat_id       TEXT,
    assigned_team TEXT,
    is_my_task    INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'open',
    completed_at  INTEGER,
    detected_at   INTEGER NOT NULL,
    expires_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_partner ON tasks(partner_name);
  CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks(chat_id);

  -- Proposals: Claude-generated action plans awaiting approval
  CREATE TABLE IF NOT EXISTS proposals (
    id              TEXT PRIMARY KEY,
    task_id         TEXT,
    context_summary TEXT NOT NULL,
    plan            TEXT NOT NULL,
    actions         TEXT NOT NULL,   -- JSON array of ProposedAction
    draft_reply     TEXT,
    status          TEXT NOT NULL DEFAULT 'proposed',
    created_at      INTEGER NOT NULL,
    approved_at     INTEGER,
    executed_at     INTEGER,
    expires_at      INTEGER NOT NULL,
    rejection_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
  CREATE INDEX IF NOT EXISTS idx_proposals_task ON proposals(task_id);

  -- Approvals: approval requests sent to user
  CREATE TABLE IF NOT EXISTS approvals (
    id                  TEXT PRIMARY KEY,
    proposal_id         TEXT NOT NULL,
    telegram_message_id INTEGER,
    status              TEXT NOT NULL DEFAULT 'pending',
    created_at          INTEGER NOT NULL,
    responded_at        INTEGER,
    expires_at          INTEGER NOT NULL,
    FOREIGN KEY (proposal_id) REFERENCES proposals(id)
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_proposal ON approvals(proposal_id);
  CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

  -- Cron jobs: scheduled tasks
  CREATE TABLE IF NOT EXISTS cron_jobs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    schedule    TEXT NOT NULL,
    handler     TEXT NOT NULL,
    config      TEXT NOT NULL DEFAULT '{}',  -- JSON
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_run    INTEGER,
    next_run    INTEGER,
    created_at  INTEGER NOT NULL
  );

  -- Chain events: emitted by workers/approvals to trigger multi-step flows
  CREATE TABLE IF NOT EXISTS chain_events (
    id           TEXT PRIMARY KEY,
    event_key    TEXT NOT NULL,
    payload      TEXT,               -- JSON
    emitted_at   INTEGER NOT NULL,
    consumed     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_events_key ON chain_events(event_key, consumed);

  -- WebAuthn credentials: registered YubiKeys / passkeys
  CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id              TEXT PRIMARY KEY,    -- credential ID (base64url)
    public_key      TEXT NOT NULL,       -- CBOR public key (base64url)
    counter         INTEGER NOT NULL DEFAULT 0,
    device_name     TEXT NOT NULL DEFAULT 'YubiKey',
    transports      TEXT,               -- JSON array: ['usb','nfc','ble']
    registered_at   INTEGER NOT NULL,
    last_used_at    INTEGER
  );

  -- WebAuthn sessions: issued after successful auth (short-lived)
  CREATE TABLE IF NOT EXISTS webauthn_sessions (
    token           TEXT PRIMARY KEY,
    credential_id   TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    -- Risk level cleared by this session:
    -- 'standard' = can approve low/medium risk
    -- 'elevated' = can approve high risk (fresh assertion required)
    clearance       TEXT NOT NULL DEFAULT 'standard'
  );

  -- Pending WebAuthn challenges (server-generated, single-use)
  CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id          TEXT PRIMARY KEY,
    challenge   TEXT NOT NULL,        -- base64url challenge
    type        TEXT NOT NULL,        -- 'registration' | 'authentication' | 'approval'
    context     TEXT,                 -- JSON: proposal_id etc.
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,     -- 5 minute TTL
    used        INTEGER NOT NULL DEFAULT 0
  );

  -- Audit log: immutable record of everything
  CREATE TABLE IF NOT EXISTS audit_log (
    id           TEXT PRIMARY KEY,
    event_type   TEXT NOT NULL,
    entity_id    TEXT,
    entity_type  TEXT,
    data         TEXT,               -- JSON
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_id);
`;

// ─── Migration 2: conversations + TOTP ───────────────────────────────────────
const MIGRATION_2 = `
  -- Persistent conversations (survive restarts)
  CREATE TABLE IF NOT EXISTS conversations (
    user_id         TEXT PRIMARY KEY,
    messages        TEXT NOT NULL DEFAULT '[]',   -- JSON array of {role, content}
    compacted_summary TEXT,                       -- summary of old messages
    updated_at      INTEGER NOT NULL
  );

  -- TOTP secrets
  CREATE TABLE IF NOT EXISTS totp_secrets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT NOT NULL DEFAULT 'default',
    secret      TEXT NOT NULL,
    verified    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Auth sessions (TOTP + WebAuthn unified)
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token       TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    method      TEXT NOT NULL DEFAULT 'totp'
  );
`;

// ─── Migration 3: vector store for semantic search ───────────────────────────
const MIGRATION_3 = `
  CREATE TABLE IF NOT EXISTS vector_chunks (
    id          TEXT PRIMARY KEY,
    source_ref  TEXT NOT NULL,      -- e.g. "github:owner/repo" or "url:https://..."
    source_name TEXT NOT NULL,      -- human label
    chunk_index INTEGER NOT NULL,
    content     TEXT NOT NULL,      -- raw text of this chunk
    line_start  INTEGER,            -- first line (1-based, optional)
    line_end    INTEGER,            -- last line (inclusive, optional)
    embedding   BLOB NOT NULL,      -- Float32Array serialized as BLOB
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_vector_chunks_source ON vector_chunks(source_ref);
`;

// ─── Migration 4: channel field on memories ───────────────────────────────────
const MIGRATION_4 = `
  ALTER TABLE memories ADD COLUMN channel TEXT;
  CREATE INDEX IF NOT EXISTS idx_memories_channel ON memories(channel);
`;

// ─── Migration 5: raw content storage (opt-in, privacy LLM only) ─────────────
const MIGRATION_5 = `
  ALTER TABLE memories ADD COLUMN raw_content TEXT;
`;

// ─── Migration 6: channel field on messages ───────────────────────────────────
const MIGRATION_6 = `
  ALTER TABLE messages ADD COLUMN channel TEXT;
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
`;

const MIGRATION_7 = `
  ALTER TABLE tasks ADD COLUMN channel TEXT;
  CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel);
`;

// anon_lookup: persists the placeholder→realValue map so it survives restarts.
// Stored as JSON. Never sent to any LLM — only used locally for de-anonymization.
const MIGRATION_8 = `
  ALTER TABLE messages ADD COLUMN anon_lookup TEXT;
`;

// proposals.anon_lookup: merged lookup (placeholder→real) from all messages in the window.
// Used by workers to de-anonymize action inputs before execution.
// Never sent to any LLM — resolved locally at worker execution time only.
const MIGRATION_9 = `
  ALTER TABLE proposals ADD COLUMN anon_lookup TEXT;
`;

// Ephemeral execution tokens — generated at approval time, consumed on execution.
// A second independent gate: even if DB status is manually set to 'approved',
// execution is blocked without the token that only exists after a real human approval.
const MIGRATION_10 = `
  CREATE TABLE IF NOT EXISTS execution_tokens (
    proposal_id  TEXT PRIMARY KEY,
    token        TEXT NOT NULL,       -- 64 hex chars (32 random bytes, crypto.randomBytes)
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,    -- 5-minute TTL from approval time
    used         INTEGER NOT NULL DEFAULT 0
  );
`;

// ─── Migration 12: anon_content on messages ──────────────────────────────────
// Stores the anonymized text of each message for conversation traceability.
// Raw content is never stored — only the regex+LLM anonymized version.
const MIGRATION_12 = `
  ALTER TABLE messages ADD COLUMN anon_content TEXT;
`;

// ─── Migration 13: encrypted_content on messages ─────────────────────────────
// AES-256-GCM encrypted raw content, opt-in via privacy.encryptMessages: true.
// Key lives at ~/.argos/message.key — never in DB or config.
const MIGRATION_13 = `
  ALTER TABLE messages ADD COLUMN encrypted_content TEXT;
`;

// ─── Migration 14: message_url on tasks ──────────────────────────────────────
// Stores the permalink to the original Telegram/Slack/etc message that triggered the task.
// Lets the owner jump back to the original request directly from the task list.
const MIGRATION_14 = `
  ALTER TABLE tasks ADD COLUMN message_url TEXT;
`;

// ─── Migration 15: execution_count on proposals ───────────────────────────────
// Tracks how many times a proposal has been executed.
// Acts as an idempotency guard: executor checks this is 0 before starting,
// then increments atomically. Prevents double-execution even if the ephemeral
// token check were somehow bypassed or the proposal manually reset.
const MIGRATION_15 = `
  ALTER TABLE proposals ADD COLUMN execution_count INTEGER NOT NULL DEFAULT 0;
`;

// ─── Migration 16: tamper-evident audit log ───────────────────────────────────
// Adds prev_hash to audit_log for hash-chain integrity verification.
// Each entry stores SHA-256(id||event_type||entity_id||data||created_at||prev_hash).
// A break in the chain reveals tampering. Verify with: npm run verify-audit
const MIGRATION_16 = `
  ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
  ALTER TABLE audit_log ADD COLUMN entry_hash TEXT;
`;

// ─── Migration 17: context window crash recovery ─────────────────────────────
// Store full sanitized messages JSON so windows can be replayed after a crash.
// Image data is excluded (ephemeral by design).
const MIGRATION_17 = `
  ALTER TABLE context_windows ADD COLUMN messages_json TEXT;
`;

// ─── Migration 18: notifications (real-time owner alerts) ────────────────────
const MIGRATION_18 = `
  CREATE TABLE IF NOT EXISTS notifications (
    id            TEXT PRIMARY KEY,
    chat_id       TEXT,
    partner_name  TEXT,
    channel       TEXT,
    title         TEXT NOT NULL,
    body          TEXT,
    urgency       TEXT,
    message_url   TEXT,
    source_ref    TEXT,
    status        TEXT NOT NULL DEFAULT 'unread',
    created_at    INTEGER NOT NULL,
    seen_at       INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_status_created ON notifications(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_chat ON notifications(chat_id);
`;

// ─── Migration 19: todos (batch-extracted from chat history) ─────────────────
const MIGRATION_19 = `
  CREATE TABLE IF NOT EXISTS todos (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    description       TEXT,
    chat_id           TEXT,
    partner_name      TEXT,
    channel           TEXT,
    source_window_ids TEXT,
    status            TEXT NOT NULL DEFAULT 'open',
    priority          TEXT,
    created_at        INTEGER NOT NULL,
    completed_at      INTEGER,
    notion_page_id    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
  CREATE INDEX IF NOT EXISTS idx_todos_chat ON todos(chat_id);
`;

// ─── Migration 11: knowledge graph ───────────────────────────────────────────
const MIGRATION_11 = `
  CREATE TABLE IF NOT EXISTS entities (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    name         TEXT NOT NULL,
    properties   TEXT NOT NULL DEFAULT '{}',
    first_seen   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL,
    source_ref   TEXT,
    channel      TEXT,
    chat_id      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_entities_type_name ON entities(type, name);
  CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(name, properties, content=entities, content_rowid=rowid);

  CREATE TABLE IF NOT EXISTS entity_relations (
    id           TEXT PRIMARY KEY,
    from_id      TEXT NOT NULL,
    to_id        TEXT NOT NULL,
    relation     TEXT NOT NULL,
    context      TEXT,
    confidence   REAL NOT NULL DEFAULT 0.7,
    source_ref   TEXT,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_relations_from ON entity_relations(from_id);
  CREATE INDEX IF NOT EXISTS idx_relations_to   ON entity_relations(to_id);
`;

// ─── Audit helper ─────────────────────────────────────────────────────────────
let _ulid: (() => string) | null = null;
function makeId(): string {
  // Monotonic ULID fallback — replaced with proper ulid once module loads
  if (_ulid) return _ulid();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Tamper-evident chain: each entry hashes its own content + previous entry hash.
// Seeded from DB at init. Breaks in the chain reveal post-hoc tampering.
let _lastAuditHash = '0000000000000000000000000000000000000000000000000000000000000000'; // genesis

function seedAuditChain(db: Database.Database): void {
  const row = db
    .prepare(
      'SELECT entry_hash FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1',
    )
    .get() as { entry_hash: string } | undefined;
  if (row?.entry_hash) _lastAuditHash = row.entry_hash;
}

// Async init — called from initDb
export async function loadUlid(): Promise<void> {
  const mod = await import('ulid');
  _ulid = mod.monotonicFactory();
  // Seed hash chain from existing audit log
  try {
    seedAuditChain(getDb());
  } catch {
    /* DB not ready yet — will be seeded on first audit() call */
  }
}

export function audit(
  eventType: string,
  entityId?: string,
  entityType?: string,
  data?: unknown,
): void {
  const db = getDb();
  const id = makeId();
  const dataStr = data ? JSON.stringify(data) : null;
  const createdAt = Date.now();

  // Hash chain: SHA-256 over canonical entry content + previous hash
  const entryHash = createHash('sha256')
    .update(id)
    .update(eventType)
    .update(entityId ?? '')
    .update(entityType ?? '')
    .update(dataStr ?? '')
    .update(String(createdAt))
    .update(_lastAuditHash)
    .digest('hex');

  db.prepare(
    `
    INSERT INTO audit_log (id, event_type, entity_id, entity_type, data, created_at, prev_hash, entry_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    eventType,
    entityId ?? null,
    entityType ?? null,
    dataStr,
    createdAt,
    _lastAuditHash,
    entryHash,
  );

  _lastAuditHash = entryHash;
}

// ─── Typed query helpers ──────────────────────────────────────────────────────
export function jsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
