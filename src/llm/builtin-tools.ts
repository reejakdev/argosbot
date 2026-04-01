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
    name: 'index_content',
    description: 'Fetch and index content into the vector store for semantic search. Supports GitHub files, URLs, and raw text. Use this to ingest docs, contract files, job specs, or any reference content so it can be retrieved later with semantic_search.',
    input_schema: {
      type: 'object',
      properties: {
        type:    { type: 'string', enum: ['github', 'url', 'text'], description: 'Source type' },
        source:  { type: 'string', description: 'For github: "owner/repo/path/to/file.json". For url: full URL. Not needed for text.' },
        content: { type: 'string', description: 'For type=text: the raw text to index.' },
        name:    { type: 'string', description: 'Human label for this content (e.g. "Etherlink deployments", "Job spec Q2", "Partner brief")' },
        tags:    { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering later (e.g. ["contracts", "etherlink"])' },
      },
      required: ['type', 'name'],
    },
  },
  {
    name: 'semantic_search',
    description: 'Semantic search over indexed context sources (GitHub files, URLs, Notion). Use this to find specific information in large files that may not appear in memory_search results.',
    input_schema: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'What you are looking for (natural language)' },
        top_k:  { type: 'number', description: 'Max results to return (default 5)' },
        source: { type: 'string', description: 'Optional: restrict to a source ref prefix. "github:midas-apps/contracts" matches all files in that repo. Exact file: "github:midas-apps/contracts/config/constants/addresses.ts"' },
      },
      required: ['query'],
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
    name: 'list_knowledge',
    description: 'List all files in ~/.argos/knowledge/ — the local knowledge base. Use this to discover available reference files (addresses, configs, docs) before reading them.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_file',
    description: 'Read a file from ~/.argos/ or ~/.argos/knowledge/. For large files (addresses, configs), pass a `search` term to extract only the matching lines ±10 lines of context instead of the full file.',
    input_schema: {
      type: 'object',
      properties: {
        path:   { type: 'string', description: 'Relative path within ~/.argos/ (e.g. "knowledge/addresses.ts", "user.md")' },
        search: { type: 'string', description: 'Optional: return only lines containing this string (case-insensitive) ±10 lines context. Use this on large files to find a specific contract/network.' },
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
    case 'index_content':
      return await toolIndexContent(
        input.type as string,
        input.source as string | undefined,
        input.content as string | undefined,
        input.name as string,
        input.tags as string[] | undefined,
      );
    case 'semantic_search':
      return await toolSemanticSearch(
        input.query as string,
        input.top_k as number | undefined,
        input.source as string | undefined,
      );
    case 'current_time':
      return { output: new Date().toISOString() };
    case 'list_knowledge':
      return toolListKnowledge();
    case 'read_file':
      return toolReadFile(input.path as string, input.search as string | undefined);
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

// ─── SSRF guard ───────────────────────────────────────────────────────────────
// Shared check for all outbound fetches (fetch_url, index_content, api_call).
// Blocks cloud metadata endpoints, private IP ranges, IPv6 mapped addresses.

function ssrfBlock(rawUrl: string): string | null {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return `Invalid URL: ${rawUrl}`; }

  const h = parsed.hostname.toLowerCase();

  // Reject non-HTTP(S) schemes
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return `Blocked scheme: ${parsed.protocol}`;
  }

  // Cloud metadata endpoints (AWS, GCP, Azure, DigitalOcean, Alibaba)
  const metadataHosts = [
    '169.254.169.254',      // AWS / GCP / Azure / generic link-local
    'metadata.google.internal',
    'fd00:ec2::254',        // AWS IPv6 metadata
    '100.100.100.200',      // Alibaba Cloud
  ];
  if (metadataHosts.includes(h)) return `Blocked: cloud metadata endpoint (${h})`;

  // Private / loopback / link-local ranges
  if (
    h === 'localhost' ||
    h === '0.0.0.0' ||
    h === '::1' ||
    h.endsWith('.localhost') ||
    // IPv4 loopback
    /^127\./.test(h) ||
    // RFC-1918 private ranges
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    // Link-local
    /^169\.254\./.test(h) ||
    // IPv6 mapped IPv4 (::ffff:192.168.x.x)
    /^::ffff:(0a|7f|a9fe|ac1[0-9a-f]|c0a8)/i.test(h.replace(/:/g, ''))
  ) {
    return `Blocked: private/internal network (${h})`;
  }

  return null; // safe
}

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
  const blocked = ssrfBlock(url);
  if (blocked) return { output: `Security: ${blocked}`, error: true };

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

    // Large raw GitHub files — auto-index into vector store so semantic_search works
    // Pattern: raw.githubusercontent.com/owner/repo/branch/path/to/file
    const rawGhMatch = url.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/[^/]+\/(.+)/);
    if (rawGhMatch && text.length > 8000) {
      const [, owner, repo, filePath] = rawGhMatch;
      const sourceRef  = `github:${owner}/${repo}/${filePath}`;
      const sourceName = `${owner}/${repo}/${filePath.split('/').pop()}`;
      try {
        const { chunkText, indexChunks } = await import('../vector/store.js');
        const { getEmbeddingsConfig } = await import('../config/index.js');
        const embCfg = getEmbeddingsConfig();
        if (embCfg) {
          const chunks = chunkText(text, sourceRef, sourceName);
          await indexChunks(chunks, embCfg);
          return {
            output:
              `File is ${text.length} chars — auto-indexed ${chunks.length} chunks.\n` +
              `Use semantic_search with source="${sourceRef}" to query it.\n\n` +
              `--- First 3000 chars preview ---\n${text.slice(0, 3000)}`,
          };
        }
      } catch { /* embeddings not configured — fall through to truncation */ }
    }

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

