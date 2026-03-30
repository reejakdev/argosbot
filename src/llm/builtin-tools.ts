/**
 * Built-in tools available to the chat bot.
 * These run locally — no MCP server needed.
 */

import type { ToolDefinition, ToolExecutor } from './tool-loop.js';
import { createLogger } from '../logger.js';

const log = createLogger('tools');

export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the web using DuckDuckGo. Returns top results with titles, URLs, and snippets.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    description: 'Fetch and read the content of a URL. Returns the text content.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'memory_search',
    description: 'Search Argos memory for past conversations, facts, and decisions.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_store',
    description: 'Save an important fact, decision, or preference to long-term memory.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What to remember' },
        category: { type: 'string', enum: ['preference', 'fact', 'task', 'decision', 'context'], description: 'Category' },
      },
      required: ['content'],
    },
  },
  {
    name: 'current_time',
    description: 'Get the current date and time.',
    input_schema: { type: 'object', properties: {} },
  },
  // Notion tools are provided by MCP server (notion-mcp).
  // api_call is available for when MCP endpoints fail or for custom API calls.
  {
    name: 'api_call',
    description: 'Make an HTTP API call. Use this when MCP tools fail or for direct API access. Secrets (API keys) from config are auto-injected via {{SECRET_NAME}} placeholders in headers.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method' },
        url: { type: 'string', description: 'Full URL' },
        headers: { type: 'object', description: 'HTTP headers (use {{NOTION_API_KEY}} for auto-inject)' },
        body: { type: 'object', description: 'Request body (JSON)' },
      },
      required: ['method', 'url'],
    },
  },
  {
    name: 'cancel_proposals',
    description: 'Cancel/reject all pending proposals, or a specific one by ID. Use this to clean up old proposals before creating new ones.',
    input_schema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string', description: 'Specific proposal ID to cancel (optional — omit to cancel all pending)' },
      },
    },
  },
  {
    name: 'list_proposals',
    description: 'List all pending proposals waiting for approval.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_proposal',
    description: 'Create an approval request for any action that requires user permission. Use this for: creating Notion databases, sending messages, creating tickets, modifying external services, or any write operation. The user will approve/reject in the web app with 2FA.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What to do (e.g. "Create Notion database", "Send reply to partner")' },
        details: { type: 'string', description: 'Full details of the action (parameters, content, etc.)' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Risk level' },
      },
      required: ['action', 'details'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the Argos data directory (~/.argos/).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within ~/.argos/ (e.g. user.md, config.json)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Propose writing a file to ~/.argos/. This creates an approval request — the file is NOT written until the user approves. Use this for user.md, config changes, etc.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within ~/.argos/' },
        content: { type: 'string', description: 'File content to write' },
        reason: { type: 'string', description: 'Why this file should be written (shown to user in approval)' },
      },
      required: ['path', 'content'],
    },
  },
];

/**
 * Execute a built-in tool.
 */
export const executeBuiltinTool: ToolExecutor = async (name, input) => {
  switch (name) {
    case 'web_search':
      return await toolWebSearch(input.query as string);
    case 'fetch_url':
      return await toolFetchUrl(input.url as string);
    case 'memory_search':
      return await toolMemorySearch(input.query as string, input.limit as number | undefined);
    case 'memory_store':
      return await toolMemoryStore(input.content as string, input.category as string | undefined);
    case 'current_time':
      return { output: new Date().toISOString() };
    case 'read_file':
      return toolReadFile(input.path as string);
    case 'write_file':
      return await toolWriteFileProposal(input.path as string, input.content as string, input.reason as string | undefined);
    case 'cancel_proposals':
      return await toolCancelProposals(input.proposal_id as string | undefined);
    case 'list_proposals':
      return await toolListProposals();
    case 'create_proposal':
      return await toolCreateProposal(input.action as string, input.details as string, input.risk as string | undefined);
    case 'api_call':
      return await toolApiCall(input);
    default:
      return { output: `Unknown tool: ${name}`, error: true };
  }
};

// ─── Tool implementations ─────────────────────────────────────────────────────

