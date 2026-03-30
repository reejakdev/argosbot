/**
 * web_search skill — search the web via DuckDuckGo (free) or Brave Search API.
 *
 * Config:
 *   engine: 'duckduckgo' (default, no key) | 'brave' (requires BRAVE_API_KEY)
 *   apiKey: string (for brave engine)
 */

import { registerSkill } from '../registry.js';

registerSkill({
  name: 'web_search',
  description: 'Search the web for current information',
  tool: {
    name: 'web_search',
    description: 'Search the web for up-to-date information, news, prices, documentation, etc.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        max_results: {
          type: 'string',
          description: 'Number of results to return (default: 5)',
        },
      },
      required: ['query'],
    },
  },
  handler: async (input, cfg) => {
    const query = String(input.query ?? '');
    const maxResults = Math.min(Number(input.max_results ?? 5), 10);
    const engine = String(cfg.engine ?? 'duckduckgo');

    if (engine === 'brave') {
      return searchBrave(query, maxResults, cfg);
    }
    return searchDuckDuckGo(query, maxResults);
  },
});

// ─── DuckDuckGo instant answers (no API key) ──────────────────────────────────

async function searchDuckDuckGo(query: string, maxResults: number) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Argos/1.0' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    return { success: false, output: `DuckDuckGo error: ${res.status}` };
  }

  const data = await res.json() as DuckDuckGoResponse;

  const results: string[] = [];

  if (data.AbstractText) {
    results.push(`**Summary**: ${data.AbstractText}`);
    if (data.AbstractURL) results.push(`Source: ${data.AbstractURL}`);
  }

  if (data.RelatedTopics?.length) {
    const topics = data.RelatedTopics
      .filter((t): t is DuckDuckGoTopic => 'Text' in t && !!t.Text)
      .slice(0, maxResults)
      .map(t => `• ${t.Text}${t.FirstURL ? ` (${t.FirstURL})` : ''}`);
    if (topics.length) {
      results.push('\n**Related:**\n' + topics.join('\n'));
    }
  }

  if (results.length === 0) {
    return {
      success: true,
      output: `No instant answer found for: "${query}". Try a more specific query or use the Brave engine.`,
    };
  }

  return { success: true, output: results.join('\n') };
}

// ─── Brave Search API ─────────────────────────────────────────────────────────

async function searchBrave(query: string, maxResults: number, cfg: Record<string, unknown>) {
  const apiKey = String(cfg.apiKey ?? process.env.BRAVE_API_KEY ?? '');
  if (!apiKey) {
    return { success: false, output: 'Brave Search requires BRAVE_API_KEY in skill config or env' };
  }

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    return { success: false, output: `Brave Search error: ${res.status}` };
  }

  const data = await res.json() as BraveResponse;
  const webResults = data.web?.results ?? [];

  if (webResults.length === 0) {
    return { success: true, output: `No results found for: "${query}"` };
  }

  const lines = webResults.map(r =>
    `**${r.title}**\n${r.description ?? ''}\n${r.url}`
  );

  return { success: true, output: lines.join('\n\n'), data: webResults };
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DuckDuckGoTopic {
  Text: string;
  FirstURL?: string;
}

interface DuckDuckGoResponse {
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: Array<DuckDuckGoTopic | { Topics: DuckDuckGoTopic[] }>;
}

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
}

interface BraveResponse {
  web?: { results: BraveWebResult[] };
}
