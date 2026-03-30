/**
 * Context sources — persistent knowledge base for the planner.
 *
 * Fetches content from configured sources (URLs, GitHub repos, Notion pages/databases)
 * and stores them as permanent memories so Claude always has them available as context.
 *
 * Sources are refreshed on a schedule (default: every 7 days).
 * Stored with category='context' and archived=true (never purged by TTL).
 *
 * Flow:
 *   boot → loadContextSources()  — fetch all, store/update memories
 *   cron → refreshContextSources() — re-fetch stale sources
 *
 * The planner picks up context memories automatically via getRecentForContext().
 */

import { createLogger } from '../logger.js';
import { getDb } from '../db/index.js';
import type { Config, ContextUrl, ContextGitHub, ContextNotion } from '../config/schema.js';

const log = createLogger('context');

// ─── Source result ────────────────────────────────────────────────────────────

interface ContextResult {
  key:     string;   // unique key — used to upsert in memories
  name:    string;
  content: string;   // extracted text (max 8k chars)
  tags:    string[];
}

// ─── Main: load all context sources ──────────────────────────────────────────

export async function loadContextSources(config: Config): Promise<void> {
  const sources = config.context;
  const total = sources.urls.length + sources.github.length + sources.notion.length;

  if (total === 0) {
    log.debug('No context sources configured');
    return;
  }

  log.info(`Loading ${total} context source(s)…`);

  const results = await Promise.allSettled([
    ...sources.urls.map(s => fetchUrl(s)),
    ...sources.github.map(s => fetchGitHub(s)),
    ...sources.notion.map(s => fetchNotion(s, config)),
  ]);

  let loaded = 0;
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      await upsertContextMemory(result.value);
      loaded++;
    } else if (result.status === 'rejected') {
      log.warn('Context source failed', result.reason);
    }
  }

  log.info(`Context sources loaded: ${loaded}/${total}`);
}

export async function refreshStaleContextSources(config: Config): Promise<void> {
  // Check each source — re-fetch if last update is older than refreshDays
  const sources = config.context;
  const now = Date.now();

  const toRefresh: Array<Promise<ContextResult | null>> = [];

  for (const s of sources.urls) {
    if (isStale(`url:${s.url}`, s.refreshDays, now)) {
      toRefresh.push(fetchUrl(s));
    }
  }
  for (const s of sources.github) {
    const key = `github:${s.owner}/${s.repo}`;
    if (isStale(key, s.refreshDays, now)) {
      toRefresh.push(fetchGitHub(s));
    }
  }
  for (const s of sources.notion) {
    const key = `notion:${s.pageId}`;
    if (isStale(key, s.refreshDays, now)) {
      toRefresh.push(fetchNotion(s, config));
    }
  }

  if (toRefresh.length === 0) return;

  log.info(`Refreshing ${toRefresh.length} stale context source(s)…`);
  const results = await Promise.allSettled(toRefresh);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) await upsertContextMemory(r.value);
  }
}

// ─── URL fetcher ──────────────────────────────────────────────────────────────

async function fetchUrl(source: ContextUrl): Promise<ContextResult | null> {
  log.info(`Fetching URL: ${source.url}`);
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': 'Argos/1.0 (context loader)' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') ?? '';
    let text: string;

    if (contentType.includes('text/html')) {
      const html = await res.text();
      text = extractTextFromHtml(html);
    } else {
      text = await res.text();
    }

    return {
      key:     `url:${source.url}`,
      name:    source.name,
      content: `[${source.name}]\nSource: ${source.url}\n\n${text.slice(0, 8000)}`,
      tags:    ['context', 'url', source.name.toLowerCase().replace(/\s+/g, '_')],
    };
  } catch (e) {
    log.warn(`URL fetch failed (${source.url}): ${e}`);
    return null;
  }
}

// ─── GitHub fetcher ───────────────────────────────────────────────────────────

async function fetchGitHub(source: ContextGitHub): Promise<ContextResult | null> {
  const repoLabel = source.name ?? `${source.owner}/${source.repo}`;
  log.info(`Fetching GitHub: ${source.owner}/${source.repo}`);

  try {
    const parts: string[] = [`# ${repoLabel}\nhttps://github.com/${source.owner}/${source.repo}\n`];
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3.raw',
      'User-Agent': 'Argos/1.0',
    };

    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }

    // Fetch each configured path
    for (const filePath of source.paths) {
      const url = `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${filePath}`;
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue;

        const body = await res.text();
        // GitHub API returns base64-encoded content for non-raw
        let content = body;
        try {
          const json = JSON.parse(body);
          if (json.encoding === 'base64' && json.content) {
            content = Buffer.from(json.content, 'base64').toString('utf8');
          }
        } catch {}

        parts.push(`\n## ${filePath}\n\n${content.slice(0, 3000)}`);
      } catch {
        log.debug(`Could not fetch ${source.owner}/${source.repo}/${filePath}`);
      }
    }

    const combined = parts.join('\n').slice(0, 8000);

    return {
      key:     `github:${source.owner}/${source.repo}`,
      name:    repoLabel,
      content: combined,
      tags:    ['context', 'github', source.owner, source.repo],
    };
  } catch (e) {
    log.warn(`GitHub fetch failed (${source.owner}/${source.repo}): ${e}`);
    return null;
  }
}

// ─── Notion fetcher ───────────────────────────────────────────────────────────