async function toolWebSearch(query: string): Promise<{ output: string; error?: boolean }> {
  try {
    // DuckDuckGo HTML search (no API key needed)
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Argos/1.0)' },
    });
    const html = await res.text();

    // Extract results from HTML
    const results: string[] = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < 5) {
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      const snippet = match[3].replace(/<[^>]+>/g, '').trim();
      const link = match[1];
      results.push(`${title}\n${link}\n${snippet}`);
    }

    if (results.length === 0) {
      // Fallback: simpler extraction
      const simpleRegex = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
      while ((match = simpleRegex.exec(html)) !== null && results.length < 5) {
        results.push(match[1].replace(/<[^>]+>/g, '').trim());
      }
    }

    return { output: results.length > 0 ? results.join('\n\n---\n\n') : 'No results found.' };
  } catch (e) {
    return { output: `Search failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

async function toolFetchUrl(url: string): Promise<{ output: string; error?: boolean }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Argos/1.0)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { output: `HTTP ${res.status}`, error: true };

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('html')) {
      const html = await res.text();
      // Strip HTML tags, scripts, styles
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);
      return { output: text };
    }

    const text = await res.text();
    return { output: text.slice(0, 8000) };
  } catch (e) {
    return { output: `Fetch failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

async function toolMemorySearch(query: string, limit?: number): Promise<{ output: string; error?: boolean }> {
  try {
    const { search } = await import('../memory/store.js');
    const results = search({ query, limit: limit ?? 5 });
    if (results.length === 0) return { output: 'No memories found.' };
    return {
      output: results.map(m => `[${m.category}] ${m.content} (importance: ${m.importance})`).join('\n'),
    };
  } catch (e) {
    return { output: `Memory search failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

async function toolMemoryStore(content: string, category?: string): Promise<{ output: string; error?: boolean }> {
  try {
    const { storeQuick } = await import('../memory/store.js');
    const entry = storeQuick(content, category ?? 'general');
    return { output: `Stored memory ${entry.id}: "${content.slice(0, 50)}"` };
  } catch (e) {
    return { output: `Memory store failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Shared helper — creates a proposal in the DB matching the real schema.
 */
// Whitelist of env vars allowed for {{PLACEHOLDER}} injection in api_call headers.
// NEVER add private keys, Telegram credentials, or session secrets here.
const ALLOWED_SECRET_KEYS = new Set([
  'NOTION_API_KEY',
  'NOTION_TOKEN',
  'BRAVE_API_KEY',
  'OPENAI_API_KEY',
  'LINEAR_API_KEY',
  'STRIPE_SECRET_KEY',
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'EXA_API_KEY',
  'BROWSERBASE_API_KEY',
  'TODOIST_API_TOKEN',
  'SLACK_BOT_TOKEN',
  'HF_TOKEN',
  'E2B_API_KEY',
  'VERCEL_TOKEN',
]);

async function toolApiCall(input: Record<string, unknown>): Promise<{ output: string; error?: boolean }> {
  const method = (input.method as string) ?? 'GET';
  const url = input.url as string;
  if (!url) return { output: 'URL is required', error: true };

  // Security: block calls to localhost/internal networks
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    ) {
      return { output: 'Security: internal network calls blocked', error: true };
    }
  } catch {
    return { output: `Invalid URL: ${url}`, error: true };
  }

  try {
    // Inject secrets via {{PLACEHOLDER}} syntax — only whitelisted keys
    const headers = (input.headers ?? {}) as Record<string, string>;
    const resolvedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      resolvedHeaders[k] = v.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
        if (!ALLOWED_SECRET_KEYS.has(key)) {
          log.warn(`api_call: blocked injection of non-whitelisted env var: ${key}`);
          return `{{${key}}}`;
        }
        return process.env[key] ?? `{{${key}}}`;
      });
    }

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...resolvedHeaders },
      ...(input.body && method !== 'GET' ? { body: JSON.stringify(input.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });

    const body = await res.text();
    const truncated = body.length > 2000 ? body.slice(0, 2000) + '…' : body;

    if (!res.ok) {
      return { output: `HTTP ${res.status}: ${truncated}`, error: true };
    }
    return { output: truncated };
  } catch (e) {
    return { output: `API call failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

async function toolCancelProposals(proposalId?: string): Promise<{ output: string; error?: boolean }> {
  try {
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    if (proposalId) {
      db.prepare("UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by Argos' WHERE id = ? AND status = 'proposed'").run(proposalId);
      return { output: `Proposal ${proposalId.slice(-8)} cancelled.` };
    }
    const result = db.prepare("UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by Argos' WHERE status = 'proposed'").run();
    return { output: `${result.changes} pending proposal(s) cancelled.` };
  } catch (e) {
    return { output: `Error: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

async function toolListProposals(): Promise<{ output: string; error?: boolean }> {
  try {
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    const rows = db.prepare("SELECT id, plan, status, created_at FROM proposals WHERE status = 'proposed' ORDER BY created_at DESC LIMIT 10")
      .all() as Array<{ id: string; plan: string; status: string; created_at: number }>;
    if (rows.length === 0) return { output: 'No pending proposals.' };
    return {
      output: rows.map(r => `- ${r.id.slice(-8)} | ${r.plan.slice(0, 60)}`).join('\n'),
    };
  } catch (e) {
    return { output: `Error: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

async function createProposalInDb(
  contextSummary: string,
  plan: string,
  actions: Array<Record<string, unknown>>,
  _risk: string,
): Promise<string> {
  const { getDb } = await import('../db/index.js');
  const { monotonicFactory } = await import('ulid');
  const ulid = monotonicFactory();
  const db = getDb();

  const proposalId = ulid();

  // Schema: id, task_id, context_summary, plan, actions, draft_reply, status, created_at, approved_at, executed_at, expires_at, rejection_reason
  db.prepare(`
    INSERT INTO proposals (id, task_id, context_summary, plan, actions, status, created_at, expires_at)
    VALUES (?, NULL, ?, ?, ?, 'proposed', ?, ?)
  `).run(
    proposalId,
    contextSummary,
    plan,
    JSON.stringify(actions),
    Date.now(),
    Date.now() + 30 * 60 * 1000,
  );

  log.info(`Proposal created: ${proposalId} — ${plan.slice(0, 60)}`);
  return proposalId;
}

async function toolCreateProposal(action: string, details: string, risk?: string): Promise<{ output: string; error?: boolean }> {
  try {
    const riskLevel = risk ?? 'medium';
    const proposalId = await createProposalInDb(
      `${action}\n\n${details}`,
      action,
      [{ action, details, risk: riskLevel }],
      riskLevel,
    );

    const riskEmoji = riskLevel === 'high' ? '🔴' : riskLevel === 'medium' ? '🟡' : '🟢';

    return {
      output: `${riskEmoji} Approval request created.\n\nProposal: ${proposalId}\nAction: ${action}\nRisk: ${riskLevel}\n\n🔒 The user must approve this in the web app (2FA required). Tell the user to open their approvals dashboard.`,
    };
  } catch (e) {
    return { output: `Proposal creation failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

function getDataDir(): string {
  const dir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
  return dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : dir;
}

function toolReadFile(relPath: string): { output: string; error?: boolean } {
  // Security: prevent path traversal
  const normalized = path.normalize(relPath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return { output: 'Security: path traversal not allowed', error: true };
  }
  const fullPath = path.join(getDataDir(), normalized);
  try {
    return { output: fs.readFileSync(fullPath, 'utf8') };
  } catch {
    return { output: `File not found: ${relPath}`, error: true };
  }
}

async function toolWriteFileProposal(relPath: string, content: string, reason?: string): Promise<{ output: string; error?: boolean }> {
  const normalized = path.normalize(relPath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return { output: 'Security: path traversal not allowed', error: true };
  }

  try {
    const fullPath = path.join(getDataDir(), normalized);
    let existingContent: string | null = null;
    try { existingContent = fs.readFileSync(fullPath, 'utf8'); } catch { /* */ }

    const diffNote = existingContent ? '(file exists — will be overwritten)' : '(new file)';
    const preview = content.length > 200 ? content.slice(0, 200) + '…' : content;
    const proposalId = await createProposalInDb(
      `Write file: ${relPath} ${diffNote}${reason ? ` — ${reason}` : ''}`,
      `Write file ${relPath}. ${reason ?? ''}`,
      [{ tool: 'write_file', input: { path: relPath, content }, description: reason ?? `Write ${relPath}` }],
      'low',
    );

    return {
      output: `📋 Approval required to write "${relPath}" ${diffNote}.\nProposal ID: ${proposalId}\nPreview:\n${preview}\n\n🔒 The user must approve this in the web app (2FA required).`,
    };
  } catch (e) {
    return { output: `Proposal creation failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}
