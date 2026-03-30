import { connectMcpServers, getMcpTools, executeMcpTool, disconnectMcpServers } from '../src/mcp/client.js';
import { loadConfig } from '../src/config/index.js';
import { initDb } from '../src/db/index.js';

async function main() {
  const config = loadConfig();
  initDb(config.dataDir);
  await connectMcpServers(config.mcpServers);

  const tools = getMcpTools();
  console.log('Tools:', tools.length);

  // Test create-a-data-source (create database)
  const createTool = tools.find(t => t.name.includes('create-a-data-source'));
  if (createTool) {
    console.log('\nTesting database creation via MCP...');
    const result = await executeMcpTool(createTool.name, {
      parent: { page_id: '3333a1d0-68a2-809e-a6ca-de0cbfc6efcb' },
      title: [{ type: 'text', text: { content: 'Test DB via MCP' } }],
      properties: {
        Name: { title: {} },
        Status: { select: { options: [{ name: 'To Do' }, { name: 'Done' }] } },
      },
    });
    console.log('Success:', !result.error);
    console.log('Result:', result.output?.slice(0, 200));
  }

  await disconnectMcpServers();
}

main().catch(e => console.error('FAIL:', e.message));
