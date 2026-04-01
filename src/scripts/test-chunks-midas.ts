import 'dotenv/config';
import { initDb, loadUlid } from '../db/index.js';
import { getDataDir, loadConfig } from '../config/index.js';
import { hybridSearch } from '../vector/store.js';

const config = loadConfig();
initDb(getDataDir());
await loadUlid();

const q = 'mBASIS redemption vault address Ethereum mainnet';
const results = await hybridSearch(q, config.embeddings, { topK: 3, minSimilarity: 0.35 });

for (const r of results) {
  const hasMBasisVault = r.chunk.content.includes('mBASIS') && r.chunk.content.includes('redemptionVault');
  console.log(`chunk#${r.chunk.chunkIndex} hasMBasisVault=${hasMBasisVault} len=${r.chunk.content.length}`);
  
  if (hasMBasisVault) {
    const idx = r.chunk.content.indexOf('mBASIS');
    console.log('  mBASIS section:', r.chunk.content.slice(idx, idx+300).replace(/\n/g,'|'));
  }
}
