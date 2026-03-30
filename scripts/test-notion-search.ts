import { executeBuiltinTool } from '../src/llm/builtin-tools.js';
import { loadConfig } from '../src/config/index.js';
import { initDb } from '../src/db/index.js';

async function main() {
  const config = loadConfig();
  initDb(config.dataDir);

  console.log('NOTION_API_KEY in env:', !!process.env.NOTION_API_KEY);

  const result = await executeBuiltinTool('notion_search', { query: 'Argos' });
  console.log('Search result:', result.output);
  console.log('Error:', result.error);
}

main().catch(e => console.error('FAIL:', e.message));
