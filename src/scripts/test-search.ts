import 'dotenv/config';
import { initDb, loadUlid } from '../db/index.js';
import { getDataDir, loadConfig } from '../config/index.js';
import { fetchGitHub } from '../knowledge/connectors/github.js';
import { indexDocument } from '../knowledge/indexer.js';
import { semanticSearch } from '../vector/store.js';

const config = loadConfig();
initDb(getDataDir());
await loadUlid();

const doc = await fetchGitHub({
  owner: 'midas-apps', repo: 'contracts',
  paths: ['config/constants/addresses.ts'],
  name: 'midas-contracts-addresses', refreshDays: 7,
});
if (!doc) { console.log('fetch failed'); process.exit(1); }
await indexDocument(doc, config);
console.log('Indexed OK');

const r = await semanticSearch('mHyperBTC token address', config.embeddings, { topK: 2 });
console.log('Search results:', r.length);
r.forEach(x => console.log(x.chunk.sourceRef, '\n', x.chunk.content.slice(0, 300), '\n'));
