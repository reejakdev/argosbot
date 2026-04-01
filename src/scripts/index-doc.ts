/**
 * index-doc — ingest any local file or URL into the LanceDB knowledge store.
 *
 * Usage:
 *   npx tsx src/scripts/index-doc.ts --file /path/to/doc.pdf --name "My Doc"
 *   npx tsx src/scripts/index-doc.ts --url https://docs.example.com --name "Example Docs"
 *   npx tsx src/scripts/index-doc.ts --file ./addresses.ts --name "Midas Addresses" --tags code,midas
 *
 * The document is chunked (brace-aware for .ts/.json, line-based for prose)
 * and added to LanceDB under:
 *   doc:<slug>  (file) or  url:<url>  (URL)
 *
 * Re-running with the same name replaces the existing chunks (hard delete + reindex).
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { initDb, loadUlid, getDb } from '../db/index.js';
import { getDataDir, loadConfig } from '../config/index.js';

// ─── Parse CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const filePath = get('--file');
const url      = get('--url');
const name     = get('--name');
const tagsArg  = get('--tags');

if ((!filePath && !url) || !name) {
  console.error('Usage:');
  console.error('  index-doc --file /path/to/file --name "Label" [--tags tag1,tag2]');
  console.error('  index-doc --url https://... --name "Label" [--tags tag1,tag2]');
  process.exit(1);
}

const config = loadConfig();
initDb(getDataDir());
await loadUlid();

if (!config.embeddings?.enabled) {
  console.error('Embeddings are not enabled in config. Set embeddings.enabled = true and configure the endpoint.');
  process.exit(1);
}

const extraTags = tagsArg ? tagsArg.split(',').map(t => t.trim()).filter(Boolean) : [];

// ─── Load content ──────────────────────────────────────────────────────────────

let fullText: string;
let sourceRef: string;
let isCode = false;

if (filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }
  fullText  = fs.readFileSync(absPath, 'utf8');
  const ext = path.extname(absPath).toLowerCase();
  isCode    = ['.ts', '.js', '.json', '.yaml', '.yml'].includes(ext);
  // Slug: strip non-alphanum, truncate
  const slug = path.basename(absPath, ext).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  sourceRef  = `doc:${slug}`;
  console.log(`File loaded: ${absPath} (${fullText.length.toLocaleString()} chars)`);

} else {
  // Fetch URL
  console.log(`Fetching: ${url}`);
  const res = await fetch(url!, {
    headers: { 'User-Agent': 'Argos/1.0 (index-doc)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.error(`Fetch failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const contentType = res.headers.get('content-type') ?? '';
  let raw = await res.text();
  if (contentType.includes('text/html')) {
    // Naive HTML strip — remove tags, collapse whitespace
    raw = raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  fullText  = raw;
  sourceRef = `url:${url!.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60)}`;
  console.log(`URL fetched: ${url} (${fullText.length.toLocaleString()} chars)`);
}

// ─── Chunk ─────────────────────────────────────────────────────────────────────

const { chunkText, chunkCode, indexChunks, cleanSource, getIndexedSources } = await import('../vector/store.js');

const tags = ['doc', name.toLowerCase().replace(/\s+/g, '_'), ...extraTags];
if (isCode) tags.push('code');

console.log(`Chunking (${isCode ? 'code-aware' : 'line-based'})…`);

const chunks = isCode
  ? chunkCode(fullText, sourceRef, name, tags)
  : chunkText(fullText, sourceRef, name, tags);

console.log(`→ ${chunks.length} chunk(s)`);

if (chunks.length === 0) {
  console.error('No chunks produced — content too short?');
  process.exit(1);
}

// ─── Index ─────────────────────────────────────────────────────────────────────

console.log(`Cleaning old entries for "${sourceRef}"…`);
await cleanSource(sourceRef);

console.log(`Embedding and indexing…`);
await indexChunks(chunks, config.embeddings);

// ─── Also upsert into SQLite memories (category=context) so FTS search picks it up ──

const db = getDb();
const existing = db.prepare(`SELECT id FROM memories WHERE source_ref = ? AND category = 'context'`).get(sourceRef) as { id: string } | undefined;

const summary = `[${name}]\n${fullText.slice(0, 1500)}${fullText.length > 1500 ? '\n\n[…full content indexed in vector store]' : ''}`;

if (existing) {
  db.prepare(`UPDATE memories SET content = ?, tags = ?, created_at = ? WHERE id = ?`)
    .run(summary, JSON.stringify(tags), Date.now(), existing.id);
  console.log(`SQLite memory updated: ${existing.id}`);
} else {
  const { monotonicFactory } = await import('ulid');
  const ulid = monotonicFactory();
  const id = ulid();
  db.prepare(`
    INSERT INTO memories (id, content, tags, category, source_ref, importance, archived, expires_at, created_at)
    VALUES (?, ?, ?, 'context', ?, 7, 1, NULL, ?)
  `).run(id, summary, JSON.stringify(tags), sourceRef, Date.now());
  console.log(`SQLite memory created: ${id}`);
}

// ─── Show result ───────────────────────────────────────────────────────────────

console.log(`\n✓ "${name}" indexed as ${sourceRef}`);
console.log(`  ${chunks.length} chunks | tags: ${tags.join(', ')}`);

const sources = await getIndexedSources();
const entry   = sources.find(s => s.sourceRef === sourceRef);
if (entry) console.log(`  LanceDB: ${entry.chunks} chunks confirmed`);
