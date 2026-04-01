/**
 * Test draft reply generation in isolation — no triage, no pipeline.
 * Tests only the generateDraftReply code path.
 */
import 'dotenv/config';
import { initDb, loadUlid } from '../db/index.js';
import { getDataDir, loadConfig } from '../config/index.js';
import { llmConfigFromConfig } from '../llm/index.js';

const config = loadConfig();
initDb(getDataDir());
await loadUlid();

const llmConfig = llmConfigFromConfig(config, { maxTokens: config.claude.maxTokens });

console.log('Testing LLM call directly for draft reply...');
console.log('Model:', llmConfig.model, '| authMode:', llmConfig.authMode);

// Simulate what generateDraftReply does
const { hybridSearch } = await import('../vector/store.js');
const embCfg = (config as unknown as { embeddings?: import('../config/schema.js').EmbeddingsConfig }).embeddings;

console.log('Embeddings enabled:', embCfg?.enabled);

let knowledgeContext = '';
if (embCfg?.enabled) {
  const t0 = Date.now();
  const results = await hybridSearch('Hi, can you send me the mHyperBTC contract address on mainnet?', embCfg, { topK: 3, minSimilarity: 0.35 });
  console.log(`Hybrid search: ${results.length} chunks in ${Date.now() - t0}ms`);
  if (results.length) {
    knowledgeContext = results.map(r => r.chunk.content).join('\n\n');
    console.log('Knowledge context length:', knowledgeContext.length, 'chars');
    console.log('First 200 chars:', knowledgeContext.slice(0, 200));
  }
}

const { llmCall } = await import('../llm/index.js');

const systemPrompt = `You are Stanley. Write a reply to a partner message IN FIRST PERSON.
If the partner is asking for specific data (addresses, amounts, info) AND you have it in the context below — include it directly in your reply.
If you don't have the data — say you'll send it shortly, don't make things up.
Same language as the partner. No greeting, no subject line — just the message body.
NEVER refer to yourself in third person.${knowledgeContext ? `\n\nRelevant knowledge:\n${knowledgeContext.slice(0, 1200)}` : ''}`;

console.log('\nSystem prompt length:', systemPrompt.length, 'chars');
console.log('Calling LLM...');
const t1 = Date.now();

const response = await llmCall(llmConfig, [
  { role: 'system', content: systemPrompt },
  { role: 'user', content: 'Partner: Julien\nTheir message: Hi, can you send me the mHyperBTC contract address on mainnet?' },
]);

console.log(`LLM responded in ${Date.now() - t1}ms`);
console.log('\nDraft reply:');
console.log(response.content);
