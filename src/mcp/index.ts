/**
 * MCP (Model Context Protocol) registry for Argos.
 *
 * Allows users to plug any MCP server into the planner — Argos passes
 * the servers to Claude via the Anthropic API's native MCP support.
 * Claude can then call any tool exposed by those servers.
 *
 * Two types of servers:
 *   url   → Remote SSE endpoint (e.g. Notion MCP, Brave Search MCP)
 *           Passed directly to the Anthropic API.
 *
 *   stdio → Local subprocess (e.g. @modelcontextprotocol/server-github)
 *           Argos starts the process and connects via stdio.
 *           Requires a local SSE bridge — Argos manages the subprocess lifecycle.
 *
 * Usage (config.json):
 * {
 *   "mcpServers": [
 *     {
 *       "name": "browser",
 *       "type": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-puppeteer"],
 *       "description": "Browser automation"
 *     },
 *     {
 *       "name": "notion-mcp",
 *       "type": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "@notionhq/notion-mcp-server"],
 *       "env": { "NOTION_API_KEY": "ntn_..." },
 *       "description": "Notion workspace via official MCP"
 *     },
 *     {
 *       "name": "brave-search",
 *       "type": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-brave-search"],
 *       "env": { "BRAVE_API_KEY": "BSA..." },
 *       "description": "Web search via Brave"
 *     }
 *   ]
 * }
 */

import { ChildProcess, spawn } from 'child_process';
import { createLogger } from '../logger.js';
import type { McpServer } from '../config/schema.js';

const log = createLogger('mcp');

// ─── Types mirroring Anthropic beta API ──────────────────────────────────────

export interface AnthropicMcpServer {
  type: 'url';
  name: string;
  url: string;
  authorization_token?: string;
}

// ─── Subprocess management ────────────────────────────────────────────────────

interface ManagedProcess {
  server: McpServer;
  process: ChildProcess;
  localUrl: string;   // http://localhost:{port}/sse
  port: number;
}

const _processes: Map<string, ManagedProcess> = new Map();

// ─── Start all configured MCP servers ────────────────────────────────────────

export async function startMcpServers(servers: McpServer[]): Promise<void> {
  const enabled = servers.filter(s => s.enabled);
  if (enabled.length === 0) return;

  log.info(`Starting ${enabled.length} MCP server(s)…`);

  for (const server of enabled) {
    try {
      if (server.type === 'stdio') {
        await startStdioServer(server);
      } else {
        log.info(`MCP server "${server.name}" (url) ready: ${server.url}`);
      }
    } catch (e) {
      log.error(`Failed to start MCP server "${server.name}": ${e}`);
    }
  }
}

export async function stopMcpServers(): Promise<void> {
  for (const [name, managed] of _processes) {
    try {
      managed.process.kill('SIGTERM');
      log.info(`MCP server "${name}" stopped`);
    } catch (e) {
      log.warn(`Failed to stop MCP server "${name}"`, e);
    }
  }
  _processes.clear();
}

// ─── Build the mcp_servers array for Anthropic API calls ─────────────────────

export function buildAnthropicMcpConfig(servers: McpServer[]): AnthropicMcpServer[] {
  const result: AnthropicMcpServer[] = [];

  for (const server of servers) {
    if (!server.enabled) continue;

    if (server.type === 'url' && server.url) {
      result.push({
        type: 'url',
        name: server.name,
        url: server.url,
        ...(server.authorizationToken ? { authorization_token: server.authorizationToken } : {}),
      });
    } else if (server.type === 'stdio') {
      // Stdio servers are proxied to a local SSE endpoint
      const managed = _processes.get(server.name);
      if (managed) {
        result.push({
          type: 'url',
          name: server.name,
          url: managed.localUrl,
        });
      } else {
        log.warn(`MCP server "${server.name}" (stdio) not running — skipping`);
      }
    }
  }

  return result;
}

// ─── Stdio → local SSE bridge ─────────────────────────────────────────────────

