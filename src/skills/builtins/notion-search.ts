/**
 * notion_search skill — search your Notion workspace.
 * Requires NOTION_API_KEY and NOTION_AGENT_DATABASE_ID in env.
 */

import { registerSkill } from '../registry.js';

registerSkill({
  name: 'notion_search',
  description: 'Search Notion workspace for pages and databases',
  tool: {
    name: 'notion_search',
    description:
      'Search your Notion workspace for pages, tasks, notes, or database entries matching a query.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        filter_type: {
          type: 'string',
          enum: ['page', 'database', 'all'],
          description: 'Filter by object type (default: all)',
        },
        max_results: {
          type: 'string',
          description: 'Max results to return (default: 10)',
        },
      },
      required: ['query'],
    },
  },
  handler: async (input, cfg) => {
    const apiKey = String(cfg.apiKey ?? process.env.NOTION_API_KEY ?? '');
    if (!apiKey) {
      return { success: false, output: 'notion_search requires NOTION_API_KEY' };
    }

    const query = String(input.query ?? '');
    const filterType = String(input.filter_type ?? 'all');
    const maxResults = Math.min(Number(input.max_results ?? 10), 25);

    const body: Record<string, unknown> = { query, page_size: maxResults };
    if (filterType !== 'all') {
      body.filter = { value: filterType, property: 'object' };
    }

    const res = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const err = await res.text();
      return { success: false, output: `Notion API error ${res.status}: ${err}` };
    }

    const data = (await res.json()) as NotionSearchResponse;
    const results = data.results ?? [];

    if (results.length === 0) {
      return { success: true, output: `No Notion pages found for: "${query}"` };
    }

    const lines = results.map((r) => {
      const title = extractTitle(r);
      const type = r.object === 'database' ? '[DB]' : '[Page]';
      const url = r.url ?? '';
      const edited = r.last_edited_time
        ? ` — edited ${new Date(r.last_edited_time).toLocaleDateString()}`
        : '';
      return `${type} **${title}**${edited}\n${url}`;
    });

    return {
      success: true,
      output: `Found ${results.length} result(s) in Notion:\n\n${lines.join('\n\n')}`,
      data: results,
    };
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractTitle(obj: NotionObject): string {
  // Page: title is in properties.title or properties.Name
  if (obj.object === 'page' && obj.properties) {
    for (const key of ['title', 'Name', 'Title']) {
      const prop = obj.properties[key];
      if (prop?.type === 'title' && Array.isArray(prop.title)) {
        return (
          (prop.title as Array<{ plain_text?: string }>).map((t) => t.plain_text ?? '').join('') ||
          'Untitled'
        );
      }
    }
  }
  // Database
  if (obj.object === 'database' && obj.title) {
    return (
      (obj.title as Array<{ plain_text?: string }>).map((t) => t.plain_text ?? '').join('') ||
      'Untitled DB'
    );
  }
  return 'Untitled';
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface NotionObject {
  object: 'page' | 'database';
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, { type: string; title?: unknown[] }>;
  title?: Array<{ plain_text?: string }>;
}

interface NotionSearchResponse {
  results: NotionObject[];
  has_more: boolean;
}
