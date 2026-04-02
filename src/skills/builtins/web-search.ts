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

// ─── DuckDuckGo HTML search (no API key, real results) ───────────────────────

async function searchDuckDuckGo(query: string, maxResults: number) {
  // Try instant answer API first (fast, good for factual queries)
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Argos/1.0)' },
      signal: AbortSignal.timeout(8_000),
    });

    if (res.ok) {
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
        if (topics.length) results.push('\n**Related:**\n' + topics.join('\n'));
      }

      if (results.length > 0) {
        return { success: true, output: results.join('\n') };
      }
    }
  } catch { /* fall through to HTML search */ }

  // Fallback: DuckDuckGo HTML search — works for any query type (flights, prices, news…)
  return searchDuckDuckGoHtml(query, maxResults);
}

async function searchDuckDuckGoHtml(query: string, maxResults: number) {
  // DuckDuckGo lite HTML endpoint — lightweight, no JS required
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    return { success: false, output: `Impossible d'effectuer la recherche web (réseau inaccessible): ${String(e)}` };
  }

  if (!res.ok) {
    return { success: false, output: `Erreur de recherche web (HTTP ${res.status}) — impossible de trouver des résultats pour "${query}"` };
  }

  const html = await res.text();

  // Extract results from DDG HTML — parse <a class="result__a"> and <a class="result__snippet">
  const titleRe  = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]+(?:<[^/][^>]*>[^<]*<\/[^>]+>)*[^<]*)<\/a>/g;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([^<]+(?:<[^/][^>]*>[^<]*<\/[^>]+>)*[^<]*)<\/a>/g;

  const titles:   Array<{ title: string; url: string }> = [];
  const snippets: string[] = [];

  // Extract real URL from DDG redirect wrapper
  const extractUrl = (raw: string): string => {
    try {
      const decoded = decodeURIComponent(raw);
      // Pattern: //duckduckgo.com/l/?uddg=https%3A%2F%2F...
      const uddg = decoded.match(/[?&]uddg=([^&]+)/)?.[1];
      if (uddg) {
        const real = decodeURIComponent(uddg);
        // Skip DDG ad URLs (y.js etc.)
        try { if (!new URL(real).hostname.endsWith('duckduckgo.com')) return real; } catch { /* ignore */ }
      }
      // Pattern: direct URL — skip DDG-hosted ones
      if (decoded.startsWith('http')) {
        try { if (!new URL(decoded.split('?')[0]).hostname.endsWith('duckduckgo.com')) return decoded.split('&')[0]; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return '';
  };

  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null && titles.length < maxResults) {
    const url  = extractUrl(m[1]);
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (text && url.startsWith('http')) titles.push({ title: text, url });
  }
  while ((m = snippetRe.exec(html)) !== null && snippets.length < maxResults) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text) snippets.push(text);
  }

  if (titles.length === 0) {
    return {
      success: false,
      output: `Aucun résultat trouvé pour "${query}". La recherche web n'a rien retourné.`,
    };
  }

  const lines = titles.slice(0, maxResults).map((t, i) =>
    `**${t.title}**\n${snippets[i] ?? ''}\n${t.url}`.trim()
  );

  return { success: true, output: lines.join('\n\n') };
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
