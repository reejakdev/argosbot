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
    description:
      'Search the web using DuckDuckGo. Returns top results with titles, URLs, and snippets.',
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
        category: {
          type: 'string',
          enum: ['preference', 'fact', 'task', 'decision', 'context'],
          description: 'Category',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'index_content',
    description:
      'Fetch and index content into the vector store for semantic search. Supports GitHub files, URLs, and raw text. Use this to ingest docs, contract files, job specs, or any reference content so it can be retrieved later with semantic_search.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['github', 'url', 'text'], description: 'Source type' },
        source: {
          type: 'string',
          description:
            'For github: "owner/repo/path/to/file.json". For url: full URL. Not needed for text.',
        },
        content: { type: 'string', description: 'For type=text: the raw text to index.' },
        name: {
          type: 'string',
          description:
            'Human label for this content (e.g. "Etherlink deployments", "Job spec Q2", "Partner brief")',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for filtering later (e.g. ["contracts", "etherlink"])',
        },
      },
      required: ['type', 'name'],
    },
  },
  {
    name: 'semantic_search',
    description:
      'Semantic search over indexed context sources (GitHub files, URLs, Notion). Use this to find specific information in large files that may not appear in memory_search results.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for (natural language)' },
        top_k: { type: 'number', description: 'Max results to return (default 5)' },
        source: {
          type: 'string',
          description:
            'Optional: restrict to a source ref prefix. "github:myorg/repo" matches all files in that repo. Exact file: "github:myorg/repo/config/file.ts"',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'current_time',
    description: 'Get the current date and time.',
    input_schema: { type: 'object', properties: {} },
  },
  // ── Notion tools (direct SDK — full API coverage) ──────────────────────────
  {
    name: 'notion_create',
    description:
      'Create a Notion page — either inside a database (use database_type or database_id) or as a subpage of an existing page (use parent_page_id). Use parent_page_id when you want to create a plain subpage, not a database entry.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Page title' },
        parent_page_id: {
          type: 'string',
          description:
            'Parent page ID — creates a plain subpage inside that page (not a database entry). Use this instead of database_type when the parent is a page.',
        },
        database_type: {
          type: 'string',
          enum: [
            'task',
            'todo',
            'note',
            'partner',
            'deal',
            'tx_review',
            'project',
            'meeting',
            'doc',
          ],
          description: 'Type of entry (only when creating inside a database)',
        },
        database_id: {
          type: 'string',
          description: 'Explicit Notion database ID (overrides database_type routing)',
        },
        icon: { type: 'string', description: 'Emoji icon for the page' },
        content: { type: 'string', description: 'Page body / description' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags (multi-select, database pages only)',
        },
        priority: {
          type: 'string',
          enum: ['Low', 'Medium', 'High'],
          description: 'Priority (database pages only)',
        },
        due_date: { type: 'string', description: 'Due date ISO 8601 (database pages only)' },
        status: { type: 'string', description: 'Status value (database pages only)' },
        assignee: { type: 'string', description: 'Assignee name (database pages only)' },
        blocks: {
          type: 'array',
          items: { type: 'object' },
          description: 'Custom Notion block objects to append as page body',
        },
        properties: {
          type: 'object',
          description: 'Additional raw Notion properties to merge (database pages only)',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'notion_update',
    description: 'Update a Notion page: change properties, archive/unarchive, or update the icon.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Notion page ID' },
        properties: { type: 'object', description: 'Properties to update (raw Notion format)' },
        archived: { type: 'boolean', description: 'Archive (true) or unarchive (false) the page' },
        icon: { type: 'string', description: 'Emoji icon' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'notion_get',
    description: 'Retrieve a Notion page properties or a database schema.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Page ID or database ID' },
        type: {
          type: 'string',
          enum: ['page', 'database'],
          description: 'What to retrieve (default: page)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'notion_get_content',
    description: 'Read the full text content (blocks) of a Notion page.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Notion page ID' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'notion_append',
    description:
      'Append blocks to an existing Notion page. Supports paragraphs, headings, to_do checkboxes, bulleted lists, code blocks.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Notion page ID' },
        blocks: {
          type: 'array',
          items: { type: 'object' },
          description: 'Notion block objects to append',
        },
      },
      required: ['page_id', 'blocks'],
    },
  },
  {
    name: 'notion_query',
    description: 'Query a Notion database with optional filters and sorts. Returns matching pages.',
    input_schema: {
      type: 'object',
      properties: {
        database_id: { type: 'string', description: 'Database ID (optional if db_type set)' },
        db_type: { type: 'string', description: 'agent or owner (fallback if no database_id)' },
        query: { type: 'string', description: 'Title contains filter (convenience)' },
        filter: { type: 'object', description: 'Raw Notion filter object' },
        sorts: { type: 'array', items: { type: 'object' }, description: 'Sort array' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'notion_search',
    description:
      'Search or list the Notion workspace. Omit query to list ALL accessible pages/databases (up to 50). Use filter_type to scope to pages or databases only.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — omit to list everything the integration can access',
        },
        filter_type: {
          type: 'string',
          enum: ['page', 'database'],
          description: 'Limit to pages or databases',
        },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'notion_create_db',
    description: 'Create a new Notion database inside a parent page.',
    input_schema: {
      type: 'object',
      properties: {
        parent_page_id: { type: 'string', description: 'Parent page ID' },
        title: { type: 'string', description: 'Database title' },
        icon: { type: 'string', description: 'Emoji icon' },
        properties: {
          type: 'object',
          description: 'Custom schema (default: Name + Done + Priority + Tags + Due)',
        },
      },
      required: ['parent_page_id', 'title'],
    },
  },
  {
    name: 'notion_comment',
    description: 'Add a comment to a Notion page.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Notion page ID' },
        content: { type: 'string', description: 'Comment text' },
      },
      required: ['page_id', 'content'],
    },
  },
  {
    name: 'notion_delete',
    description:
      'Archive (delete) a Notion page. Use after migrating content, or to clean up empty/unused pages.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Page ID to archive' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'api_call',
    description:
      'Make an HTTP API call. Use this when MCP tools fail or for direct API access. Secrets (API keys) from config are auto-injected via {{SECRET_NAME}} placeholders in headers.',
    input_schema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          description: 'HTTP method',
        },
        url: { type: 'string', description: 'Full URL' },
        headers: {
          type: 'object',
          description: 'HTTP headers (use {{NOTION_API_KEY}} for auto-inject)',
        },
        body: { type: 'object', description: 'Request body (JSON)' },
      },
      required: ['method', 'url'],
    },
  },
  {
    name: 'cancel_proposals',
    description:
      'Cancel/reject all pending proposals, or a specific one by ID. Use this to clean up old proposals before creating new ones.',
    input_schema: {
      type: 'object',
      properties: {
        proposal_id: {
          type: 'string',
          description: 'Specific proposal ID to cancel (optional — omit to cancel all pending)',
        },
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
    description:
      'Create an approval request for any action that requires user permission. Use this for: creating Notion databases, sending messages, creating tickets, modifying external services, write operations, or running scripts. The user will approve/reject in the web app with 2FA.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            'What to do (e.g. "Create Notion database", "Send reply to partner", "run_script")',
        },
        details: {
          type: 'string',
          description: 'Full details of the action. For run_script: paste the full script here.',
        },
        risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Risk level' },
        actions: {
          type: 'array',
          description:
            'Structured action list — use instead of details for multi-step or script proposals',
          items: {
            type: 'object',
            properties: {
              tool: {
                type: 'string',
                description: 'Tool name: write_file | run_script | notion | draft_reply | …',
              },
              details: { type: 'string', description: 'Human-readable description of this step' },
              input: {
                type: 'object',
                description: 'Tool input. For run_script: { script, lang, timeout }',
              },
            },
          },
        },
      },
      required: ['action', 'details'],
    },
  },
  {
    name: 'run_script',
    description:
      'Propose running a Node.js or Bash script. Creates an approval request — the script is NOT executed until the user approves. Use this when a task is too complex for individual tools (bulk ops, API loops, data processing). Always show the full script in the proposal so the user can review it.',
    input_schema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Full script content to execute' },
        lang: {
          type: 'string',
          enum: ['node', 'bash'],
          description:
            'Language (default: bash). Use bash for shell/osascript commands, node for JavaScript.',
        },
        timeout: {
          type: 'number',
          description: 'Max execution time in seconds (default: 300, max: 600)',
        },
        reason: { type: 'string', description: 'Why this script is needed' },
      },
      required: ['script'],
    },
  },
  {
    name: 'list_knowledge',
    description:
      'List all files in ~/.argos/knowledge/ — the local knowledge base. Use this to discover available reference files (addresses, configs, docs) before reading them.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_file',
    description:
      'Read a file from ~/.argos/ or ~/.argos/knowledge/. For large files (addresses, configs), pass a `search` term to extract only the matching lines ±10 lines of context instead of the full file.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within ~/.argos/ (e.g. "knowledge/addresses.ts", "user.md")',
        },
        search: {
          type: 'string',
          description:
            'Optional: return only lines containing this string (case-insensitive) ±10 lines context. Use this on large files to find a specific contract/network.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Propose writing a file to ~/.argos/. This creates an approval request — the file is NOT written until the user approves. Use this for user.md, config changes, etc.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within ~/.argos/' },
        content: { type: 'string', description: 'File content to write' },
        reason: {
          type: 'string',
          description: 'Why this file should be written (shown to user in approval)',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'spawn_agent',
    description:
      'Spawn specialized sub-agents to run tasks in parallel. Each sub-agent runs independently ' +
      'with its own context and tool subset. Use when you need to research multiple topics ' +
      'simultaneously or parallelize independent work. Max 5 agents. Results are collected and ' +
      'returned together. Sub-agents CANNOT spawn more agents (depth = 1 only).',
    input_schema: {
      type: 'object' as const,
      properties: {
        agents: {
          type: 'array',
          description: 'List of sub-agent tasks to run in parallel (max 5)',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Label for this agent (used in result headers)',
              },
              systemPrompt: { type: 'string', description: 'Role and goal for this sub-agent' },
              tools: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Tool names this agent can use — empty array means all available tools',
              },
              input: {
                type: 'string',
                description: 'The task description / question for this agent',
              },
              maxIterations: {
                type: 'number',
                description: 'Max tool-use iterations (default 4, max 6)',
              },
            },
            required: ['name', 'systemPrompt', 'input'],
          },
          maxItems: 5,
        },
      },
      required: ['agents'],
    },
  },
  {
    name: 'get_tasks',
    description:
      'Query open and in-progress tasks from the Argos task database. Returns task list with titles, status, urgency, partner, and a link to the original message.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'all', 'completed'],
          description: 'Filter by status. Default: open+in_progress',
        },
        partner: { type: 'string', description: 'Filter by partner name (optional)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
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
      return await toolWriteFileProposal(
        input.path as string,
        input.content as string,
        input.reason as string | undefined,
      );
    case 'cancel_proposals':
      return await toolCancelProposals(input.proposal_id as string | undefined);
    case 'list_proposals':
      return await toolListProposals();
    case 'create_proposal':
      return await toolCreateProposal(
        input.action as string,
        input.details as string,
        input.risk as string | undefined,
        input.actions as unknown[] | undefined,
      );
    case 'run_script': {
      // run_script from chat → creates a proposal for approval (never executes inline)
      const lang = (input.lang ?? 'bash') as string;
      const timeout = (input.timeout ?? 300) as number;
      const reason = (input.reason ?? '') as string;
      const script = input.script as string;
      // context_summary = human-readable instruction only (script shown in action block)
      const contextSummary = reason || script.slice(0, 120);
      // Use reason as the step description if available, otherwise first line of script
      const stepDesc = reason || script.split('\n')[0].slice(0, 80) || `Run ${lang} script`;
      const proposalId = await createProposalInDb(
        contextSummary,
        'run_script',
        [
          {
            tool: 'run_script',
            description: stepDesc,
            details: stepDesc,
            risk: 'medium',
            input: { script, lang, timeout },
          },
        ],
        'medium',
      );
      const riskEmoji = '🟡';
      return {
        output: `${riskEmoji} Approval request created.\n\nProposal: ${proposalId}\nAction: run_script\nRisk: medium\n\n🔒 The user must approve this in the web app (2FA required). Tell the user to open their approvals dashboard.`,
      };
    }
    case 'api_call':
      return await toolApiCall(input);
    case 'spawn_agent':
      return await toolSpawnAgent(input);
    case 'get_tasks':
      return await toolGetTasks(
        input.status as string | undefined,
        input.partner as string | undefined,
        input.limit as number | undefined,
      );
    case 'notion_create':
    case 'notion_update':
    case 'notion_get':
    case 'notion_get_content':
    case 'notion_append':
    case 'notion_query':
    case 'notion_search':
    case 'notion_create_db':
    case 'notion_comment':
    case 'notion_delete':
      return await toolNotion(name, input);
    default:
      return { output: `Unknown tool: ${name}`, error: true };
  }
};

