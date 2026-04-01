import 'dotenv/config';
import { initDb, loadUlid } from '../db/index.js';
import { getDataDir, loadConfig } from '../config/index.js';
import { fetchGitHub } from '../knowledge/connectors/github.js';
import { indexDocument } from '../knowledge/indexer.js';
import { semanticSearch } from '../vector/store.js';

const config = loadConfig();
initDb(getDataDir());
await loadUlid();

const embCfg = (config as unknown as { embeddings?: import('../config/schema.js').EmbeddingsConfig }).embeddings!;

// Force fresh fetch
console.log('Fetching fresh from GitHub...');
const doc = await fetchGitHub({
  owner: 'midas-apps', repo: 'contracts',
  paths: ['config/constants/addresses.ts'],
  name: 'midas-contracts-addresses', refreshDays: 0,
});
if (!doc) { console.log('fetch failed'); process.exit(1); }

// Check if mHyperBTC is in the raw content
const raw = doc.content;
const idx = raw.toLowerCase().indexOf('mhyperbtc');
if (idx >= 0) {
  console.log('✅ mHyperBTC FOUND in file at offset', idx);
  console.log(raw.slice(Math.max(0, idx - 30), idx + 250));
} else {
  console.log('❌ mHyperBTC NOT in file — checking for similar names...');
  const btcMatches = [...raw.matchAll(/m?[Hh]yper[A-Z][a-zA-Z]*/g)].slice(0, 10);
  console.log('Hyper* tokens found:', btcMatches.map(m => m[0]).join(', '));
}

console.log('\nRe-indexing...');
await indexDocument(doc, config);
console.log('Done. Testing search...');

const results = await semanticSearch('mHyperBTC token address mainnet', embCfg, { topK: 3, minSimilarity: 0.0 });
for (const r of results) {
  console.log(`[${r.similarity.toFixed(3)}] chunk#${r.chunk.chunkIndex}: ${r.chunk.content.slice(0, 200).replace(/\n/g, ' ')}`);
}
