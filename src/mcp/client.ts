/**
 * MCP Client — connects to MCP servers and exposes their tools.
 *
 * Like OpenClaw: uses @modelcontextprotocol/sdk to connect via stdio transport,
 * discovers tools, and executes them. Tools are injected into the LLM tool loop.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createLogger } from '../logger.js';
import type { McpServer } from '../config/schema.js';
import type { ToolDefinition, ToolExecutor } from '../llm/tool-loop.js';

const log = createLogger('mcp-client');

interface McpConnection {
  server: McpServer;
  client: Client;
  transport: StdioClientTransport;
  tools: ToolDefinition[];
}

const connections = new Map<string, McpConnection>();

/**
 * Connect to all configured MCP servers, discover their tools.
 */
export async function connectMcpServers(servers: McpServer[]): Promise<void> {
  const enabled = servers.filter(s => s.enabled && s.type === 'stdio');
  if (enabled.length === 0) return;

  log.info(`Connecting to ${enabled.length} MCP server(s)…`);

  for (const server of enabled) {
    try {
      await connectServer(server);
    } catch (e) {
      log.error(`Failed to connect MCP server "${server.name}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function connectServer(server: McpServer): Promise<void> {
  if (!server.command) {
    log.warn(`MCP server "${server.name}" has no command — skipping`);
    return;
  }

  // Skip servers with missing/empty required env vars (resolveSecretRefs in loadConfig already expanded $KEYs)
  const serverEnv = server.env ?? {};
  for (const [k, v] of Object.entries(serverEnv)) {
    if (!v || (typeof v === 'string' && v.startsWith('$'))) {
      log.warn(`MCP server "${server.name}" skipped — env var ${k} not configured (run: npm run setup -- --step mcp)`);
      return;
    }
  }

  const mergedEnv = { ...process.env, ...serverEnv } as Record<string, string>;

  log.info(`Connecting to MCP server "${server.name}": ${server.command} ${server.args.join(' ')}`);

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: mergedEnv,
  });

  const client = new Client({
    name: 'argos',
    version: '1.0.0',
  });

  await client.connect(transport);

  // Discover tools
  const toolsResult = await client.listTools();
  const tools: ToolDefinition[] = toolsResult.tools.map(t => ({
    name: `mcp_${server.name}_${t.name}`,
    description: `[${server.name}] ${t.description ?? t.name}`,
    input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
  }));

  connections.set(server.name, { server, client, transport, tools });
  log.info(`MCP server "${server.name}" connected — ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`);
}

/**
 * Get all tools from all connected MCP servers.
 */
export function getMcpTools(): ToolDefinition[] {
  const allTools: ToolDefinition[] = [];
  for (const conn of connections.values()) {
    allTools.push(...conn.tools);
  }
  return allTools;
}

/**
 * Execute an MCP tool by name.
 */
// Read-only MCP tools that can execute directly (no approval needed)
const READ_ONLY_PATTERNS = [
  /get/i, /list/i, /retrieve/i, /search/i, /query/i, /self/i,
];

function isReadOnly(toolName: string): boolean {
  return READ_ONLY_PATTERNS.some(p => p.test(toolName));
}

/**
 * Execute an MCP tool. READ operations run directly. WRITE operations require approval.
 * In executor context (proposal already approved), all tools run directly.
 */
export const executeMcpTool: ToolExecutor = async (name, input) => {
  const parts = name.match(/^mcp_([^_]+?)_(.+)$/);
  if (!parts) {
    return { output: `Invalid MCP tool name: ${name}`, error: true };
  }

  const serverName = parts[1];
  const toolName = parts[2];
  const conn = connections.get(serverName);

  if (!conn) {
    return { output: `MCP server "${serverName}" not connected`, error: true };
  }

  try {
    log.info(`Calling MCP tool: ${serverName}/${toolName}`);
    const result = await conn.client.callTool({ name: toolName, arguments: input });

    const content = (result.content as Array<{ type: string; text?: string }>)
      ?.filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n') ?? JSON.stringify(result);

    return { output: content, error: result.isError === true };
  } catch (e) {
    return { output: `MCP tool error: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
};

/**
 * Chat-safe MCP executor — read-only tools execute directly, writes create proposals.
 */
export const executeMcpToolSafe: ToolExecutor = async (name, input) => {
  const parts = name.match(/^mcp_([^_]+?)_(.+)$/);
  if (!parts) {
    return { output: `Invalid MCP tool name: ${name}`, error: true };
  }

  const toolName = parts[2];

  // Read-only → execute directly
  if (isReadOnly(toolName)) {
    return executeMcpTool(name, input);
  }

  // Write → create proposal (never execute directly from chat)
  try {
    const { getDb } = await import('../db/index.js');
    const { monotonicFactory } = await import('ulid');
    const ulid = monotonicFactory();
    const db = getDb();
    const proposalId = ulid();

    db.prepare(`
      INSERT INTO proposals (id, task_id, context_summary, plan, actions, status, created_at, expires_at)
      VALUES (?, NULL, ?, ?, ?, 'proposed', ?, ?)
    `).run(
      proposalId,
      `MCP action: ${toolName}\n${JSON.stringify(input).slice(0, 200)}`,
      `Execute ${toolName} via ${parts[1]} MCP`,
      JSON.stringify([{ tool: name, input }]),
      Date.now(),
      Date.now() + 30 * 60 * 1000,
    );

    log.info(`Proposal created for MCP write: ${proposalId} — ${toolName}`);
    return {
      output: `🔒 Approval required for write operation "${toolName}".\nProposal: ${proposalId}\n\nThe user must approve in the web app.`,
    };
  } catch (e) {
    return { output: `Proposal creation failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
};

/**
 * Disconnect all MCP servers.
 */
export async function disconnectMcpServers(): Promise<void> {
  for (const [name, conn] of connections) {
    try {
      await conn.client.close();
      log.info(`MCP server "${name}" disconnected`);
    } catch { /* */ }
  }
  connections.clear();
}
