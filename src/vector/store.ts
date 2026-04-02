/**
 * Vector store — semantic search over chunked content.
 *
 * Backend: LanceDB (Apache Arrow + Rust, ANN search via IVF-PQ index).
 * Handles millions of chunks efficiently — required for 100+ Telegram channels.
 *
 * Database: ~/.argos/vectors/ (separate from SQLite argos.db)
 *
 * Tables:
 *   - chunks: all indexed content (GitHub, URLs, text, Telegram messages)
 *
 * Filtering: sourceRef prefix, tags, field1–field4 — the store is generic.
 * Each adapter maps its own semantics onto field1–field4 (see VectorChunk).
 */

import path from 'path';
import os from 'os';
import { createLogger } from '../logger.js';
import {
  embed,
  cosineSimilarity,
} from '../embeddings/index.js';
import type { EmbeddingsConfig } from '../config/schema.js';

const log = createLogger('vector');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VectorChunk {
  id:         string;
  sourceRef:  string;  // e.g. "github:owner/repo/file.json", "telegram:channel_id:msg_id"
  sourceName: string;  // human label
  chunkIndex: number;
  content:    string;
  tags:       string[]; // e.g. ["telegram", "2026-03-30"]
  lineStart?: number;
  lineEnd?:   number;
  createdAt:  number;
  /**
   * Generic indexed fields — semantics defined by the adapter, not the store.
   * Keeps the schema decoupled from any channel architecture.
   * Each adapter documents its convention via a FieldMap constant (see below).
   *
   * Telegram convention:
   *   field1 = chatId       e.g. "-1001234567890"
   *   field2 = chatName     e.g. "ACME Corp Ops"
   *   field3 = senderName   e.g. "Alice Dupont"
   *   field4 = messageUrl   e.g. "https://t.me/c/123/42"
   *
   * Email convention:
   *   field1 = senderEmail  e.g. "alice@acme.com"
   *   field2 = subject      e.g. "Re: deposit"
   *   field3 = senderName   e.g. "Alice Dupont"
   *
   * GitHub convention:
   *   field1 = owner/repo   e.g. "acme/contracts"
   *   field2 = filePath     e.g. "src/config/addresses.json"
   */
  field1?: string;
  field2?: string;
  field3?: string;
  field4?: string;
}

/** Declare what each field means for a given adapter — used as documentation + type-safe keys */
export interface ChunkFieldMap {
  field1?: string;
  field2?: string;
  field3?: string;
  field4?: string;
}

export interface SearchResult {
  chunk:      VectorChunk;
  similarity: number;
}

// ─── LanceDB connection ───────────────────────────────────────────────────────

type LanceTable = Awaited<ReturnType<Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>['openTable']>>;
let _db: Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>> | null = null;
let _table: LanceTable | null = null;

function getVectorDir(): string {
  const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
  const resolved = dataDir.startsWith('~') ? path.join(os.homedir(), dataDir.slice(1)) : dataDir;
  return path.join(resolved, 'vectors');
}