// ─── SSRF guard ───────────────────────────────────────────────────────────────
// Shared check for all outbound fetches (fetch_url, index_content, api_call).
// Blocks cloud metadata endpoints, private IP ranges, IPv6 mapped addresses.

function ssrfBlock(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `Invalid URL: ${rawUrl}`;
  }

  const h = parsed.hostname.toLowerCase();

  // Reject non-HTTP(S) schemes
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return `Blocked scheme: ${parsed.protocol}`;
  }

  // Cloud metadata endpoints (AWS, GCP, Azure, DigitalOcean, Alibaba)
  const metadataHosts = [
    '169.254.169.254', // AWS / GCP / Azure / generic link-local
    'metadata.google.internal',
    'fd00:ec2::254', // AWS IPv6 metadata
    '100.100.100.200', // Alibaba Cloud
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
  // Helper to decode DDG redirect URLs and filter out DDG-hosted ad links
  const extractUrl = (raw: string): string => {
    try {
      const decoded = decodeURIComponent(raw);
      const uddg = decoded.match(/[?&]uddg=([^&]+)/)?.[1];
      if (uddg) {
        const real = decodeURIComponent(uddg);
        try {
          if (!new URL(real).hostname.endsWith('duckduckgo.com')) return real;
        } catch {
          /* ignore */
        }
      }
      if (decoded.startsWith('http')) {
        try {
          if (!new URL(decoded.split('?')[0]).hostname.endsWith('duckduckgo.com'))
            return decoded.split('&')[0];
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return '';
  };

  try {
    // DuckDuckGo HTML search (no API key needed)
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(12_000),
      });
    } catch (e) {
      return {
        output: `Impossible d'effectuer la recherche web (réseau inaccessible): ${String(e)}`,
        error: true,
      };
    }

    if (!res.ok) {
      return {
        output: `Erreur de recherche web (HTTP ${res.status}) — impossible de trouver des résultats pour "${query}"`,
        error: true,
      };
    }

    const html = await res.text();

    // Extract title + URL + snippet
    const titleRe =
      /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]+(?:<[^/][^>]*>[^<]*<\/[^>]+>)*[^<]*)<\/a>/g;
    const snippetRe =
      /<a[^>]+class="result__snippet"[^>]*>([^<]+(?:<[^/][^>]*>[^<]*<\/[^>]+>)*[^<]*)<\/a>/g;

    const titles: Array<{ title: string; url: string }> = [];
    const snippets: string[] = [];

    let m: RegExpExecArray | null;
    while ((m = titleRe.exec(html)) !== null && titles.length < 5) {
      const link = extractUrl(m[1]);
      const text = m[2].replace(/<[^>]+>/g, '').trim();
      if (text && link.startsWith('http')) titles.push({ title: text, url: link });
    }
    while ((m = snippetRe.exec(html)) !== null && snippets.length < 5) {
      const text = m[1].replace(/<[^>]+>/g, '').trim();
      if (text) snippets.push(text);
    }

    if (titles.length === 0) {
      return {
        output: `Aucun résultat trouvé pour "${query}". La recherche web n'a rien retourné.`,
        error: true,
      };
    }

    const lines = titles.map((t, i) => `**${t.title}**\n${snippets[i] ?? ''}\n${t.url}`.trim());
    return { output: lines.join('\n\n') };
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
      const sourceRef = `github:${owner}/${repo}/${filePath}`;
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
      } catch {
        /* embeddings not configured — fall through to truncation */
      }
    }

    return { output: text.slice(0, 8000) };
  } catch (e) {
    return { output: `Fetch failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

async function toolMemorySearch(
  query: string,
  limit?: number,
): Promise<{ output: string; error?: boolean }> {
  try {
    const { search } = await import('../memory/store.js');
    const results = search({ query, limit: limit ?? 5 });
    if (results.length === 0) return { output: 'No memories found.' };
    return {
      output: results
        .map((m) => `[${m.category}] ${m.content} (importance: ${m.importance})`)
        .join('\n'),
    };
  } catch (e) {
    return {
      output: `Memory search failed: ${e instanceof Error ? e.message : String(e)}`,
      error: true,
    };
  }
}

async function toolIndexContent(
  type: string,
  source: string | undefined,
  content: string | undefined,
  name: string,
  tags: string[] | undefined,
): Promise<{ output: string; error?: boolean }> {
  try {
    const { loadConfig } = await import('../config/index.js');
    const config = loadConfig();

    if (!config.embeddings.enabled) {
      return {
        output: 'Embeddings not enabled. Set embeddings.enabled = true in config.',
        error: true,
      };
    }

    const { chunkText, chunkCode, indexChunks, cleanSource } = await import('../vector/store.js');

    let text = '';
    let sourceRef = '';

    if (type === 'github') {
      if (!source)
        return {
          output: 'source is required for type=github (e.g. "owner/repo/path/file.json")',
          error: true,
        };
      // source format: "owner/repo/path/to/file.json"
      const parts = source.split('/');
      const owner = parts[0];
      const repo = parts[1];
      const path = parts.slice(2).join('/');
      if (!owner || !repo || !path)
        return { output: 'Invalid github source. Use "owner/repo/path/to/file.json"', error: true };

      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github.v3.raw',
        'User-Agent': 'Argos/1.0',
      };
      if (process.env.GITHUB_TOKEN) headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok)
        return { output: `GitHub fetch failed: HTTP ${res.status} for ${source}`, error: true };

      const body = await res.text();
      try {
        const json = JSON.parse(body);
        text =
          json.encoding === 'base64' && json.content
            ? Buffer.from(json.content, 'base64').toString('utf8')
            : body;
      } catch {
        text = body;
      }

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
        ? raw
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{3,}/g, '\n')
            .trim()
        : raw;

      sourceRef = `url:${source}`;
    } else if (type === 'text') {
      if (!content) return { output: 'content is required for type=text', error: true };
      text = content;
      sourceRef = `text:${name.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;
    } else {
      return { output: `Unknown type "${type}". Use github, url, or text.`, error: true };
    }

    // Add tags as header so they appear in chunks and aid retrieval
    const tagHeader = tags?.length ? `[tags: ${tags.join(', ')}]\n\n` : '';
    const fullText = tagHeader + text;

    // Use brace-aware chunker for structured files (.ts / .json / .yaml), line-based for prose
    const isCode = /\.(ts|js|json|yaml|yml)$/.test(sourceRef);
    const chunks = isCode
      ? chunkCode(fullText, sourceRef, name, tags ?? [])
      : chunkText(fullText, sourceRef, name, tags ?? []);

    if (chunks.length === 0) return { output: 'Content too short to index.', error: true };

    await cleanSource(sourceRef); // hard-delete old chunks before re-indexing
    await indexChunks(chunks, config.embeddings);

    return {
      output: `Indexed "${name}" — ${chunks.length} chunks.\nsourceRef: "${sourceRef}"\nQuery with: semantic_search(query="...", source="${sourceRef}")`,
    };
  } catch (e) {
    return {
      output: `index_content failed: ${e instanceof Error ? e.message : String(e)}`,
      error: true,
    };
  }
}

