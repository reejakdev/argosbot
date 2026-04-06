/**
 * Knowledge indexer.
 *
 * Persists a KnowledgeDocument into the memory store (SQLite)
 * and optionally indexes it in the vector store (LanceDB).
 *
 * Documents are stored as permanent memories (category='context',
 * archived=true, no expiry) and are always available to the planner.
 */

import { monotonicFactory } from 'ulid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/index.js';
import type { Config } from '../config/schema.js';
import type { KnowledgeDocument } from './types.js';

const log = createLogger('knowledge:indexer');
const ulid = monotonicFactory();

/**
 * Upsert a document into the memory store.
 * Creates a new entry on first seen, updates content on refresh.
 * Also triggers vector indexing if embeddings are enabled and content is large.
 */
export async function indexDocument(doc: KnowledgeDocument, config: Config): Promise<void> {
  const db = getDb();

  const existing = db
    .prepare(`SELECT id FROM memories WHERE source_ref = ? AND category = 'context'`)
    .get(doc.key) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `
      UPDATE memories SET content = ?, tags = ?, created_at = ? WHERE id = ?
    `,
    ).run(doc.content, JSON.stringify(doc.tags), Date.now(), existing.id);
    log.debug(`Knowledge updated: ${doc.name}`);
  } else {
    db.prepare(
      `
      INSERT INTO memories (id, content, tags, category, source_ref, importance, archived, expires_at, created_at)
      VALUES (?, ?, ?, 'context', ?, 7, 1, NULL, ?)
    `,
    ).run(ulid(), doc.content, JSON.stringify(doc.tags), doc.key, Date.now());
    log.info(`Knowledge indexed: ${doc.name}`);
  }

  // Vector index — always index when embeddings are enabled (fullText for large docs, content for small ones)
  if (config.embeddings.enabled) {
    try {
      const textToIndex = doc.fullText ?? doc.content;
      const { chunkText, chunkCode, indexChunks } = await import('../vector/store.js');
      const isCode = /\.(ts|js|json)$/.test(doc.key) || doc.tags?.includes('code');
      const chunks = isCode
        ? chunkCode(textToIndex, doc.key, doc.name, doc.tags ?? [])
        : chunkText(textToIndex, doc.key, doc.name, doc.tags ?? []);
      await indexChunks(chunks, config.embeddings);
    } catch (e) {
      log.warn(`Vector indexing failed for "${doc.name}": ${e}`);
    }
  }
}

/**
 * Check whether a document's cached version is stale based on its refreshDays setting.
 */
export function isStale(key: string, refreshDays: number, now: number): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT created_at FROM memories WHERE source_ref = ? AND category = 'context'`)
    .get(key) as { created_at: number } | undefined;

  if (!row) return true;
  return now - row.created_at > refreshDays * 24 * 60 * 60 * 1000;
}
