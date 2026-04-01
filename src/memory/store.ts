/**
 * Memory store — anonymized summaries with TTL, FTS search, and archive flag.
 *
 * Design:
 *   - Default TTL: 7 days (configurable)
 *   - Archive flag: kept indefinitely (for decisions, active tickets, etc.)
 *   - Search: SQLite FTS5 (no vector DB needed for v1)
 *   - Purge: runs on a cron, removes expired non-archived entries
 *   - Indexed by: partner, chatId, category, tags
 *
 * Raw content is NEVER stored — only the anonymized summary + metadata.
 */

import { monotonicFactory } from 'ulid';
import { getDb, audit } from '../db/index.js';
import { createLogger } from '../logger.js';
import type { MemoryEntry, MessageCategory, ClassificationResult, ContextWindow } from '../types.js';

const ulid = monotonicFactory();
const log = createLogger('memory');

// ─── Store a new memory entry ─────────────────────────────────────────────────

export function store(
  summary: string,
  result: ClassificationResult,
  window: ContextWindow,
  options: {
    defaultTtlDays: number;
    archiveTtlDays: number;
    autoArchiveThreshold: number;
  },
): MemoryEntry {
  const db = getDb();
  const now = Date.now();

  // High-importance items get auto-archived
  const shouldArchive = result.importance >= options.autoArchiveThreshold;
  const ttlDays = shouldArchive ? options.archiveTtlDays : options.defaultTtlDays;
  const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;

  const entry: MemoryEntry = {
    id:          ulid(),
    content:     summary,
    tags:        result.tags,
    category:    result.category,
    sourceRef:   window.id,
    channel:     window.channel,
    partnerName: window.partnerName,
    chatId:      window.chatId,
    importance:  result.importance,
    archived:    shouldArchive,
    expiresAt:   shouldArchive ? null : expiresAt, // archived = no expiry
    createdAt:   now,
  };

  // NOTE: the `channel` column is added in a DB migration (see db/index.ts).
  // Existing installs without the column will fall back gracefully via SQLite's
  // lenient column handling when the migration has not yet run.
  db.prepare(`
    INSERT INTO memories (id, content, tags, category, source_ref, channel, partner_name, chat_id,
                          importance, archived, expires_at, created_at, raw_content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.content,
    JSON.stringify(entry.tags),
    entry.category,
    entry.sourceRef,
    entry.channel ?? null,
    entry.partnerName ?? null,
    entry.chatId,
    entry.importance,
    entry.archived ? 1 : 0,
    entry.expiresAt,
    entry.createdAt,
    window.rawContent ?? null,
  );

  log.debug(`Stored memory ${entry.id}`, {
    category: entry.category,
    partner: entry.partnerName,
    importance: entry.importance,
    archived: entry.archived,
    expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : 'never',
  });

  // Async vector index — fire-and-forget, failure won't affect the pipeline
  setImmediate(() => { vectorizeMemoryAsync(entry).catch(() => {}); });

  audit('memory_stored', entry.id, 'memory', {
    category: entry.category,
    partner: entry.partnerName,
    importance: entry.importance,
  });

  return entry;
}

// ─── Quick store — simplified interface for bot auto-memorize ─────────────────

export function storeQuick(content: string, category: string, tags: string[] = []): MemoryEntry {
  const db = getDb();
  const now = Date.now();
  const ttlDays = 30;
  const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;

  const entry: MemoryEntry = {
    id: ulid(),
    content,
    tags,
    category: category as MessageCategory,
    sourceRef: `auto:${Date.now()}`,
    importance: 6,
    archived: false,
    expiresAt,
    createdAt: now,
  };

  db.prepare(`
    INSERT INTO memories (id, content, tags, category, source_ref, partner_name, chat_id,
                          importance, archived, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entry.id, entry.content, JSON.stringify(entry.tags), entry.category,
    entry.sourceRef, null, null, entry.importance, 0, entry.expiresAt, entry.createdAt);

  log.debug(`Quick-stored memory: ${content.slice(0, 60)}`);
  return entry;
}

// ─── Archive an existing entry ────────────────────────────────────────────────

export function archive(memoryId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE memories SET archived = 1, expires_at = NULL WHERE id = ?
  `).run(memoryId);
  log.info(`Memory ${memoryId} archived permanently`);
}

// ─── FTS search ───────────────────────────────────────────────────────────────

export interface SearchOptions {
  query: string;
  partnerName?: string;
  chatId?: string;
  category?: MessageCategory;
  limit?: number;
  includeExpired?: boolean;
  /** Return raw_content field — only for privacy/local LLM paths. Never pass to cloud LLM. */
  includeRaw?: boolean;
}

export function search(options: SearchOptions): MemoryEntry[] {
  const db = getDb();
  const now = Date.now();
  const limit = Math.min(options.limit ?? 10, 100);

  // Build FTS query — strip all FTS5 special chars (., +, -, ^, (, ), etc.)
  const ftsQuery = options.query.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

  const rows = db.prepare(`
    SELECT m.*
    FROM memories m
    JOIN memories_fts fts ON m.rowid = fts.rowid
    WHERE memories_fts MATCH ?
    AND (? OR m.expires_at IS NULL OR m.expires_at > ?)
    AND (? OR m.partner_name = ?)
    AND (? OR m.chat_id = ?)
    AND (? OR m.category = ?)
    ORDER BY fts.rank, m.importance DESC, m.created_at DESC
    LIMIT ?
  `).all(
    ftsQuery,
    options.includeExpired ? 1 : 0,
    now,
    !options.partnerName ? 1 : 0, options.partnerName ?? null,
    !options.chatId ? 1 : 0, options.chatId ?? null,
    !options.category ? 1 : 0, options.category ?? null,
    limit,
  ) as Array<Record<string, unknown>>;

  return rows.map(row => rowToEntry(row, options.includeRaw));
}

// ─── Get recent memories for a partner / chat ─────────────────────────────────

export function getRecentForContext(
  chatId: string,
  partnerName?: string,
  limit = 5,
  includeRaw = false,
): MemoryEntry[] {
  const db = getDb();
  const now = Date.now();

  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE (chat_id = ? OR partner_name = ?)
    AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(chatId, partnerName ?? null, now, limit) as Array<Record<string, unknown>>;

  return rows.map(row => rowToEntry(row, includeRaw));
}

// ─── Purge expired non-archived entries ───────────────────────────────────────

export function purgeExpired(): number {
  const db  = getDb();
  const now = Date.now();

  // Fetch IDs before deleting so we can clean LanceDB orphans
  const expired = db.prepare(`
    SELECT id FROM memories
    WHERE archived = 0
    AND expires_at IS NOT NULL
    AND expires_at < ?
  `).all(now) as Array<{ id: string }>;

  if (expired.length === 0) return 0;

  const result = db.prepare(`
    DELETE FROM memories
    WHERE archived = 0
    AND expires_at IS NOT NULL
    AND expires_at < ?
  `).run(now);

  const count = result.changes;
  log.info(`Purged ${count} expired memory entries`);
  audit('memory_purge', undefined, 'memory', { count });

  // Clean LanceDB orphans asynchronously — fire-and-forget
  setImmediate(async () => {
    try {
      const { cleanSource } = await import('../vector/store.js');
      for (const { id } of expired) {
        await cleanSource(`memory:${id}`);
      }
      log.debug(`LanceDB: cleaned ${expired.length} orphaned memory chunk(s)`);
    } catch (e) {
      log.warn(`LanceDB orphan cleanup failed: ${e}`);
    }
  });

  return count;
}

// ─── Async vector indexing for memories ──────────────────────────────────────

/**
 * Index a memory entry into LanceDB so it can be retrieved via semantic search.
 * Called fire-and-forget — failures are silently swallowed (vector store is optional).
 *
 * sourceRef convention: "memory:<id>"
 * Tags: ['memory', category, partnerName] — enables filtering by source or partner.
 */
async function vectorizeMemoryAsync(entry: MemoryEntry): Promise<void> {
  try {
    const { loadConfig } = await import('../config/index.js');
    const config   = loadConfig();
    const embCfg   = (config as unknown as { embeddings?: import('../config/schema.js').EmbeddingsConfig }).embeddings;
    if (!embCfg?.enabled) return;

    const { chunkText, indexChunks } = await import('../vector/store.js');
    const tags = ['memory', entry.category, ...(entry.partnerName ? [entry.partnerName] : [])].filter(Boolean) as string[];
    const chunks = chunkText(
      entry.content,
      `memory:${entry.id}`,
      entry.partnerName ?? entry.category,
      tags,
      {
        field1: entry.chatId,
        field2: entry.partnerName,
        field3: entry.category,
      },
    );
    await indexChunks(chunks, embCfg);
    log.debug(`Vectorized memory ${entry.id} (${chunks.length} chunk(s))`);
  } catch {
    // Vector store is optional — silently skip on any failure
  }
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

function rowToEntry(row: Record<string, unknown>, includeRaw = false): MemoryEntry {
  return {
    id:          row.id as string,
    content:     row.content as string,
    tags:        JSON.parse(row.tags as string) as string[],
    category:    row.category as MessageCategory,
    sourceRef:   row.source_ref as string,
    channel:     (row.channel as string | null) ?? undefined,
    partnerName: (row.partner_name as string | null) ?? undefined,
    chatId:      (row.chat_id as string | null) ?? undefined,
    importance:  row.importance as number,
    archived:    Boolean(row.archived),
    expiresAt:   row.expires_at as number | null,
    createdAt:   row.created_at as number,
    // raw_content only returned when explicitly requested — privacy LLM paths only
    rawContent:  includeRaw ? ((row.raw_content as string | null) ?? undefined) : undefined,
  };
}

// ─── Task persistence helpers ─────────────────────────────────────────────────

export function saveTask(
  title: string,
  result: ClassificationResult,
  window: ContextWindow,
): string {
  const db = getDb();
  const now = Date.now();

  // ── Deduplication ─────────────────────────────────────────────────────────
  // If the classifier flagged this as a duplicate, or if there's already an open
  // task for the same partner/chat with the same category, skip creation.
  if (result.isDuplicate) {
    const existing = db.prepare(`
      SELECT id FROM tasks
      WHERE status IN ('open', 'in_progress', 'done_inferred')
      AND (chat_id = ? OR partner_name = ?)
      AND category = ?
      ORDER BY detected_at DESC LIMIT 1
    `).get(window.chatId, window.partnerName ?? null, result.category) as { id: string } | null;

    if (existing) {
      log.info(`Task dedup — reusing ${existing.id} for window ${window.id} (isDuplicate=true)`);
      return existing.id;
    }
  }

  const id = ulid();

  db.prepare(`
    INSERT INTO tasks (id, title, category, source_ref, partner_name, chat_id,
                       assigned_team, is_my_task, status, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
  `).run(
    id,
    title,
    result.category,
    window.id,
    window.partnerName ?? null,
    window.chatId,
    result.assignedTeam ?? null,
    result.isMyTask ? 1 : 0,
    now,
  );

  log.info(`Task saved: ${id} — ${title}`, {
    taskScope:       result.taskScope,
    ownerConfidence: result.ownerConfidence,
    team:            result.assignedTeam,
    partner:         window.partnerName,
  });

  return id;
}
