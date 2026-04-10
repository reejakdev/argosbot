/**
 * Notion knowledge connector.
 * Fetches a Notion page or database and converts it to readable text.
 *
 * Improvements over the previous shallow version:
 *   - Recurses into child_page blocks (configurable depth, hard cap 5)
 *   - Block budget to prevent runaway recursion (500 blocks per source)
 *   - Full database pagination (up to 200 entries, was 30)
 *   - Content cap raised from 8K to 50K chars (500 KB safety net remains)
 *   - Visible errors via log.error + audit('notion_fetch_failed', ...)
 *   - 429 retry with Retry-After honoring (3 attempts, exp backoff)
 *   - Page title prepended to chunks for better title-level search hits
 */

import { createLogger } from '../../logger.js';
import { audit } from '../../db/index.js';
import type { ContextNotion, Config } from '../../config/schema.js';
import type { KnowledgeDocument } from '../types.js';

const log = createLogger('knowledge:notion');

const HARD_MAX_DEPTH = 5;
const DEFAULT_DEPTH = 3;
const BLOCK_BUDGET = 500;
const DB_PAGE_CAP = 200;
const CONTENT_CAP = 50_000;
const MAX_BYTES = 500 * 1024;

type NotionClient = InstanceType<typeof import('@notionhq/client').Client>;

interface FetchCtx {
  blocksFetched: number;
}

