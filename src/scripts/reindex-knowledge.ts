/**
 * Force re-index all knowledge sources — clears cache and re-fetches everything.
 */
import 'dotenv/config';
import { initDb, loadUlid, getDb } from '../db/index.js';
import { getDataDir, loadConfig } from '../config/index.js';
import { fetchGitHub } from '../knowledge/connectors/github.js';
import { fetchUrl } from '../knowledge/connectors/url.js';
import { indexDocument } from '../knowledge/indexer.js';

const config = loadConfig();
initDb(getDataDir());
await loadUlid();

const db = getDb();

// Clear existing knowledge cache so isStale() always returns true
db.prepare(`DELETE FROM memories WHERE category = 'context'`).run();
console.log('Cleared cached knowledge entries\n');

let ok = 0, fail = 0;

for (const source of config.knowledge.sources) {
  process.stdout.write(`Fetching [${source.name}]... `);
  try {
    let doc = null;
    if (source.type === 'github') {
      doc = await fetchGitHub({
        owner:       source.owner,
        repo:        source.repo,
        paths:       source.paths,
        name:        source.name,
        refreshDays: source.refreshHours / 24,
      });
    } else if (source.type === 'url') {
      doc = await fetchUrl({
        url:         (source as { url: string }).url,
        name:        source.name,
        refreshDays: source.refreshHours / 24,
      });
    }

    if (doc) {
      await indexDocument(doc, config);
      const size = (doc.fullText ?? doc.content).length;
      console.log(`✓  ${size.toLocaleString()} chars`);
      ok++;
    } else {
      console.log(`✗  null returned`);
      fail++;
    }
  } catch (e) {
    console.log(`✗  ERROR: ${e}`);
    fail++;
  }
}

console.log(`\nDone: ${ok} indexed, ${fail} failed`);

// Show vector store stats
const { getIndexedSources } = await import('../vector/store.js');
const sources = await getIndexedSources();
console.log('\nVector store:');
for (const s of sources) {
  console.log(`  ${s.sourceRef.padEnd(50)} ${s.chunks} chunks`);
}
