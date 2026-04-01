import 'dotenv/config';
import { initDb, loadUlid } from '../db/index.js';
import { getDataDir, loadConfig } from '../config/index.js';
import { hybridSearch } from '../vector/store.js';

const config = loadConfig();
initDb(getDataDir());
await loadUlid();

const embCfg = (config as unknown as { embeddings?: import('../config/schema.js').EmbeddingsConfig }).embeddings!;

const queries = [
  'mHyperBTC contract address mainnet',
  'Can you send me the mHyperBTC contract address on mainnet?',
];

for (const q of queries) {
  console.log(`\n=== "${q}" ===`);
  const results = await hybridSearch(q, embCfg, { topK: 3, minSimilarity: 0.35 });
  for (const r of results) {
    const hasMH = r.chunk.content.includes('mHyperBTC') ? '✅' : '  ';
    console.log(`${hasMH} [${r.similarity.toFixed(3)}] chunk#${r.chunk.chunkIndex}: ${r.chunk.content.slice(0, 200).replace(/\n/g, ' ')}`);
  }
}