async function fetchNotion(source: ContextNotion, config: Config): Promise<ContextResult | null> {
  if (!config.notion?.apiKey) {
    log.warn('Notion context source configured but no API key — skipping');
    return null;
  }

  log.info(`Fetching Notion ${source.type}: ${source.name}`);

  try {
    const { Client } = await import('@notionhq/client');
    const client = new Client({ auth: config.notion.apiKey });

    let content: string;

    if (source.type === 'database') {
      content = await fetchNotionDatabase(client, source.pageId, source.name);
    } else {
      content = await fetchNotionPage(client, source.pageId, source.name);
    }

    return {
      key:     `notion:${source.pageId}`,
      name:    source.name,
      content: content.slice(0, 8000),
      tags:    ['context', 'notion', source.name.toLowerCase().replace(/\s+/g, '_')],
    };
  } catch (e) {
    log.warn(`Notion fetch failed (${source.name}): ${e}`);
    return null;
  }
}

async function fetchNotionPage(
  client: InstanceType<typeof import('@notionhq/client').Client>,
  pageId: string,
  name: string,
): Promise<string> {
  // Get page blocks (content)
  const { results } = await client.blocks.children.list({ block_id: pageId, page_size: 50 });

  const lines: string[] = [`# ${name} (Notion page)\n`];

  for (const block of results) {
    const b = block as Record<string, unknown>;
    const type = b.type as string;
    const data = b[type] as { rich_text?: Array<{ plain_text: string }> } | undefined;
    const text = data?.rich_text?.map(r => r.plain_text).join('') ?? '';

    if (!text) continue;

    switch (type) {
      case 'heading_1': lines.push(`# ${text}`); break;
      case 'heading_2': lines.push(`## ${text}`); break;
      case 'heading_3': lines.push(`### ${text}`); break;
      case 'bulleted_list_item': lines.push(`• ${text}`); break;
      case 'numbered_list_item': lines.push(`- ${text}`); break;
      case 'to_do': {
        const checked = (data as { checked?: boolean }).checked ? '☑' : '☐';
        lines.push(`${checked} ${text}`);
        break;
      }
      default: lines.push(text);
    }
  }

  return lines.join('\n');
}

async function fetchNotionDatabase(
  client: InstanceType<typeof import('@notionhq/client').Client>,
  databaseId: string,
  name: string,
): Promise<string> {
  const { results } = await client.databases.query({
    database_id: databaseId,
    page_size: 30,
    // Only fetch non-archived items
    filter: {
      property: 'archived',
      checkbox: { equals: false },
    },
  }).catch(() => client.databases.query({ database_id: databaseId, page_size: 30 }));

  const lines: string[] = [`# ${name} (Notion database)\n`];

  for (const page of results) {
    const p = page as unknown as {
      properties: Record<string, {
        type: string;
        title?: Array<{ plain_text: string }>;
        rich_text?: Array<{ plain_text: string }>;
        checkbox?: boolean;
        select?: { name: string };
        date?: { start: string };
      }>;
    };

    // Find the title property
    let title = '(untitled)';
    for (const prop of Object.values(p.properties)) {
      if (prop.type === 'title' && prop.title?.length) {
        title = prop.title.map(r => r.plain_text).join('');
        break;
      }
    }

    // Check for Done/Status
    const doneProps = Object.entries(p.properties)
      .filter(([, v]) => v.type === 'checkbox')
      .map(([, v]) => (v.checkbox ? '☑' : '☐'));

    const statusProp = Object.entries(p.properties)
      .filter(([, v]) => v.type === 'select' && v.select)
      .map(([, v]) => v.select!.name)[0];

    const prefix = doneProps[0] ?? '';
    const suffix = statusProp ? ` [${statusProp}]` : '';
    lines.push(`${prefix} ${title}${suffix}`);
  }

  return lines.join('\n');
}

// ─── Memory upsert ────────────────────────────────────────────────────────────

let _ulid: (() => string) | null = null;

async function getUlid(): Promise<() => string> {
  if (!_ulid) {
    const { monotonicFactory } = await import('ulid');
    _ulid = monotonicFactory();
  }
  return _ulid;
}

async function upsertContextMemory(result: ContextResult): Promise<void> {
  const db = getDb();

  const existing = db.prepare(
    `SELECT id FROM memories WHERE source_ref = ? AND category = 'context'`
  ).get(result.key) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE memories SET content = ?, tags = ?, created_at = ? WHERE id = ?
    `).run(result.content, JSON.stringify(result.tags), Date.now(), existing.id);
    log.debug(`Context memory updated: ${result.name}`);
  } else {
    const ulid = await getUlid();
    db.prepare(`
      INSERT INTO memories (id, content, tags, category, source_ref, importance, archived, expires_at, created_at)
      VALUES (?, ?, ?, 'context', ?, 7, 1, NULL, ?)
    `).run(ulid(), result.content, JSON.stringify(result.tags), result.key, Date.now());
    log.info(`Context memory stored: ${result.name}`);
  }
}

// ─── Stale check ──────────────────────────────────────────────────────────────

function isStale(key: string, refreshDays: number, now: number): boolean {
  const db = getDb();
  const row = db.prepare(
    `SELECT created_at FROM memories WHERE source_ref = ? AND category = 'context'`
  ).get(key) as { created_at: number } | undefined;

  if (!row) return true;
  const ageMs = now - row.created_at;
  return ageMs > refreshDays * 24 * 60 * 60 * 1000;
}

// ─── HTML text extraction ─────────────────────────────────────────────────────

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}
