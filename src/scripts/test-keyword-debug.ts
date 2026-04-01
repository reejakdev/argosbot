import 'dotenv/config';
import { initDb, loadUlid } from '../db/index.js';
import { getDataDir, loadConfig } from '../config/index.js';
import { keywordSearch } from '../vector/store.js';

const config = loadConfig();
initDb(getDataDir());
await loadUlid();

// Patch: temporarily log inside the module
console.log('Testing keywordSearch for "mHyperBTC"...');
const r1 = await keywordSearch('mHyperBTC', { topK: 10 });
console.log('Results:', r1.length);
r1.forEach(r => {
  const has = r.chunk.content.toLowerCase().includes('mhyperbtc') ? '✅' : '  ';
  console.log(`${has} chunk#${r.chunk.chunkIndex} [${r.similarity.toFixed(3)}]: ${r.chunk.content.slice(0, 100).replace(/\n/g, ' ')}`);
});

console.log('\nTesting keywordSearch for "mHyperBTC contract address mainnet"...');
const r2 = await keywordSearch('mHyperBTC contract address mainnet', { topK: 5 });
console.log('Results:', r2.length);
r2.forEach(r => {
  const has = r.chunk.content.toLowerCase().includes('mhyperbtc') ? '✅' : '  ';
  console.log(`${has} chunk#${r.chunk.chunkIndex} [${r.similarity.toFixed(3)}]: ${r.chunk.content.slice(0, 100).replace(/\n/g, ' ')}`);
});
