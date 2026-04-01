import 'dotenv/config';
import { initDb, loadUlid } from '../db/index.js';
import { getDataDir, loadConfig } from '../config/index.js';
import { semanticSearch } from '../vector/store.js';

const config = loadConfig();
initDb(getDataDir());
await loadUlid();

const embCfg = (config as unknown as { embeddings?: import('../config/schema.js').EmbeddingsConfig }).embeddings!;

// Scan ALL 65 chunks for the one containing mHyperBTC
// Use a neutral query so all chunks come back
const all = await semanticSearch('contract token address mainnet', embCfg, { topK: 70, minSimilarity: 0.0 });

console.log(`Total chunks returned: ${all.length}`);
console.log('\nChunks containing mHyperBTC:');
let found = false;
for (const r of all) {
  if (r.chunk.content.toLowerCase().includes('mhyperbtc')) {
    found = true;
    console.log(`\n✅ [score: ${r.similarity.toFixed(3)}] chunk#${r.chunk.chunkIndex}:`);
    console.log(r.chunk.content.slice(0, 500));
  }
}
if (!found) console.log('  ❌ Not found in any returned chunk');

// Also try the exact query
console.log('\n=== Direct "mHyperBTC" query (topK=5, minSim=0) ===');
const direct = await semanticSearch('mHyperBTC', embCfg, { topK: 5, minSimilarity: 0.0 });
for (const r of direct) {
  const has = r.chunk.content.toLowerCase().includes('mhyperbtc') ? '✅' : '  ';
  console.log(`${has} [${r.similarity.toFixed(3)}] chunk#${r.chunk.chunkIndex}: ${r.chunk.content.slice(0, 150).replace(/\n/g, ' ')}`);
}