async function startStdioServer(server: McpServer): Promise<void> {
  if (!server.command) {
    log.warn(`MCP stdio server "${server.name}" has no command — skipping`);
    return;
  }

  // Find a free port
  const port = await getFreePort(4000);

  // We use @modelcontextprotocol/inspector's proxy or a simple wrapper.
  // Simpler: launch the stdio server and pipe it through a tiny SSE bridge.
  // For v1, we use mcp-proxy if available, else skip with a warning.

  const env = { ...process.env, ...server.env };

  log.info(`Starting MCP stdio server "${server.name}": ${server.command} ${server.args.join(' ')}`);

  // Try to use supergateway (stdio → SSE bridge) if available
  let child: ChildProcess;
  try {
    // supergateway wraps any stdio MCP as an SSE server
    child = spawn('npx', [
      '-y', 'supergateway',
      '--stdio', `${server.command} ${server.args.join(' ')}`,
      '--port', String(port),
      '--quiet',
    ], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    log.warn(`supergateway not available for "${server.name}": ${e instanceof Error ? e.message : String(e)}`);
    // Fallback: just spawn the process directly (won't be usable via API)
    child = spawn(server.command, server.args, { env, stdio: 'inherit' });
    log.warn(`MCP server "${server.name}" started but no SSE bridge — install supergateway: npm i -g supergateway`);
    return;
  }

  child.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) log.debug(`[mcp:${server.name}] ${msg}`);
  });

  child.on('exit', (code) => {
    log.warn(`MCP server "${server.name}" exited (code ${code})`);
    _processes.delete(server.name);
  });

  // Wait a moment for startup
  await new Promise(r => setTimeout(r, 1500));

  const localUrl = `http://localhost:${port}/sse`;
  _processes.set(server.name, { server, process: child, localUrl, port });
  log.info(`MCP server "${server.name}" running at ${localUrl}`);
}

// ─── Port finder ──────────────────────────────────────────────────────────────

async function getFreePort(startFrom: number): Promise<number> {
  const { createServer } = await import('net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(startFrom, () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on('error', () => getFreePort(startFrom + 1).then(resolve).catch(reject));
  });
}

// ─── Catalog entry type ───────────────────────────────────────────────────────

export interface McpCatalogEntry {
  /** Unique key used in config.json mcpServers[].name */
  name:         string;
  description:  string;
  category:     McpCategory;
  type:         'url' | 'stdio';
  /** Official = maintained by the vendor or MCP steering group */
  official:     boolean;
  /** npm package to npx-run (stdio only) */
  package?:     string;
  /** Full command override (stdio only) */
  command?:     string;
  args?:        string[];
  /** Remote SSE/HTTP endpoint (url type) */
  url?:         string;
  envVars?:     string[];
  installNote?: string;
  /** Link to docs / GitHub */
  docsUrl?:     string;
}

export type McpCategory =
  | 'search'
  | 'productivity'
  | 'dev'
  | 'database'
  | 'browser'
  | 'storage'
  | 'communication'
  | 'finance'
  | 'infra'
  | 'ai'
  | 'other';

// ─── Static catalog ───────────────────────────────────────────────────────────
// Source of truth for the setup wizard and web app plugins panel.
// Users enable entries by copying them into config.json → mcpServers[].
// Nothing here is auto-enabled.

