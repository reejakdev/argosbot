import { loadConfig } from '../src/config/index.js';
import { initDb } from '../src/db/index.js';
import { executeBuiltinTool } from '../src/llm/builtin-tools.js';

async function test() {
  const config = loadConfig();
  initDb(config.dataDir);

  // Test create_proposal
  const result = await executeBuiltinTool('create_proposal', {
    action: 'Create Notion test database',
    details: 'Database named "gogo" with columns: Title, Status, Notes',
    risk: 'low',
  });
  console.log('Result:', result.output);

  // Test write_file proposal
  const result2 = await executeBuiltinTool('write_file', {
    path: 'user.md',
    content: '---\nname: Emeric\nrole: Solution Engineer\n---\n',
    reason: 'Save user profile from onboarding',
  });
  console.log('Result2:', result2.output);
}

test().catch(e => console.error('FAIL:', e.message));