async function getTable() {
  if (_table) return _table;

  const lancedb = await import('@lancedb/lancedb');
  const vectorDir = getVectorDir();

  _db = await lancedb.connect(vectorDir);

  const tableNames = await _db!.tableNames();

  if (tableNames.includes('chunks')) {
    _table = await _db!.openTable('chunks');
  } else {
    // Create table with a dummy row to establish schema, then delete it
    _table = await _db!.createTable('chunks', [
      {
        id:          '__init__',
        source_ref:  '',
        source_name: '',
        chunk_index: 0,
        content:     '',
        tags:        '',
        line_start:  0,
        line_end:    0,
        created_at:  0,
        field1:      '',
        field2:      '',
        field3:      '',
        field4:      '',
        vector:      Array(768).fill(0) as number[],
      },
    ]);
    await _table.delete('id = "__init__"');
    log.info('LanceDB table "chunks" created');
  }

  return _table;
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

const CHUNK_LINES   = 40;  // ~one network+token section per chunk for address files
const OVERLAP_LINES = 15; // large overlap so parent keys (e.g. "mBASIS: {") stay in scope
const CODE_CHUNK_MAX_LINES = 80; // guard against monster depth-2 blocks

export function chunkText(
  text:       string,
  sourceRef:  string,
  sourceName: string,
  tags:       string[] = [],
  fields?:    ChunkFieldMap,
): VectorChunk[] {
  const lines  = text.split('\n');
  const chunks: VectorChunk[] = [];
  let   index  = 0;

  for (let start = 0; start < lines.length; start += CHUNK_LINES - OVERLAP_LINES) {
    const end     = Math.min(start + CHUNK_LINES, lines.length);
    const content = lines.slice(start, end).join('\n').trim();

    if (content.length < 20) { if (end === lines.length) break; continue; }

    chunks.push({
      id:         `${sourceRef}:${index}`,
      sourceRef,
      sourceName,
      chunkIndex: index++,
      content,
      tags,
      lineStart:  start + 1,
      lineEnd:    end,
      createdAt:  Date.now(),
      ...fields,
    });

    if (end === lines.length) break;
  }

  return chunks;
}

/**
 * Brace-aware chunker for TypeScript/JSON config files.
 *
 * Splits at depth-2 boundaries so each (network, token) pair becomes one
 * self-contained chunk with a breadcrumb header:
 *   // ADDRESSES > mainnet > mBASIS
 *   mBASIS: { token: '0x...', depositVault: '0x...' }
 *
 * Auto-detects structured content (>8% lines with braces).
 * Falls back to chunkText() if structure is not recognised.
 */
export function chunkCode(
  text:       string,
  sourceRef:  string,
  sourceName: string,
  tags:       string[] = [],
  fields?:    ChunkFieldMap,
): VectorChunk[] {
  const lines = text.split('\n');

  // Auto-detect: structured when ≥8% of first 100 lines contain braces
  const sample = lines.slice(0, 100);
  const braceLines = sample.filter(l => /[{}]/.test(l)).length;
  if (braceLines / Math.min(lines.length, 100) < 0.08) {
    return chunkText(text, sourceRef, sourceName, tags, fields);
  }

  const chunks: VectorChunk[] = [];
  let index = 0;
  let depth = 0;
  const keyStack: string[] = []; // key name at each depth level

  let sectionStart = -1;        // line index where current depth-2 block started

  const pushChunk = (start: number, end: number) => {
    const blockLines = lines.slice(start, end);
    // Build breadcrumb from up to 3 levels
    const crumb = keyStack.filter(Boolean).slice(0, 3).join(' > ');
    const header = crumb ? `// ${crumb}\n` : '';
    const content = (header + blockLines.join('\n')).trim();
    if (content.length >= 20) {
      chunks.push({
        id:         `${sourceRef}:${index}`,
        sourceRef,
        sourceName,
        chunkIndex: index++,
        content,
        tags,
        lineStart:  start + 1,
        lineEnd:    end,
        createdAt:  Date.now(),
        ...fields,
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trimStart();
    const opens   = (line.match(/\{/g) || []).length;
    const closes  = (line.match(/\}/g) || []).length;

    // Capture key name BEFORE updating depth (so depth reflects outer context)
    if (opens > closes) {
      // Matches: "export const FOO = {", "  key: {", "  key : {"
      const keyMatch = trimmed.match(/^(?:export\s+(?:const|default)\s+)?(\w+)\s*[=:]/);
      if (keyMatch) keyStack[depth] = keyMatch[1];
    }

    const prevDepth = depth;
    depth = Math.max(0, depth + opens - closes);

    // Entering depth-2 block → start a new section
    if (depth === 2 && prevDepth < 2 && sectionStart < 0) {
      sectionStart = i;
      // Also capture the key that opened this section
      const keyMatch = trimmed.match(/^(\w+)\s*[=:]/);
      if (keyMatch) keyStack[1] = keyMatch[1];
    }

    // Exiting depth-2 block → emit section chunk
    if (sectionStart >= 0 && depth < 2 && prevDepth >= 2) {
      pushChunk(sectionStart, i + 1);
      sectionStart = -1;
    }

    // Safety guard: oversized block → sub-chunk and continue
    if (sectionStart >= 0 && (i - sectionStart) >= CODE_CHUNK_MAX_LINES) {
      pushChunk(sectionStart, i + 1);
      sectionStart = i + 1;
    }

    // Trim key stack to current depth
    if (depth < prevDepth) keyStack.length = depth + 1;
  }

  // Flush any trailing section
  if (sectionStart >= 0 && sectionStart < lines.length) {
    pushChunk(sectionStart, lines.length);
  }

  // Too few semantic chunks → fall back to line-based chunking
  if (chunks.length < 3) {
    log.debug(`chunkCode: <3 chunks for "${sourceRef}", falling back to chunkText`);
    return chunkText(text, sourceRef, sourceName, tags, fields);
  }

  log.debug(`chunkCode: ${chunks.length} semantic chunks for "${sourceRef}"`);
  return chunks;
}

// ─── Clean a source (hard delete) ────────────────────────────────────────────

/**
 * Remove all chunks for a given sourceRef (prefix match) and compact the table
 * so that soft-deleted rows are physically removed and don't appear in full scans.
 */
export async function cleanSource(sourceRef: string): Promise<void> {
  try {
    const table   = await getTable();
    const escaped = sourceRef.replace(/"/g, '\\"').replace(/[%_]/g, '\\$&');
    await table.delete(`source_ref LIKE "${escaped}%" ESCAPE '\\'`);
    // Compact to physically purge soft-deleted rows (available in lancedb ≥0.4)
    try {
      await (table as unknown as { optimize: () => Promise<void> }).optimize();
    } catch { /* older lancedb versions without optimize — safe to ignore */ }
    log.debug(`cleanSource: removed rows for prefix "${sourceRef}"`);
  } catch (e) {
    log.warn(`cleanSource failed for "${sourceRef}": ${e}`);
  }
}

// ─── Purge old conversation vectors ──────────────────────────────────────────

/**
 * Delete all conversation: vectors older than olderThanDays.
 * Called daily from purgeExpired() — keeps the vector store at a rolling 30-day window.
 */
export async function purgeOldConversations(olderThanDays: number): Promise<void> {
  try {
    const table     = await getTable();
    const threshold = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    await table.delete(`source_ref LIKE "conversation:%" AND created_at < ${threshold}`);
    try {
      await (table as unknown as { optimize: () => Promise<void> }).optimize();
    } catch { /* older lancedb versions — safe to ignore */ }
    log.info(`Purged conversation vectors older than ${olderThanDays} days`);
  } catch (e) {
    log.warn(`purgeOldConversations failed: ${e}`);
  }
}

// ─── Index ────────────────────────────────────────────────────────────────────

export async function indexChunks(
  chunks: VectorChunk[],
  config: EmbeddingsConfig,
): Promise<void> {
  if (chunks.length === 0) return;

  const table     = await getTable();
  const sourceRef = chunks[0].sourceRef;

  // Hard-delete old chunks for this source before re-indexing (cleanSource compacts)
  await cleanSource(sourceRef);

  log.info(`Indexing ${chunks.length} chunks for "${sourceRef}"…`);

  const rows: Array<Record<string, unknown>> = [];
  let   failed = 0;

  for (const chunk of chunks) {
    try {
      const vec = await embed(chunk.content, config);
      rows.push({
        id:          chunk.id,
        source_ref:  chunk.sourceRef,
        source_name: chunk.sourceName,
        chunk_index: chunk.chunkIndex,
        content:     chunk.content,
        tags:        chunk.tags.join(','),   // LanceDB stores as string for easy filtering
        line_start:  chunk.lineStart ?? 0,
        line_end:    chunk.lineEnd   ?? 0,
        created_at:  chunk.createdAt,
        field1:      chunk.field1 ?? '',
        field2:      chunk.field2 ?? '',
        field3:      chunk.field3 ?? '',
        field4:      chunk.field4 ?? '',
        vector:      Array.from(vec),
      });
    } catch (e) {
      log.warn(`Failed to embed chunk ${chunk.id}: ${e}`);
      failed++;
    }
  }

  if (rows.length > 0) {
    await table.add(rows);
  }

  log.info(`Indexed ${rows.length}/${chunks.length} chunks for "${sourceRef}"${failed ? ` (${failed} failed)` : ''}`);
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function semanticSearch(
  query:  string,
  config: EmbeddingsConfig,
  opts: {
    topK?:          number;
    minSimilarity?: number;
    sourceRef?:     string;
    tags?:          string[];  // filter by tags (AND logic)
    // Generic field filters — semantics depend on the adapter that indexed the chunks
    field1?: string;
    field2?: string;
    field3?: string;
    field4?: string;
  } = {},
): Promise<SearchResult[]> {
  const { topK = 5, minSimilarity = 0.25 } = opts;

  const table    = await getTable();
  const queryVec = await embed(query, config);

  let q = table.vectorSearch(Array.from(queryVec)).limit(topK * 3); // over-fetch then filter

  if (opts.sourceRef) {
    // Prefix match — "github:owner/repo" matches "github:owner/repo/path/file.ts"
    // Escape quotes, then escape LIKE wildcards so they're treated literally
    const escaped = opts.sourceRef.replace(/"/g, '\\"').replace(/[%_]/g, '\\$&');
    q = q.where(`source_ref LIKE "${escaped}%" ESCAPE '\\'`);
  }
  if (opts.tags?.length) {
    // Sanitize tag values — strip chars that could break the filter expression.
    // LanceDB uses SQL-like WHERE clauses; single quotes and % are special.
    const tagFilters = opts.tags
      .map(t => t.replace(/['"\\%]/g, ''))   // strip injection chars
      .filter(t => t.length > 0)
      .map(t => `tags LIKE '%${t}%'`)
      .join(' AND ');
    if (tagFilters) q = q.where(tagFilters);
  }
  // Generic field filters — safe string escaping applied to each
  for (const key of ['field1', 'field2', 'field3', 'field4'] as const) {
    const val = opts[key];
    if (val) {
      const escaped = val.replace(/"/g, '\\"');
      q = q.where(`${key} = "${escaped}"`);
    }
  }

  const rows = await q.toArray();

  type Row = Record<string, unknown>;
  return (rows as Row[])
    .map((row: Row) => {
      const vec = new Float32Array(row['vector'] as number[]);
      return {
        chunk: {
          id:         String(row['id']),
          sourceRef:  String(row['source_ref']),
          sourceName: String(row['source_name']),
          chunkIndex: Number(row['chunk_index']),
          content:    String(row['content']),
          tags:       String(row['tags'] ?? '').split(',').filter(Boolean),
          lineStart:  Number(row['line_start']) || undefined,
          lineEnd:    Number(row['line_end'])   || undefined,
          createdAt:  Number(row['created_at']),
          field1:     String(row['field1'] ?? '') || undefined,
          field2:     String(row['field2'] ?? '') || undefined,
          field3:     String(row['field3'] ?? '') || undefined,
          field4:     String(row['field4'] ?? '') || undefined,
        },
        similarity: cosineSimilarity(queryVec, vec),
      };
    })
    .filter((r: SearchResult) => r.similarity >= minSimilarity)
    .sort((a: SearchResult, b: SearchResult) => b.similarity - a.similarity)
    .slice(0, topK);
}

// ─── Keyword search ──────────────────────────────────────────────────────────
// Exact-token fallback for camelCase/compound identifiers that don't embed well.
// Splits query into words (≥4 chars), returns chunks that contain ANY of them.
// Result similarity is set to 1.0 to rank above vector results when exact match found.

export async function keywordSearch(
  query:    string,
  opts: {
    topK?:      number;
    sourceRef?: string;
    /** Scope search to a specific field1 value (e.g. chatId) */
    field1?:    string;
  } = {},
): Promise<SearchResult[]> {
  const { topK = 5 } = opts;
  const table = await getTable();

  // Extract meaningful tokens — skip short words, strip non-alphanum, deduplicate.
  // "Specific" = CamelCase or has digit — e.g. "mHyperBTC", "mTBILL", "0x1a2b"
  const isSpecific = (t: string) => /[A-Z]/.test(t.slice(1)) || /\d/.test(t);
  const tokens = [...new Set(
    query.split(/\s+/)
      .map(w => w.replace(/[^a-zA-Z0-9]/g, ''))
      .filter(w => w.length >= 4),
  )];
  const specificTokens = tokens.filter(isSpecific);

  if (tokens.length === 0) return [];

  const tokensLow = tokens.map(t => t.toLowerCase());

  // Full table scan with optional filters, then JS-side case-insensitive token matching.
  // Combine all SQL conditions into one WHERE clause to avoid chaining uncertainty.
  let baseQ = table.query().limit(100_000);
  const conditions: string[] = [];
  if (opts.sourceRef) {
    const escaped = opts.sourceRef.replace(/"/g, '\\"').replace(/[%_]/g, '\\$&');
    conditions.push(`source_ref LIKE "${escaped}%" ESCAPE '\\'`);
  }
  if (opts.field1) {
    conditions.push(`field1 = "${opts.field1.replace(/"/g, '\\"')}"`);
  }
  if (conditions.length > 0) {
    baseQ = (baseQ as ReturnType<typeof table.query>).where(conditions.join(' AND '));
  }

  const allRows = (await baseQ.toArray()) as Array<Record<string, unknown>>;

  // Keep only rows that contain at least one token (case-insensitive JS filter)
  const rows = allRows.filter(row => {
    const cLow = String(row['content'] ?? '').toLowerCase();
    return tokensLow.some(t => cLow.includes(t));
  });

  // Score by how many query tokens appear in the chunk (simple TF proxy)
  return rows
    .map(row => {
      const cLow   = String(row['content'] ?? '').toLowerCase();
      const hits   = tokensLow.filter(t => cLow.includes(t)).length;
      // Boost: if chunk matches a specific (CamelCase/compound) token, score += 0.3 per specific hit
      const specHits = specificTokens.filter(t => cLow.includes(t.toLowerCase())).length;
      return {
        chunk: {
          id:         String(row['id']),
          sourceRef:  String(row['source_ref']),
          sourceName: String(row['source_name']),
          chunkIndex: Number(row['chunk_index']),
          content:    String(row['content']),
          tags:       String(row['tags'] ?? '').split(',').filter(Boolean),
          lineStart:  Number(row['line_start']) || undefined,
          lineEnd:    Number(row['line_end'])   || undefined,
          createdAt:  Number(row['created_at']),
          field1:     String(row['field1'] ?? '') || undefined,
          field2:     String(row['field2'] ?? '') || undefined,
          field3:     String(row['field3'] ?? '') || undefined,
          field4:     String(row['field4'] ?? '') || undefined,
        },
        similarity: Math.min(1.0, 0.5 + (hits / tokens.length) * 0.3 + specHits * 0.3),
      };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

// ─── Hybrid search ────────────────────────────────────────────────────────────
// Combines semantic (vector) + keyword results, deduplicates by chunk id,
// keyword wins on score when both methods find the same chunk.

export async function hybridSearch(
  query:  string,
  config: EmbeddingsConfig,
  opts: {
    topK?:          number;
    minSimilarity?: number;
    sourceRef?:     string;
    /** Scope to a specific field1 value — prevents cross-chat context bleed */
    field1?:        string;
    field2?:        string;
    field3?:        string;
    field4?:        string;
  } = {},
): Promise<SearchResult[]> {
  const topK = opts.topK ?? 5;

  const [vecResults, kwResults] = await Promise.all([
    // Pass minSimilarity=0 so we over-fetch all semantic candidates;
    // the final slice(0, topK) after merge handles quality control.
    semanticSearch(query, config, { ...opts, topK, minSimilarity: 0 }),
    keywordSearch(query, { topK, sourceRef: opts.sourceRef, field1: opts.field1 }),
  ]);

  // Merge: keyword results override vector results for same chunk id
  const merged = new Map<string, SearchResult>();
  for (const r of vecResults) merged.set(r.chunk.id, r);
  for (const r of kwResults)  merged.set(r.chunk.id, r); // keyword wins

  return [...merged.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function getIndexedSources(): Promise<Array<{ sourceRef: string; sourceName: string; chunks: number }>> {
  try {
    const table = await getTable();
    const rows  = await table.query().select(['source_ref', 'source_name']).toArray() as Array<Record<string, unknown>>;

    const counts = new Map<string, { sourceName: string; chunks: number }>();
    for (const row of rows) {
      const ref  = String(row['source_ref']);
      const name = String(row['source_name']);
      const cur  = counts.get(ref) ?? { sourceName: name, chunks: 0 };
      counts.set(ref, { ...cur, chunks: cur.chunks + 1 });
    }

    return Array.from(counts.entries())
      .map(([sourceRef, v]) => ({ sourceRef, ...v }))
      .sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
  } catch {
    return [];
  }
}