async function toolIndexContent(
  type:     string,
  source:   string | undefined,
  content:  string | undefined,
  name:     string,
  tags:     string[] | undefined,
): Promise<{ output: string; error?: boolean }> {
  try {
    const { loadConfig } = await import('../config/index.js');
    const config = loadConfig();

    if (!config.embeddings.enabled) {
      return { output: 'Embeddings not enabled. Set embeddings.enabled = true in config.', error: true };
    }

    const { chunkText, indexChunks } = await import('../vector/store.js');

    let text = '';
    let sourceRef = '';

    if (type === 'github') {
      if (!source) return { output: 'source is required for type=github (e.g. "owner/repo/path/file.json")', error: true };
      // source format: "owner/repo/path/to/file.json"
      const parts   = source.split('/');
      const owner   = parts[0];
      const repo    = parts[1];
      const path    = parts.slice(2).join('/');
      if (!owner || !repo || !path) return { output: 'Invalid github source. Use "owner/repo/path/to/file.json"', error: true };

      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github.v3.raw',
        'User-Agent': 'Argos/1.0',
      };
      if (process.env.GITHUB_TOKEN) headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return { output: `GitHub fetch failed: HTTP ${res.status} for ${source}`, error: true };

      const body = await res.text();
      try {
        const json = JSON.parse(body);
        text = json.encoding === 'base64' && json.content
          ? Buffer.from(json.content, 'base64').toString('utf8')
          : body;
      } catch { text = body; }

      sourceRef = `github:${owner}/${repo}/${path}`;

    } else if (type === 'url') {
      if (!source) return { output: 'source is required for type=url', error: true };

      const blocked = ssrfBlock(source);
      if (blocked) return { output: `Security: ${blocked}`, error: true };

      const res = await fetch(source, {
        headers: { 'User-Agent': 'Argos/1.0' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { output: `URL fetch failed: HTTP ${res.status}`, error: true };

      const raw = await res.text();
      // Strip HTML tags if HTML response
      const ct = res.headers.get('content-type') ?? '';
      text = ct.includes('text/html')
        ? raw.replace(/<[^>]+>/g, ' ').replace(/\s{3,}/g, '\n').trim()
        : raw;

      sourceRef = `url:${source}`;

    } else if (type === 'text') {
      if (!content) return { output: 'content is required for type=text', error: true };
      text      = content;
      sourceRef = `text:${name.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;

    } else {
      return { output: `Unknown type "${type}". Use github, url, or text.`, error: true };
    }

    // Add tags as header so they appear in chunks and aid retrieval
    const tagHeader = tags?.length ? `[tags: ${tags.join(', ')}]\n\n` : '';
    const chunks = chunkText(tagHeader + text, sourceRef, name);

    if (chunks.length === 0) return { output: 'Content too short to index.', error: true };

    await indexChunks(chunks, config.embeddings);

    return {
      output: `Indexed "${name}" — ${chunks.length} chunks.\nsourceRef: "${sourceRef}"\nQuery with: semantic_search(query="...", source="${sourceRef}")`,
    };
  } catch (e) {
    return { output: `index_content failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

async function toolSemanticSearch(
  query:     string,
  topK?:     number,
  sourceRef?: string,
): Promise<{ output: string; error?: boolean }> {
  try {
    const { loadConfig } = await import('../config/index.js');
    const config = loadConfig();

    if (!config.embeddings.enabled) {
      return { output: 'Semantic search is not enabled. Set embeddings.enabled = true in config.', error: true };
    }

    const { semanticSearch, getIndexedSources } = await import('../vector/store.js');
    const results = await semanticSearch(query, config.embeddings, {
      topK:      topK ?? 5,
      sourceRef,
    });

    if (results.length === 0) {
      const sources = await getIndexedSources();
      if (sources.length === 0) {
        return { output: 'No content indexed yet. Context sources will be indexed on next boot.' };
      }
      return {
        output: `No results for "${query}". Indexed sources: ${sources.map(s => `${s.sourceName} (${s.chunks} chunks)`).join(', ')}`,
      };
    }

    const formatted = results.map((r, i) =>
      `[${i + 1}] ${r.chunk.sourceName}${r.chunk.lineStart ? ` (lines ${r.chunk.lineStart}–${r.chunk.lineEnd})` : ''} — similarity: ${(r.similarity * 100).toFixed(0)}%\nsourceRef: ${r.chunk.sourceRef}\n${r.chunk.content}`,
    ).join('\n\n---\n\n');

    return { output: formatted };
  } catch (e) {
    return { output: `Semantic search failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
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

  // Security: block SSRF (cloud metadata, private ranges, etc.)
  const blocked = ssrfBlock(url);
  if (blocked) return { output: `Security: ${blocked}`, error: true };

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
      db.prepare("UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by Argos' WHERE id = ? AND status IN ('proposed', 'awaiting_approval')").run(proposalId);
      return { output: `Proposal ${proposalId.slice(-8)} cancelled.` };
    }
    const result = db.prepare("UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by Argos' WHERE status IN ('proposed', 'awaiting_approval')").run();
    return { output: `${result.changes} pending proposal(s) cancelled.` };
  } catch (e) {
    return { output: `Error: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

async function toolListProposals(): Promise<{ output: string; error?: boolean }> {
  try {
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    const rows = db.prepare("SELECT id, plan, status, created_at FROM proposals WHERE status IN ('proposed', 'awaiting_approval') ORDER BY created_at DESC LIMIT 10")
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

function toolListKnowledge(): { output: string; error?: boolean } {
  const knowledgeDir = path.join(getDataDir(), 'knowledge');
  try {
    if (!fs.existsSync(knowledgeDir)) return { output: 'Knowledge directory is empty. Drop files in ~/.argos/knowledge/ to make them available.' };
    const files = fs.readdirSync(knowledgeDir, { recursive: true }) as string[];
    const listed = files
      .filter(f => !f.startsWith('.'))
      .map(f => {
        try {
          const size = fs.statSync(path.join(knowledgeDir, f)).size;
          return `knowledge/${f}  (${Math.round(size / 1024)}KB)`;
        } catch { return `knowledge/${f}`; }
      });
    return listed.length > 0
      ? { output: `Files in ~/.argos/knowledge/:\n${listed.join('\n')}\n\nUse read_file(path="knowledge/<file>") to read. For large files pass search="<keyword>" to get only matching lines.` }
      : { output: 'Knowledge directory is empty. Drop files in ~/.argos/knowledge/ to make them available.' };
  } catch (e) {
    return { output: `list_knowledge failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

function toolReadFile(relPath: string, search?: string): { output: string; error?: boolean } {
  // Security: prevent path traversal
  const normalized = path.normalize(relPath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return { output: 'Security: path traversal not allowed', error: true };
  }
  const fullPath = path.join(getDataDir(), normalized);
  try {
    const content = fs.readFileSync(fullPath, 'utf8');

    // No search term — return full file (up to 20k chars, warn if truncated)
    if (!search) {
      if (content.length > 20000) {
        return { output: `${content.slice(0, 20000)}\n\n[TRUNCATED — file is ${content.length} chars. Use search="<keyword>" to find specific sections.]` };
      }
      return { output: content };
    }

    // Search mode — return matching lines ±10 lines of context
    const lines = content.split('\n');
    const needle = search.toLowerCase();
    const matchedRanges: Array<[number, number]> = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        const start = Math.max(0, i - 10);
        const end   = Math.min(lines.length - 1, i + 10);
        // Merge with previous range if overlapping
        if (matchedRanges.length > 0 && matchedRanges[matchedRanges.length - 1][1] >= start - 1) {
          matchedRanges[matchedRanges.length - 1][1] = end;
        } else {
          matchedRanges.push([start, end]);
        }
      }
    }

    if (matchedRanges.length === 0) {
      return { output: `No matches for "${search}" in ${relPath}` };
    }

    const excerpts = matchedRanges.map(([s, e]) =>
      `[lines ${s + 1}–${e + 1}]\n${lines.slice(s, e + 1).join('\n')}`
    ).join('\n\n---\n\n');

    return { output: `Search results for "${search}" in ${relPath}:\n\n${excerpts}` };
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
