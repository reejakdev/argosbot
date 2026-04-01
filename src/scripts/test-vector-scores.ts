import 'dotenv/config';
import { initDb, loadUlid } from '../db/index.js';
import { getDataDir, loadConfig } from '../config/index.js';
import { semanticSearch } from '../vector/store.js';

const config = loadConfig();
initDb(getDataDir());
await loadUlid();

const embCfg = (config as unknown as { embeddings?: import('../config/schema.js').EmbeddingsConfig }).embeddings;
if (!embCfg?.enabled) { console.log('Embeddings disabled'); process.exit(1); }

const queries = [
  'mHyperBTC contract address mainnet',
  'mHyperBTC token',
  'token address 0x',
];

for (const q of queries) {
  console.log(`\n=== Query: "${q}" ===`);
  const results = await semanticSearch(q, embCfg, { topK: 5, minSimilarity: 0.0 });
  for (const r of results) {
    console.log(`  [${r.similarity.toFixed(3)}] ${r.chunk.sourceRef} chunk#${r.chunk.chunkIndex}`);
    console.log(`        ${r.chunk.content.slice(0, 150).replace(/\n/g, ' ')}`);
  }
}