async function toolSemanticSearch(
  query: string,
  topK?: number,
  sourceRef?: string,
): Promise<{ output: string; error?: boolean }> {
  try {
    const { loadConfig } = await import('../config/index.js');
    const config = loadConfig();

    if (!config.embeddings.enabled) {
      return {
        output: 'Semantic search is not enabled. Set embeddings.enabled = true in config.',
        error: true,
      };
    }

    const { semanticSearch, getIndexedSources } = await import('../vector/store.js');
    const results = await semanticSearch(query, config.embeddings, {
      topK: topK ?? 5,
      sourceRef,
    });

    if (results.length === 0) {
      const sources = await getIndexedSources();
      if (sources.length === 0) {
        return { output: 'No content indexed yet. Context sources will be indexed on next boot.' };
      }
      return {
        output: `No results for "${query}". Indexed sources: ${sources.map((s) => `${s.sourceName} (${s.chunks} chunks)`).join(', ')}`,
      };
    }

    const formatted = results
      .map(
        (r, i) =>
          `[${i + 1}] ${r.chunk.sourceName}${r.chunk.lineStart ? ` (lines ${r.chunk.lineStart}–${r.chunk.lineEnd})` : ''} — similarity: ${(r.similarity * 100).toFixed(0)}%\nsourceRef: ${r.chunk.sourceRef}\n${r.chunk.content}`,
      )
      .join('\n\n---\n\n');

    return { output: formatted };
  } catch (e) {
    return {
      output: `Semantic search failed: ${e instanceof Error ? e.message : String(e)}`,
      error: true,
    };
  }
}