export const MCP_CATALOG: McpCatalogEntry[] = [

  // ── Search ────────────────────────────────────────────────────────────────
  {
    name:        'brave-search',
    description: 'Web search via Brave Search API',
    category:    'search',
    type:        'stdio',
    official:    true,
    package:     '@modelcontextprotocol/server-brave-search',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-brave-search'],
    envVars:     ['BRAVE_API_KEY'],
    installNote: 'Free API key at brave.com/search/api',
    docsUrl:     'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },
  {
    name:        'exa-search',
    description: 'Neural web search and web crawling (Exa AI)',
    category:    'search',
    type:        'stdio',
    official:    false,
    package:     'exa-mcp-server',
    command:     'npx',
    args:        ['-y', 'exa-mcp-server'],
    envVars:     ['EXA_API_KEY'],
    installNote: 'Get key at exa.ai',
    docsUrl:     'https://github.com/exa-labs/exa-mcp-server',
  },
  {
    name:        'fetch',
    description: 'Fetch any URL and convert to LLM-friendly text',
    category:    'search',
    type:        'stdio',
    official:    true,
    package:     '@modelcontextprotocol/server-fetch',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-fetch'],
    docsUrl:     'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },

  // ── Productivity ──────────────────────────────────────────────────────────
  {
    name:        'notion-mcp',
    description: 'Notion workspace — official Notion MCP server (runs locally)',
    category:    'productivity',
    type:        'stdio',
    official:    true,
    package:     '@notionhq/notion-mcp-server',
    command:     'npx',
    args:        ['-y', '@notionhq/notion-mcp-server'],
    envVars:     ['NOTION_TOKEN'],
    installNote: 'Runs locally via npx — needs your Notion integration token',
    docsUrl:     'https://github.com/notionhq/notion-mcp-server',
  },
  {
    name:        'linear-mcp',
    description: 'Linear — create and manage issues, projects, cycles',
    category:    'productivity',
    type:        'url',
    official:    true,
    url:         'https://mcp.linear.app/sse',
    envVars:     ['LINEAR_API_KEY'],
    docsUrl:     'https://linear.app/docs/mcp',
  },
  {
    name:        'atlassian',
    description: 'Jira + Confluence + Compass — official Atlassian remote MCP',
    category:    'productivity',
    type:        'url',
    official:    true,
    url:         'https://mcp.atlassian.com/v1/sse',
    envVars:     ['ATLASSIAN_TOKEN'],
    docsUrl:     'https://github.com/atlassian/atlassian-mcp',
  },
  {
    name:        'todoist',
    description: 'Todoist task management — full REST API v2 access',
    category:    'productivity',
    type:        'stdio',
    official:    true,
    package:     '@doist/todoist-mcp-server',
    command:     'npx',
    args:        ['-y', '@doist/todoist-mcp-server'],
    envVars:     ['TODOIST_API_TOKEN'],
    docsUrl:     'https://github.com/Doist/todoist-mcp',
  },
  {
    name:        'google-calendar',
    description: 'Google Calendar — read/write events',
    category:    'productivity',
    type:        'stdio',
    official:    false,
    package:     '@modelcontextprotocol/server-google-calendar',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-google-calendar'],
    envVars:     ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
  },
  {
    name:        'google-drive',
    description: 'Google Drive — search files, read documents',
    category:    'storage',
    type:        'stdio',
    official:    true,
    package:     '@modelcontextprotocol/server-gdrive',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-gdrive'],
    envVars:     ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
    docsUrl:     'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive',
  },

  // ── Dev ───────────────────────────────────────────────────────────────────
  {
    name:        'github',
    description: 'GitHub — repos, issues, PRs, code search (official)',
    category:    'dev',
    type:        'stdio',
    official:    true,
    package:     '@github/github-mcp-server',
    command:     'npx',
    args:        ['-y', '@github/github-mcp-server'],
    envVars:     ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    installNote: 'Create token at github.com/settings/tokens',
    docsUrl:     'https://github.com/github/github-mcp-server',
  },
  {
    name:        'git',
    description: 'Local Git repos — read history, diff, search commits',
    category:    'dev',
    type:        'stdio',
    official:    true,
    package:     '@modelcontextprotocol/server-git',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-git'],
    docsUrl:     'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },
  {
    name:        'filesystem',
    description: 'Local filesystem — read/write files with access controls',
    category:    'dev',
    type:        'stdio',
    official:    true,
    package:     '@modelcontextprotocol/server-filesystem',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-filesystem', process.env.HOME ?? '/Users'],
    docsUrl:     'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    name:        'sequential-thinking',
    description: 'Structured multi-step reasoning (chain-of-thought scaffold)',
    category:    'ai',
    type:        'stdio',
    official:    true,
    package:     '@modelcontextprotocol/server-sequential-thinking',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    docsUrl:     'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    name:        'memory-kg',
    description: 'Persistent knowledge graph memory across sessions',
    category:    'ai',
    type:        'stdio',
    official:    true,
    package:     '@modelcontextprotocol/server-memory',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-memory'],
    docsUrl:     'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    name:        'time',
    description: 'Current time and timezone conversion',
    category:    'other',
    type:        'stdio',
    official:    true,
    package:     '@modelcontextprotocol/server-time',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-time'],
    docsUrl:     'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
  },
  {
    name:        'e2b-code',
    description: 'Sandboxed Python/JS code execution (E2B)',
    category:    'dev',
    type:        'stdio',
    official:    false,
    package:     '@e2b/mcp-server',
    command:     'npx',
    args:        ['-y', '@e2b/mcp-server'],
    envVars:     ['E2B_API_KEY'],
    installNote: 'Get sandbox API key at e2b.dev',
    docsUrl:     'https://e2b.dev/docs/mcp',
  },
  {
    name:        'vercel',
    description: 'Vercel — deployments, env vars, domains, projects',
    category:    'infra',
    type:        'stdio',
    official:    true,
    package:     '@vercel/mcp-adapter',
    command:     'npx',
    args:        ['-y', '@vercel/mcp-adapter'],
    envVars:     ['VERCEL_TOKEN'],
    docsUrl:     'https://vercel.com/docs/mcp',
  },

  // ── Browser ───────────────────────────────────────────────────────────────
  {
    name:        'puppeteer',
    description: 'Browser automation — scrape, fill forms, screenshots (local)',
    category:    'browser',
    type:        'stdio',
    official:    false,
    package:     '@modelcontextprotocol/server-puppeteer',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-puppeteer'],
    docsUrl:     'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },
  {
    name:        'browserbase',
    description: 'Cloud browser automation via Stagehand (Browserbase)',
    category:    'browser',
    type:        'url',
    official:    false,
    url:         'https://mcp.browserbase.com/mcp',
    envVars:     ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
    docsUrl:     'https://github.com/browserbase/mcp-server-browserbase',
  },

  // ── Database ──────────────────────────────────────────────────────────────
  {
    name:        'postgres',
    description: 'PostgreSQL — query databases (read-only by default)',
    category:    'database',
    type:        'stdio',
    official:    false,
    package:     '@modelcontextprotocol/server-postgres',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-postgres'],
    envVars:     ['POSTGRES_URL'],
  },
  {
    name:        'sqlite',
    description: 'SQLite — query and analyze local SQLite databases',
    category:    'database',
    type:        'stdio',
    official:    true,
    package:     '@modelcontextprotocol/server-sqlite',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '~/.argos/argos.db'],
    docsUrl:     'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
  },
  {
    name:        'supabase',
    description: 'Supabase — database, auth, edge functions (⚠ dev/staging only)',
    category:    'database',
    type:        'stdio',
    official:    true,
    package:     '@supabase/mcp-server-supabase',
    command:     'npx',
    args:        ['-y', '@supabase/mcp-server-supabase'],
    envVars:     ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    installNote: '⚠ Never use production service role key',
    docsUrl:     'https://github.com/supabase-community/supabase-mcp',
  },

  // ── Secrets / Credentials ────────────────────────────────────────────────
  {
    name:        '1password',
    description: '1Password — retrieve secrets during setup only. NOT for runtime use — secrets must never reach the planner or LLM.',
    category:    'other',
    type:        'stdio',
    official:    true,
    package:     '@1password/mcp-server',
    command:     'npx',
    args:        ['-y', '@1password/mcp-server'],
    envVars:     ['OP_SERVICE_ACCOUNT_TOKEN'],
    installNote: '⚠️ Setup use only — enable to pre-fill config.json with API keys, then disable immediately. Never leave enabled at runtime (secrets would be accessible to the planner/LLM). Generate a Service Account token at 1password.com/developer with minimal vault permissions.',
    docsUrl:     'https://developer.1password.com/docs/mcp',
  },

  // ── Communication ─────────────────────────────────────────────────────────
  {
    name:        'gmail',
    description: 'Gmail — read emails, create drafts, send, manage labels (official Google MCP)',
    category:    'communication',
    type:        'stdio',
    official:    true,
    package:     '@modelcontextprotocol/server-gmail',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-gmail'],
    envVars:     ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
    installNote: 'Uses the same Google OAuth credentials as the Calendar integration',
    docsUrl:     'https://github.com/modelcontextprotocol/servers/tree/main/src/gmail',
  },
  {
    name:        'outlook',
    description: 'Microsoft Outlook / Office 365 — read, draft, send emails via Graph API',
    category:    'communication',
    type:        'stdio',
    official:    false,
    package:     'mcp-server-outlook',
    command:     'npx',
    args:        ['-y', 'mcp-server-outlook'],
    envVars:     ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_REFRESH_TOKEN'],
    installNote: 'Register an app at portal.azure.com → App registrations',
    docsUrl:     'https://github.com/modelcontextprotocol/servers',
  },
  {
    name:        'slack',
    description: 'Slack — read channels, send messages, reply to threads',
    category:    'communication',
    type:        'stdio',
    official:    true,
    package:     '@modelcontextprotocol/server-slack',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-slack'],
    envVars:     ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    docsUrl:     'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },

  // ── Finance ───────────────────────────────────────────────────────────────
  {
    name:        'stripe',
    description: 'Stripe — customers, payments, invoices (official)',
    category:    'finance',
    type:        'stdio',
    official:    true,
    package:     '@stripe/mcp',
    command:     'npx',
    args:        ['-y', '@stripe/mcp', '--tools=all'],
    envVars:     ['STRIPE_SECRET_KEY'],
    installNote: 'Use a Restricted API Key — never the full secret key',
    docsUrl:     'https://github.com/stripe/agent-toolkit',
  },

  // ── Infra / Cloud ─────────────────────────────────────────────────────────
  {
    name:        'cloudflare',
    description: 'Cloudflare — 2500+ API endpoints, Workers, DNS, analytics',
    category:    'infra',
    type:        'url',
    official:    true,
    url:         'https://mcp.cloudflare.com/mcp',
    docsUrl:     'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
  },

  // ── Automation ────────────────────────────────────────────────────────────
  {
    name:        'zapier',
    description: 'Zapier — trigger any of 8000+ app integrations',
    category:    'other',
    type:        'url',
    official:    false,
    url:         'https://mcp.zapier.com/api/mcp/mcp',
    envVars:     ['ZAPIER_MCP_URL'],
    installNote: 'Generate your personal MCP URL at zapier.com/mcp',
    docsUrl:     'https://zapier.com/mcp',
  },
  {
    name:        'figma',
    description: 'Figma — read design tokens, layouts, component structure',
    category:    'dev',
    type:        'stdio',
    official:    false,
    package:     'figma-mcp',
    command:     'npx',
    args:        ['-y', 'figma-mcp'],
    envVars:     ['FIGMA_API_TOKEN'],
  },
  {
    name:        'spotify',
    description: 'Spotify — search, playback control, queue management',
    category:    'other',
    type:        'stdio',
    official:    false,
    package:     'mcp-server-spotify',
    command:     'npx',
    args:        ['-y', 'mcp-server-spotify'],
    envVars:     ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN'],
  },
  {
    name:        'huggingface',
    description: 'Hugging Face — models, datasets, spaces',
    category:    'ai',
    type:        'stdio',
    official:    false,
    package:     '@huggingface/mcp-server',
    command:     'npx',
    args:        ['-y', '@huggingface/mcp-server'],
    envVars:     ['HF_TOKEN'],
    docsUrl:     'https://huggingface.co/blog/mcp',
  },
];

// ─── Official MCP registry fetch ─────────────────────────────────────────────
// Pulls from registry.modelcontextprotocol.io — used to discover new servers
// not yet in the static catalog above.

const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';

export interface RegistryServer {
  id:          string;
  name:        string;
  description: string;
  package?:    string;
  url?:        string;
}

export async function fetchMcpRegistry(limit = 100): Promise<RegistryServer[]> {
  try {
    const res = await fetch(`${MCP_REGISTRY_URL}?limit=${limit}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { servers?: RegistryServer[] };
    return data.servers ?? [];
  } catch {
    return [];
  }
}

/** Returns catalog entries not yet in the static MCP_CATALOG. */
export async function fetchNewMcpServers(): Promise<RegistryServer[]> {
  const known = new Set(MCP_CATALOG.map(e => e.name));
  const remote = await fetchMcpRegistry(200);
  return remote.filter(s => !known.has(s.name) && !known.has(s.id));
}
