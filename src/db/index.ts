import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
  fs.mkdirSync(resolved, { recursive: true });

  const dbPath = path.join(resolved, 'argos.db');
  log.info(`Opening database at ${dbPath}`);

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

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

  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  const current = row.v ?? 0;

  const migrations: Array<{ version: number; sql: string }> = [
    { version: 1, sql: MIGRATION_1 },
    { version: 2, sql: MIGRATION_2 },
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

// ─── Audit helper ─────────────────────────────────────────────────────────────
let _ulid: (() => string) | null = null;
function makeId(): string {
  // Monotonic ULID fallback — replaced with proper ulid once module loads
  if (_ulid) return _ulid();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
// Async init — called from initDb
export async function loadUlid(): Promise<void> {
  const mod = await import('ulid');
  _ulid = mod.monotonicFactory();
}

export function audit(
  eventType: string,
  entityId?: string,
  entityType?: string,
  data?: unknown,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (id, event_type, entity_id, entity_type, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    makeId(),
    eventType,
    entityId ?? null,
    entityType ?? null,
    data ? JSON.stringify(data) : null,
    Date.now(),
  );
}

// ─── Typed query helpers ──────────────────────────────────────────────────────
export function jsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}
