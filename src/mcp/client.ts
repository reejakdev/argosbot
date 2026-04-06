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

interface ToolMeta {
  rawName: string; // original tool name (without mcp_ prefix)
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

interface McpConnection {
  server: McpServer;
  client: Client;
  transport: StdioClientTransport;
  tools: ToolDefinition[];
  toolMeta: Map<string, ToolMeta>; // keyed by rawName
}

const connections = new Map<string, McpConnection>();

/**
 * Connect to all configured MCP servers, discover their tools.
 */
export async function connectMcpServers(servers: McpServer[]): Promise<void> {
  const enabled = servers.filter((s) => s.enabled && s.type === 'stdio');
  if (enabled.length === 0) return;

  log.info(`Connecting to ${enabled.length} MCP server(s)…`);

  for (const server of enabled) {
    try {
      await connectServer(server);
    } catch (e) {
      log.error(
        `Failed to connect MCP server "${server.name}": ${e instanceof Error ? e.message : String(e)}`,
      );
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
      log.warn(
        `MCP server "${server.name}" skipped — env var ${k} not configured (run: npm run setup -- --step mcp)`,
      );
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
  const toolMeta = new Map<string, ToolMeta>();

  const tools: ToolDefinition[] = toolsResult.tools.map((t) => {
    const ann =
      (t as unknown as { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } })
        .annotations ?? {};
    toolMeta.set(t.name, {
      rawName: t.name,
      readOnlyHint: ann.readOnlyHint ?? false,
      destructiveHint: ann.destructiveHint ?? false,
    });
    return {
      name: `mcp_${server.name}_${t.name}`,
      description: `[${server.name}] ${t.description ?? t.name}`,
      input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<
        string,
        unknown
      >,
    };
  });

  connections.set(server.name, { server, client, transport, tools, toolMeta });
  log.info(`MCP server "${server.name}" connected — ${tools.length} tool(s)`);
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
 * Get metadata for all tools per connected server (for admin UI).
 */
export function getMcpToolsWithMeta(): Array<{
  serverName: string;
  tools: Array<{ name: string; readOnlyHint: boolean; destructiveHint: boolean }>;
}> {
  return Array.from(connections.entries()).map(([serverName, conn]) => ({
    serverName,
    tools: Array.from(conn.toolMeta.values()).map((m) => ({
      name: m.rawName,
      readOnlyHint: m.readOnlyHint,
      destructiveHint: m.destructiveHint,
    })),
  }));
}

type PolicyValue = 'allow' | 'approve' | 'block';

/**
 * Resolve effective policy for a tool.
 * Priority: explicit per-tool config → server default config → annotation fallback.
 */
export function getToolPolicy(
  serverName: string,
  toolName: string,
  mcpServers: McpServer[],
): PolicyValue {
  const serverCfg = mcpServers.find((s) => s.name === serverName);
  const policy = serverCfg?.toolPolicy as Record<string, PolicyValue> | undefined;

  if (policy) {
    // Explicit per-tool override
    if (policy[toolName] && ['allow', 'approve', 'block'].includes(policy[toolName])) {
      return policy[toolName];
    }
    // Server-level default
    if (policy['default'] && ['allow', 'approve', 'block'].includes(policy['default'])) {
      return policy['default'] as PolicyValue;
    }
  }

  // Annotation fallback: readOnlyHint → allow, else approve
  const conn = connections.get(serverName);
  const meta = conn?.toolMeta.get(toolName);
  if (meta?.readOnlyHint) return 'allow';

  return 'approve';
}

/**
 * Execute an MCP tool directly (no policy check — use in approved contexts).
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

    const content =
      (result.content as Array<{ type: string; text?: string }>)
        ?.filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n') ?? JSON.stringify(result);

    return { output: content, error: result.isError === true };
  } catch (e) {
    return { output: `MCP tool error: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
};

/**
 * Chat-safe MCP executor — checks tool policy before executing.
 *
 * allow  → execute directly, no approval needed.
 * approve → tell the LLM to create ONE task-level proposal describing what it wants
 *           to accomplish with this server. The user sees a single approval request
 *           with full context. Once approved, executeWithAgent runs with direct access
 *           to all tools (only 'block' is checked in that context).
 * block  → reject unconditionally.
 */
export const executeMcpToolSafe: ToolExecutor = async (name, input) => {
  const parts = name.match(/^mcp_([^_]+?)_(.+)$/);
  if (!parts) {
    return { output: `Invalid MCP tool name: ${name}`, error: true };
  }

  const serverName = parts[1];
  const toolName = parts[2];

  const { getConfig } = await import('../config/index.js');
  const cfg = getConfig() as unknown as { mcpServers?: McpServer[] };
  const policy = getToolPolicy(serverName, toolName, cfg.mcpServers ?? []);

  if (policy === 'block') {
    return {
      output: `Tool "${toolName}" on server "${serverName}" is blocked by policy.`,
      error: true,
    };
  }

  if (policy === 'allow') {
    return executeMcpTool(name, input);
  }

  // 'approve' — ask the LLM to create a single task-level proposal
  return {
    output:
      `[${serverName}] requires approval before use.\n\n` +
      `Do NOT call individual tools from this server yet. Instead, use create_proposal to ` +
      `describe the full task you want to accomplish (e.g. "navigate to X, fill in form Y, ` +
      `click Submit"). Be specific about the goal so the user can make an informed decision.\n\n` +
      `Once the user approves the proposal, you will have full access to all ${serverName} tools ` +
      `for this task — no further approval needed.`,
  };
};

/**
 * Disconnect all MCP servers.
 */
export async function disconnectMcpServers(): Promise<void> {
  for (const [name, conn] of connections) {
    try {
      await conn.client.close();
      log.info(`MCP server "${name}" disconnected`);
    } catch {
      /* */
    }
  }
  connections.clear();
}
