import { connectMcpServers, getMcpTools, executeMcpTool, disconnectMcpServers } from '../src/mcp/client.js';
import { loadConfig } from '../src/config/index.js';
import { initDb } from '../src/db/index.js';

async function main() {
  const config = loadConfig();
  initDb(config.dataDir);

  console.log('Connecting MCP servers...');
  await connectMcpServers(config.mcpServers);

  const tools = getMcpTools();
  console.log(`\nTools discovered: ${tools.length}`);
  tools.forEach(t => console.log(`  - ${t.name}: ${t.description?.slice(0, 60)}`));

  // Test search
  const searchTool = tools.find(t => t.name.includes('search'));
  if (searchTool) {
    console.log(`\nTesting: ${searchTool.name}`);
    const r = await executeMcpTool(searchTool.name, { query: 'Argos' });
    console.log('Result:', r.output?.slice(0, 300));
    console.log('Error:', r.error);
  } else {
    console.log('\nNo search tool found');
  }

  await disconnectMcpServers();
}

main().catch(e => console.error('FAIL:', e.message));