async function toolMemoryStore(
  content: string,
  category?: string,
): Promise<{ output: string; error?: boolean }> {
  try {
    const { storeQuick } = await import('../memory/store.js');
    const { loadConfig } = await import('../config/index.js');
    const ttlDays = loadConfig().memory?.defaultTtlDays ?? 30;
    const entry = storeQuick(content, category ?? 'general', [], ttlDays);
    return { output: `Stored memory ${entry.id}: "${content.slice(0, 50)}"` };
  } catch (e) {
    return {
      output: `Memory store failed: ${e instanceof Error ? e.message : String(e)}`,
      error: true,
    };
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

async function toolApiCall(
  input: Record<string, unknown>,
): Promise<{ output: string; error?: boolean }> {
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
    return {
      output: `API call failed: ${e instanceof Error ? e.message : String(e)}`,
      error: true,
    };
  }
}

async function toolCancelProposals(
  proposalId?: string,
): Promise<{ output: string; error?: boolean }> {
  try {
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    if (proposalId) {
      db.prepare(
        "UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by Argos' WHERE id = ? AND status IN ('proposed', 'awaiting_approval')",
      ).run(proposalId);
      return { output: `Proposal ${proposalId.slice(-8)} cancelled.` };
    }
    const result = db
      .prepare(
        "UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by Argos' WHERE status IN ('proposed', 'awaiting_approval')",
      )
      .run();
    return { output: `${result.changes} pending proposal(s) cancelled.` };
  } catch (e) {
    return { output: `Error: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

async function toolListProposals(): Promise<{ output: string; error?: boolean }> {
  try {
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT id, plan, status, created_at FROM proposals WHERE status IN ('proposed', 'awaiting_approval') ORDER BY created_at DESC LIMIT 10",
      )
      .all() as Array<{ id: string; plan: string; status: string; created_at: number }>;
    if (rows.length === 0) return { output: 'No pending proposals.' };
    return {
      output: rows.map((r) => `- ${r.id.slice(-8)} | ${r.plan.slice(0, 60)}`).join('\n'),
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
  db.prepare(
    `
    INSERT INTO proposals (id, task_id, context_summary, plan, actions, status, created_at, expires_at)
    VALUES (?, NULL, ?, ?, ?, 'proposed', ?, ?)
  `,
  ).run(
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

async function toolCreateProposal(
  action: string,
  details: string,
  risk?: string,
  actions?: unknown[],
): Promise<{ output: string; error?: boolean }> {
  try {
    const riskLevel = risk ?? 'medium';
    const actionsPayload =
      actions && actions.length > 0 ? actions : [{ action, details, risk: riskLevel }];
    const proposalId = await createProposalInDb(
      `${action}\n\n${details}`,
      action,
      actionsPayload as Array<Record<string, unknown>>,
      riskLevel,
    );

    const riskEmoji = riskLevel === 'high' ? '🔴' : riskLevel === 'medium' ? '🟡' : '🟢';

    return {
      output: `${riskEmoji} Approval request created.\n\nProposal: ${proposalId}\nAction: ${action}\nRisk: ${riskLevel}\n\n🔒 The user must approve this in the web app (2FA required). Tell the user to open their approvals dashboard.`,
    };
  } catch (e) {
    return {
      output: `Proposal creation failed: ${e instanceof Error ? e.message : String(e)}`,
      error: true,
    };
  }
}

function getDataDir(): string {
  const dir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
  return dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : dir;
}

function toolListKnowledge(): { output: string; error?: boolean } {
  const knowledgeDir = path.join(getDataDir(), 'knowledge');
  try {
    if (!fs.existsSync(knowledgeDir))
      return {
        output:
          'Knowledge directory is empty. Drop files in ~/.argos/knowledge/ to make them available.',
      };
    const files = fs.readdirSync(knowledgeDir, { recursive: true }) as string[];
    const listed = files
      .filter((f) => !f.startsWith('.'))
      .map((f) => {
        try {
          const size = fs.statSync(path.join(knowledgeDir, f)).size;
          return `knowledge/${f}  (${Math.round(size / 1024)}KB)`;
        } catch {
          return `knowledge/${f}`;
        }
      });
    return listed.length > 0
      ? {
          output: `Files in ~/.argos/knowledge/:\n${listed.join('\n')}\n\nUse read_file(path="knowledge/<file>") to read. For large files pass search="<keyword>" to get only matching lines.`,
        }
      : {
          output:
            'Knowledge directory is empty. Drop files in ~/.argos/knowledge/ to make them available.',
        };
  } catch (e) {
    return {
      output: `list_knowledge failed: ${e instanceof Error ? e.message : String(e)}`,
      error: true,
    };
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
        return {
          output: `${content.slice(0, 20000)}\n\n[TRUNCATED — file is ${content.length} chars. Use search="<keyword>" to find specific sections.]`,
        };
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
        const end = Math.min(lines.length - 1, i + 10);
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

    const excerpts = matchedRanges
      .map(([s, e]) => `[lines ${s + 1}–${e + 1}]\n${lines.slice(s, e + 1).join('\n')}`)
      .join('\n\n---\n\n');

    return { output: `Search results for "${search}" in ${relPath}:\n\n${excerpts}` };
  } catch {
    return { output: `File not found: ${relPath}`, error: true };
  }
}

async function toolWriteFileProposal(
  relPath: string,
  content: string,
  reason?: string,
): Promise<{ output: string; error?: boolean }> {
  const normalized = path.normalize(relPath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return { output: 'Security: path traversal not allowed', error: true };
  }

  try {
    const fullPath = path.join(getDataDir(), normalized);
    let existingContent: string | null = null;
    try {
      existingContent = fs.readFileSync(fullPath, 'utf8');
    } catch {
      /* */
    }

    const diffNote = existingContent ? '(file exists — will be overwritten)' : '(new file)';
    const preview = content.length > 200 ? content.slice(0, 200) + '…' : content;
    const proposalId = await createProposalInDb(
      `Write file: ${relPath} ${diffNote}${reason ? ` — ${reason}` : ''}`,
      `Write file ${relPath}. ${reason ?? ''}`,
      [
        {
          tool: 'write_file',
          input: { path: relPath, content },
          description: reason ?? `Write ${relPath}`,
        },
      ],
      'low',
    );

    return {
      output: `📋 Approval required to write "${relPath}" ${diffNote}.\nProposal ID: ${proposalId}\nPreview:\n${preview}\n\n🔒 The user must approve this in the web app (2FA required).`,
    };
  } catch (e) {
    return {
      output: `Proposal creation failed: ${e instanceof Error ? e.message : String(e)}`,
      error: true,
    };
  }
}

async function toolNotion(
  tool: string,
  input: Record<string, unknown>,
): Promise<{ output: string; error?: boolean }> {
  try {
    const { loadConfig } = await import('../config/index.js');
    const { NotionWorker } = await import('../workers/notion.js');
    const config = loadConfig();
    // Notion tools called from executor are always on approved proposals — bypass readOnly
    const worker = new NotionWorker({ ...config, readOnly: false });

    let result;
    switch (tool) {
      case 'notion_create':
        result = await worker.createEntry(input);
        break;
      case 'notion_update':
        result = await worker.updatePage(
          input as Parameters<InstanceType<typeof NotionWorker>['updatePage']>[0],
        );
        break;
      case 'notion_get':
        result =
          input.type === 'database'
            ? await worker.getDatabase(input.id as string)
            : await worker.getPage(input.id as string);
        break;
      case 'notion_get_content':
        result = await worker.getPageContent(input.page_id as string);
        break;
      case 'notion_append':
        result = await worker.appendBlocks(
          input as Parameters<InstanceType<typeof NotionWorker>['appendBlocks']>[0],
        );
        break;
      case 'notion_query':
        result = await worker.queryDatabase(
          input as Parameters<InstanceType<typeof NotionWorker>['queryDatabase']>[0],
        );
        break;
      case 'notion_search':
        result = await worker.searchWorkspace(
          input as Parameters<InstanceType<typeof NotionWorker>['searchWorkspace']>[0],
        );
        break;
      case 'notion_create_db':
        result = await worker.createDatabase(
          input as Parameters<InstanceType<typeof NotionWorker>['createDatabase']>[0],
        );
        break;
      case 'notion_comment':
        result = await worker.createComment(
          input as Parameters<InstanceType<typeof NotionWorker>['createComment']>[0],
        );
        break;
      case 'notion_delete':
        result = await worker.deletePage(input.page_id as string);
        break;

      default:
        return { output: `Unknown notion tool: ${tool}`, error: true };
    }

    return { output: result.output, error: !result.success || undefined };
  } catch (e) {
    return { output: `Notion error: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}

async function toolGetTasks(
  status?: string,
  partner?: string,
  limit?: number,
): Promise<{ output: string; error?: boolean }> {
  try {
    const { getDb } = await import('../db/index.js');
    const db = getDb();

    let where = '';
    const params: (string | number)[] = [];

    if (status === 'completed') {
      where = "WHERE status = 'completed'";
    } else if (status === 'all') {
      where = '';
    } else {
      where = "WHERE status IN ('open','in_progress','done_inferred')";
    }

    if (partner) {
      where += (where ? ' AND' : ' WHERE') + ' partner_name LIKE ?';
      params.push(`%${partner}%`);
    }

    params.push(limit ?? 20);

    const rows = db
      .prepare(
        `SELECT id, title, status, partner_name, chat_id, message_url, detected_at FROM tasks ${where} ORDER BY detected_at DESC LIMIT ?`,
      )
      .all(...params) as Array<{
      id: string;
      title: string;
      status: string;
      partner_name: string | null;
      chat_id: string | null;
      message_url: string | null;
      detected_at: number;
    }>;

    if (!rows.length) return { output: 'No tasks found.' };

    const lines = rows.map((r) => {
      const date = new Date(r.detected_at).toLocaleDateString('fr-FR');
      const partner = r.partner_name ?? r.chat_id ?? '?';
      const link = r.message_url ? ` — [source](${r.message_url})` : '';
      return `[${r.status}] ${r.title} — ${partner} (${date})${link} [id:${r.id.slice(-6)}]`;
    });

    return { output: `${rows.length} task(s):\n${lines.join('\n')}` };
  } catch (e) {
    return {
      output: `get_tasks failed: ${e instanceof Error ? e.message : String(e)}`,
      error: true,
    };
  }
}

async function toolSpawnAgent(
  input: Record<string, unknown>,
): Promise<{ output: string; error?: boolean }> {
  try {
    const { loadConfig } = await import('../config/index.js');
    const { llmConfigFromConfig } = await import('./index.js');
    const { runOrchestrated } = await import('../agents/orchestrator.js');
    type AgentTask = import('../agents/orchestrator.js').AgentTask;

    const config = loadConfig();
    const llmConfig = llmConfigFromConfig(config);

    const rawAgents = (input.agents as Array<Record<string, unknown>>) ?? [];
    if (!rawAgents.length) {
      return { output: 'spawn_agent: no agents provided', error: true };
    }

    const tasks: AgentTask[] = rawAgents.slice(0, 5).map((a) => ({
      name: String(a.name ?? 'agent'),
      systemPrompt: String(a.systemPrompt ?? 'You are a helpful assistant.'),
      tools: Array.isArray(a.tools) ? (a.tools as string[]) : [],
      input: String(a.input ?? ''),
      maxIterations: typeof a.maxIterations === 'number' ? a.maxIterations : 4,
    }));

    const results = await runOrchestrated(tasks, config, llmConfig);

    const formatted = results
      .map(
        (r) =>
          `**[${r.name}]** ${r.success ? '✅' : '❌'}\n${r.output || r.error || '(no output)'}`,
      )
      .join('\n\n');

    return { output: formatted };
  } catch (e) {
    return {
      output: `spawn_agent failed: ${e instanceof Error ? e.message : String(e)}`,
      error: true,
    };
  }
}
