import 'dotenv/config';
import { initDb, loadUlid } from '../db/index.js';
import { getDataDir, loadConfig } from '../config/index.js';
import { semanticSearch, getIndexedSources } from '../vector/store.js';

const config = loadConfig();
initDb(getDataDir());
await loadUlid();

const embCfg = (config as unknown as { embeddings?: import('../config/schema.js').EmbeddingsConfig }).embeddings;
if (!embCfg?.enabled) { console.log('Embeddings disabled'); process.exit(1); }

// List all indexed sources
const sources = await getIndexedSources();
console.log(`Indexed sources (${sources.length}):`);
for (const s of sources) console.log(`  - ${s.sourceRef} (${s.chunks} chunks)`);

// Search for hypeBTC/mHyperBTC with no similarity filter
console.log('\n=== All hypeBTC/HyperBTC chunks (minSimilarity=0) ===');
const results = await semanticSearch('hypeBTC mHyperBTC', embCfg, { topK: 10, minSimilarity: 0.0 });
for (const r of results) {
  const hasHyper = r.chunk.content.toLowerCase().includes('hyperbtc') || r.chunk.content.toLowerCase().includes('mhyper');
  if (hasHyper) {
    console.log(`✅ [${r.similarity.toFixed(3)}] chunk#${r.chunk.chunkIndex}:`);
    console.log(r.chunk.content.slice(0, 400));
    console.log('');
  }
}

// Direct text scan using a broader search
console.log('\n=== Searching for "hype" tokens ===');
const hyper = await semanticSearch('hypeBTC hyperBTC mHyperBTC btc bitcoin', embCfg, { topK: 5, minSimilarity: 0.0 });
for (const r of hyper) {
  console.log(`[${r.similarity.toFixed(3)}] chunk#${r.chunk.chunkIndex}: ${r.chunk.content.slice(0, 200).replace(/\n/g, ' ')}`);
}
