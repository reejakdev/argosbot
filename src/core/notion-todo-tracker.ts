/**
 * Notion Todo Tracker.
 *
 * Scans configured Notion Todo databases (one per priority/planet in the user's
 * "Hub Atlas" workspace), looks for priority-1 tasks that have been stale for
 * more than 7 days, and emits a single Telegram notification listing the
 * stagnating items.
 *
 * Safe-by-default:
 *   - Cron is a no-op when config.notion.todoDatabaseIds is empty.
 *   - If no stagnating tasks are found, no notification is sent.
 *   - Status property name is detected heuristically; "Done"-like statuses are
 *     filtered client-side to avoid schema coupling.
 */

import { createLogger } from '../logger.js';
import type { Config } from '../config/schema.js';

const log = createLogger('notion-todo-tracker');

type NotionClient = InstanceType<typeof import('@notionhq/client').Client>;

interface NotionProp {
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  select?: { name: string } | null;
  status?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
}

interface NotionPage {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, NotionProp>;
}

interface StagnatingTask {
  dbId: string;
  dbName: string;
  title: string;
  url: string;
  lastEdited: string;
  priority: string;
}

function getTitle(props: Record<string, NotionProp>): string {
  for (const p of Object.values(props)) {
    if (p.type === 'title' && p.title?.length) {
      return p.title.map((r) => r.plain_text).join('') || '(untitled)';
    }
  }
  return '(untitled)';
}

function getStatus(props: Record<string, NotionProp>): string | null {
  for (const [key, p] of Object.entries(props)) {
    const lk = key.toLowerCase();
    if (lk === 'statut' || lk === 'status' || lk === 'état' || lk === 'etat') {
      if (p.type === 'status' && p.status?.name) return p.status.name;
      if (p.type === 'select' && p.select?.name) return p.select.name;
    }
  }
  return null;
}

function getPriority(props: Record<string, NotionProp>): string | null {
  for (const [key, p] of Object.entries(props)) {
    const lk = key.toLowerCase();
    if (lk.includes('priorit') || lk === 'p') {
      if (p.type === 'select' && p.select?.name) return p.select.name;
      if (p.type === 'status' && p.status?.name) return p.status.name;
      if (p.type === 'multi_select' && p.multi_select?.length) return p.multi_select[0].name;
      if (p.type === 'rich_text' && p.rich_text?.length) {
        return p.rich_text.map((r) => r.plain_text).join('');
      }
    }
  }
  return null;
}

function isHighPriority(p: string | null, markers: string[]): boolean {
  if (!p) return false;
  const lp = p.toLowerCase().trim();
  return markers.some((m) => lp.includes(m.toLowerCase()));
}

async function scanDatabase(
  client: NotionClient,
  dbId: string,
): Promise<{ dbName: string; pages: NotionPage[] }> {
  // Fetch DB meta for name
  let dbName = dbId.slice(0, 8);
  try {
    const meta = (await client.databases.retrieve({ database_id: dbId })) as unknown as {
      title?: Array<{ plain_text: string }>;
    };
    if (meta.title?.length) {
      dbName = meta.title.map((t) => t.plain_text).join('') || dbName;
    }
  } catch (e) {
    log.warn(`failed to retrieve db meta for ${dbId}: ${e}`);
  }

  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const res = (await client.databases.query({
      database_id: dbId,
      page_size: 100,
      start_cursor: cursor,
    })) as unknown as { results: NotionPage[]; has_more: boolean; next_cursor: string | null };
    pages.push(...res.results);
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return { dbName, pages };
}

export async function runNotionTodoTracker(
  config: Config,
  sendNotification: (msg: string) => Promise<void> | void,
): Promise<void> {
  const dbIds = config.notion?.todoDatabaseIds ?? [];
  if (dbIds.length === 0) {
    return;
  }
  if (!config.notion?.apiKey) {
    log.warn('notion-todo-tracker: no API key, skipping');
    return;
  }

  const tracker = config.notion?.todoTracker;
  const STAGNATE_DAYS = tracker?.stagnationDays ?? 7;
  const PRIORITY_KEYWORDS = tracker?.priorityKeywords ?? ['P1', 'High', 'Élevée', 'Urgent'];
  const DONE_STATUSES = new Set(
    (tracker?.statusDoneKeywords ?? ['Done', 'Terminé', 'Fini', 'Completed']).map((s) =>
      s.toLowerCase(),
    ),
  );
  const MAX_ALERTS = tracker?.maxAlerts ?? 10;

  const { Client } = await import('@notionhq/client');
  const client = new Client({ auth: config.notion.apiKey });

  const now = Date.now();
  const stagnateCutoff = now - STAGNATE_DAYS * 24 * 60 * 60 * 1000;

  let totalOpen = 0;
  const stagnating: StagnatingTask[] = [];

  for (const dbId of dbIds) {
    try {
      const { dbName, pages } = await scanDatabase(client, dbId);
      for (const page of pages) {
        const status = getStatus(page.properties);
        if (status && DONE_STATUSES.has(status.toLowerCase())) continue;
        totalOpen++;

        const lastEditedMs = new Date(page.last_edited_time).getTime();
        if (Number.isNaN(lastEditedMs)) continue;
        if (lastEditedMs >= stagnateCutoff) continue;

        const priority = getPriority(page.properties);
        if (!isHighPriority(priority, PRIORITY_KEYWORDS)) continue;

        stagnating.push({
          dbId,
          dbName,
          title: getTitle(page.properties),
          url: page.url,
          lastEdited: page.last_edited_time,
          priority: priority ?? '?',
        });
      }
    } catch (e) {
      log.error(`notion-todo-tracker: scan failed for db ${dbId}: ${e}`);
    }
  }

  log.info(
    `notion-todo-tracker: scanned ${dbIds.length} DBs, ${totalOpen} open tasks, ${stagnating.length} stagnating`,
  );

  if (stagnating.length === 0) return;

  // Group by db, cap total at configured max
  const byDb = new Map<string, StagnatingTask[]>();
  for (const t of stagnating.slice(0, MAX_ALERTS)) {
    const arr = byDb.get(t.dbName) ?? [];
    arr.push(t);
    byDb.set(t.dbName, arr);
  }

  const lines: string[] = [
    `⚠️ *Priorités qui stagnent* (> ${STAGNATE_DAYS}j)`,
    ``,
  ];
  for (const [dbName, tasks] of byDb) {
    lines.push(`*${dbName}*`);
    for (const t of tasks) {
      const days = Math.floor((now - new Date(t.lastEdited).getTime()) / (24 * 60 * 60 * 1000));
      lines.push(`• [${t.priority}] ${t.title} _(${days}j)_ → ${t.url}`);
    }
    lines.push(``);
  }

  await sendNotification(lines.join('\n').trimEnd());
}