function isNotionAPIError(e: unknown): e is { status?: number; code?: string; message?: string; headers?: Record<string, string> } {
  return typeof e === 'object' && e !== null;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const err = isNotionAPIError(e) ? e : {};
      const status = err.status;
      if (status === 429) {
        const retryAfter = Number(err.headers?.['retry-after'] ?? err.headers?.['Retry-After'] ?? 5);
        const waitMs = Math.max(1000, retryAfter * 1000) * Math.pow(2, attempt);
        log.warn(`[notion] 429 on ${label} — retry ${attempt + 1}/3 after ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export async function fetchNotion(
  source: ContextNotion,
  config: Config,
): Promise<KnowledgeDocument | null> {
  if (!config.notion?.apiKey) {
    log.warn('Notion context source configured but no API key — skipping');
    return null;
  }

  log.info(`Fetching Notion ${source.type}: ${source.name}`);

  try {
    const { Client } = await import('@notionhq/client');
    const client = new Client({ auth: config.notion.apiKey });
    const maxDepth = Math.min(HARD_MAX_DEPTH, config.notion.recursionDepth ?? DEFAULT_DEPTH);
    const ctx: FetchCtx = { blocksFetched: 0 };

    let content =
      source.type === 'database'
        ? await fetchNotionDatabase(client, source.pageId, source.name)
        : await fetchNotionPage(client, source.pageId, source.name, maxDepth, ctx);

    if (content.length > MAX_BYTES) {
      log.warn(
        `[knowledge:notion] document ${source.name} truncated from ${Math.round(content.length / 1024)} KB to 500 KB`,
      );
      content = content.slice(0, MAX_BYTES);
    }
    log.info(
      `[knowledge:notion] fetched ${source.name}, ~${Math.round(content.length / 1024)} KB, ${ctx.blocksFetched} blocks`,
    );

    // Prepend page title as header for title-level search hits
    const titled = content.startsWith(`# ${source.name}`)
      ? content
      : `# ${source.name}\n\n${content}`;

    return {
      key: `notion:${source.pageId}`,
      name: source.name,
      content: titled.slice(0, CONTENT_CAP),
      fullText: titled,
      tags: ['context', 'notion', source.name.toLowerCase().replace(/\s+/g, '_')],
    };
  } catch (e) {
    const err = isNotionAPIError(e) ? e : {};
    const status = err.status;
    const code = err.code;
    const message = err.message ?? String(e);
    log.error(`[notion] fetch failed for ${source.name}: status=${status} code=${code} ${message}`);
    try {
      audit('notion_fetch_failed', source.name, 'knowledge_source', { status, code, message });
    } catch {
      /* ignore */
    }
    return null;
  }
}

async function fetchNotionPage(
  client: NotionClient,
  pageId: string,
  name: string,
  depth: number,
  ctx: FetchCtx,
): Promise<string> {
  const lines: string[] = [`# ${name} (Notion page)\n`];

  if (ctx.blocksFetched >= BLOCK_BUDGET) {
    lines.push('[block budget exhausted]');
    return lines.join('\n');
  }

  // Paginate blocks
  let cursor: string | undefined;
  const allBlocks: Array<Record<string, unknown>> = [];
  do {
    const res = await withRetry(
      () => client.blocks.children.list({ block_id: pageId, page_size: 100, start_cursor: cursor }),
      `blocks.list(${pageId})`,
    );
    for (const b of res.results) {
      allBlocks.push(b as Record<string, unknown>);
      ctx.blocksFetched++;
      if (ctx.blocksFetched >= BLOCK_BUDGET) break;
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    if (ctx.blocksFetched >= BLOCK_BUDGET) break;
  } while (cursor);

  for (const b of allBlocks) {
    const type = b.type as string;
    const data = b[type] as
      | { rich_text?: Array<{ plain_text: string }>; checked?: boolean; title?: string }
      | undefined;
    const text = data?.rich_text?.map((r) => r.plain_text).join('') ?? '';

    switch (type) {
      case 'heading_1':
        if (text) lines.push(`# ${text}`);
        break;
      case 'heading_2':
        if (text) lines.push(`## ${text}`);
        break;
      case 'heading_3':
        if (text) lines.push(`### ${text}`);
        break;
      case 'bulleted_list_item':
        if (text) lines.push(`• ${text}`);
        break;
      case 'numbered_list_item':
        if (text) lines.push(`- ${text}`);
        break;
      case 'to_do': {
        const checked = data?.checked ? '☑' : '☐';
        if (text) lines.push(`${checked} ${text}`);
        break;
      }
      case 'child_page': {
        const childTitle = (data as { title?: string } | undefined)?.title ?? '(untitled child)';
        const childId = b.id as string;
        if (depth > 0 && childId && ctx.blocksFetched < BLOCK_BUDGET) {
          lines.push(`\n## ↳ ${childTitle}\n`);
          try {
            const nested = await fetchNotionPage(client, childId, childTitle, depth - 1, ctx);
            // Strip first line (the "# name (Notion page)" heading) to avoid duplication
            lines.push(nested.split('\n').slice(1).join('\n'));
          } catch (e) {
            log.warn(`[notion] failed to recurse into ${childTitle}: ${e}`);
          }
        } else {
          lines.push(`↳ ${childTitle} (not recursed)`);
        }
        break;
      }
      default:
        if (text) lines.push(text);
    }
  }

  return lines.join('\n');
}

/**
 * Render a single Notion property value as a short string.
 * Supports the common types we see across Midas DBs:
 * title, rich_text, select, status, multi_select, date, checkbox,
 * number, url, email, people, formula, relation, files, created_time, last_edited_time.
 */
function renderProperty(prop: Record<string, unknown>): string {
  const type = prop.type as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = prop[type];
  if (v == null) return '';

  switch (type) {
    case 'title':
    case 'rich_text':
      return Array.isArray(v) ? v.map((r) => r.plain_text ?? '').join('') : '';
    case 'select':
      return v?.name ?? '';
    case 'status':
      return v?.name ?? '';
    case 'multi_select':
      return Array.isArray(v) ? v.map((o) => o.name).join(', ') : '';
    case 'date':
      return v?.end ? `${v.start} → ${v.end}` : (v?.start ?? '');
    case 'checkbox':
      return v ? '☑' : '☐';
    case 'number':
      return String(v);
    case 'url':
      return String(v);
    case 'email':
      return String(v);
    case 'phone_number':
      return String(v);
    case 'people':
      return Array.isArray(v) ? v.map((p) => p.name ?? p.id ?? '').filter(Boolean).join(', ') : '';
    case 'files':
      return Array.isArray(v) ? v.map((f) => f.name ?? '').join(', ') : '';
    case 'relation':
      return Array.isArray(v) ? `${v.length} relation(s)` : '';
    case 'formula': {
      const ft = v?.type;
      if (!ft) return '';
      const fv = v[ft];
      return fv == null ? '' : String(fv);
    }
    case 'rollup': {
      const rt = v?.type;
      if (!rt) return '';
      const rv = v[rt];
      if (Array.isArray(rv)) return rv.length === 0 ? '' : `${rv.length} item(s)`;
      return rv == null ? '' : String(rv);
    }
    case 'created_time':
    case 'last_edited_time':
      return String(v);
    case 'created_by':
    case 'last_edited_by':
      return v?.name ?? v?.id ?? '';
    default:
      // unknown type — best effort
      try {
        return JSON.stringify(v).slice(0, 80);
      } catch {
        return '';
      }
  }
}

async function fetchNotionDatabase(
  client: NotionClient,
  databaseId: string,
  name: string,
): Promise<string> {
  const lines: string[] = [`# ${name} (Notion database)\n`];
  let cursor: string | undefined;
  let total = 0;

  do {
    const res = await withRetry(
      () =>
        client.databases.query({
          database_id: databaseId,
          page_size: 100,
          start_cursor: cursor,
        }),
      `databases.query(${databaseId})`,
    );

    for (const page of res.results) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = page as any;
      const props: Record<string, Record<string, unknown>> = p.properties ?? {};
      const url: string | undefined = p.url;
      const lastEdited: string | undefined = p.last_edited_time;

      // Find the title
      let title = '(untitled)';
      for (const v of Object.values(props)) {
        if (v.type === 'title') {
          title = renderProperty(v) || '(untitled)';
          break;
        }
      }

      // Detect status + priority for keyword enrichment (helps semantic search)
      let statusValue: string | null = null;
      let priorityValue: string | null = null;
      for (const [key, v] of Object.entries(props)) {
        const lk = key.toLowerCase();
        if (!statusValue && (lk === 'status' || lk === 'statut' || lk === 'état' || lk === 'etat')) {
          statusValue = renderProperty(v) || null;
        }
        if (!priorityValue && (lk.includes('priorit') || lk === 'priority')) {
          priorityValue = renderProperty(v) || null;
        }
      }

      // Render every other property as `Key: value`
      const propLines: string[] = [];
      for (const [key, v] of Object.entries(props)) {
        if (v.type === 'title') continue;
        const rendered = renderProperty(v);
        if (rendered) propLines.push(`  - ${key}: ${rendered}`);
      }

      // Build a status-keyword line that semantic search can match against
      // common queries like "deployment in progress", "tasks done", "ready to launch"
      const statusKeywords: string[] = [];
      if (statusValue) {
        const sv = statusValue.toLowerCase();
        statusKeywords.push(`status: ${statusValue}`);
        if (sv.includes('progress') && !sv.includes('paused')) {
          statusKeywords.push('in progress', 'currently being worked on', 'active deployment');
        }
        if (sv.includes('paused')) {
          statusKeywords.push('paused', 'on hold', 'blocked');
        }
        if (sv.includes('not started')) {
          statusKeywords.push('not started', 'pending', 'todo', 'queued');
        }
        if (sv.includes('ready')) {
          statusKeywords.push('ready', 'ready to launch', 'completed but not live');
        }
        if (sv.includes('live') || sv.includes('done') || sv.includes('completed')) {
          statusKeywords.push('live', 'launched', 'shipped', 'completed');
        }
      }

      // One block per row — title + status keywords up front so search matches both
      lines.push(`\n## ${title}`);
      if (statusKeywords.length) {
        lines.push(`> ${statusKeywords.join(' · ')}`);
      }
      if (lastEdited) propLines.unshift(`  - Last edited: ${lastEdited}`);
      if (url) propLines.unshift(`  - URL: ${url}`);
      if (propLines.length) lines.push(propLines.join('\n'));

      total++;
      if (total >= DB_PAGE_CAP) break;
    }

    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    if (total >= DB_PAGE_CAP) break;
  } while (cursor);

  lines.push(`\n_${total} entries fetched_`);
  return lines.join('\n');
}
