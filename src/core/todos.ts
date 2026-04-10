/**
 * Todos — batch extraction from anonymized chat history.
 *
 * Runs on a configurable cron (default 2h). For each chat with recent activity,
 * gathers the anonymized conversation window from the last N hours and asks the
 * primary cloud LLM to extract concrete TODOs. Privacy is preserved because we
 * only send `messages.anon_content`, never raw text.
 *
 * Optionally pushes new todos to Notion if configured + write mode.
 */

import { monotonicFactory } from 'ulid';
import { getDb, audit } from '../db/index.js';
import { createLogger } from '../logger.js';
import type { Config } from '../config/schema.js';
import type { LLMConfig } from '../llm/index.js';

const log = createLogger('todos');
const ulid = monotonicFactory();

export interface TodoRow {
  id: string;
  title: string;
  description: string | null;
  chat_id: string | null;
  partner_name: string | null;
  channel: string | null;
  source_window_ids: string | null;
  status: string;
  priority: string | null;
  created_at: number;
  completed_at: number | null;
  notion_page_id: string | null;
}

interface ExtractedTodo {
  title: string;
  description?: string;
  priority?: string;
}

interface ChatActivity {
  chat_id: string;
  partner_name: string | null;
  channel: string | null;
  message_ids: string[];
  anon_lines: string[];
}

function gatherActivity(lookbackHours: number): ChatActivity[] {
  const db = getDb();
  const since = Date.now() - lookbackHours * 3600 * 1000;

  // Pull anonymized messages over the window, grouped by chat
  const rows = db
    .prepare(
      `SELECT id, chat_id, partner_name, channel, anon_content, received_at
       FROM messages
       WHERE received_at >= ? AND anon_content IS NOT NULL AND anon_content != ''
       ORDER BY chat_id, received_at ASC`,
    )
    .all(since) as Array<{
    id: string;
    chat_id: string;
    partner_name: string | null;
    channel: string | null;
    anon_content: string;
    received_at: number;
  }>;

  const byChat = new Map<string, ChatActivity>();
  for (const r of rows) {
    let act = byChat.get(r.chat_id);
    if (!act) {
      act = {
        chat_id: r.chat_id,
        partner_name: r.partner_name,
        channel: r.channel,
        message_ids: [],
        anon_lines: [],
      };
      byChat.set(r.chat_id, act);
    }
    act.message_ids.push(r.id);
    act.anon_lines.push(`[${r.partner_name ?? 'them'}] ${r.anon_content}`);
  }
  return Array.from(byChat.values());
}

export async function extractTodosForChat(
  activity: ChatActivity,
  config: Config,
  llmConfig: LLMConfig,
): Promise<TodoRow[]> {
  const { llmCall, extractJson } = await import('../llm/index.js');

  // Cap conversation size to keep token costs sane
  const convo = activity.anon_lines.slice(-80).join('\n').slice(0, 4000);
  if (!convo.trim()) return [];

  let extracted: ExtractedTodo[] = [];
  try {
    const resp = await llmCall({ ...llmConfig, maxTokens: 1024 }, [
      {
        role: 'system',
        content: `Extract HIGH-PRECISION concrete TODOs from this anonymized partner conversation.
Reply ONLY with strict JSON: {"todos": [{"title": "...", "description": "...", "priority": "low|medium|high"}]}.

A TODO must have a CLEAR VERB + OBJECT and be something the owner can actually do.
REJECT vague items like "follow up", "check in", "discuss", "think about", "be aware".
REJECT status updates, FYI, social messages, OOO notices.
If nothing concrete, reply {"todos": []}.

EXAMPLES of GOOD todos (include):
  - "Send receiving address to partner X"
  - "Review Q1 contract draft"
  - "Schedule call with partner Y next week"
  - "Whitelist new beneficiary address"

EXAMPLES of BAD items (REJECT):
  - "Follow up with partner" (no concrete action)
  - "Check in on the project" (vague)
  - "Discuss timeline" (no decision/output)
  - "Be aware of the new policy" (info, not a todo)
  - "Stay on top of it" (vague)

Keep titles short (under 80 chars), start with a verb.`,
      },
      {
        role: 'user',
        content: `Partner: ${activity.partner_name ?? 'unknown'}\n\nConversation:\n${convo}`,
      },
    ]);
    const parsed = extractJson<{ todos: ExtractedTodo[] }>(resp.content);
    extracted = Array.isArray(parsed?.todos) ? parsed.todos : [];
  } catch (e) {
    log.warn(`Todo extraction LLM failed for chat ${activity.chat_id}: ${e}`);
    return [];
  }

  if (!extracted.length) return [];

  const db = getDb();
  const now = Date.now();
  const created: TodoRow[] = [];

  for (const t of extracted) {
    const title = String(t.title ?? '').trim();
    if (!title) continue;

    // Dedup: skip if an open todo with same (chat_id, title) exists
    const dup = db
      .prepare(
        `SELECT id FROM todos WHERE chat_id = ? AND title = ? AND status = 'open' LIMIT 1`,
      )
      .get(activity.chat_id, title) as { id: string } | undefined;
    if (dup) continue;

    const id = ulid();
    db.prepare(
      `INSERT INTO todos (id, title, description, chat_id, partner_name, channel, source_window_ids, status, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      id,
      title,
      t.description ?? null,
      activity.chat_id,
      activity.partner_name,
      activity.channel,
      JSON.stringify(activity.message_ids),
      t.priority ?? null,
      now,
    );
    audit('todo_created', id, 'todo', {
      partner: activity.partner_name,
      title: title.slice(0, 120),
    });

    const row = db.prepare(`SELECT * FROM todos WHERE id = ?`).get(id) as TodoRow;
    created.push(row);

    // Notion push (write mode only)
    if (config.notion && !config.readOnly) {
      try {
        const { NotionWorker } = await import('../workers/notion.js');
        const worker = new NotionWorker(config);
        const res = await worker.createEntry({
          title,
          content: t.description ?? '',
          database_type: 'todo',
          tags: [activity.partner_name ?? 'unknown', t.priority ?? 'low'],
          priority:
            t.priority === 'high' ? 'High' : t.priority === 'medium' ? 'Medium' : 'Low',
        });
        const pageId = (res.data as { pageId?: string } | undefined)?.pageId;
        if (pageId) {
          db.prepare(`UPDATE todos SET notion_page_id = ? WHERE id = ?`).run(pageId, id);
        }
      } catch (e) {
        log.warn(`Notion push failed for todo ${id}: ${e}`);
      }
    }
  }

  return created;
}

export async function runTodoExtraction(config: Config, llmConfig: LLMConfig): Promise<void> {
  if (!config.todoExtraction.enabled) {
    log.debug('Todo extraction disabled');
    return;
  }
  const lookback = config.todoExtraction.lookbackHours;
  const activities = gatherActivity(lookback);

  // Skip chats with zero new messages since the last cron run.
  // last_run is tracked in cron_jobs.last_run by the scheduler.
  const db = getDb();
  const lastRunRow = db
    .prepare(`SELECT last_run FROM cron_jobs WHERE handler = 'todo_extraction' OR name = 'todo_extraction' LIMIT 1`)
    .get() as { last_run: number | null } | undefined;
  const lastRun = lastRunRow?.last_run ?? 0;
  const filtered = activities.filter((act) => {
    const newCount = db
      .prepare(
        `SELECT COUNT(*) as n FROM messages WHERE chat_id = ? AND received_at > ? AND anon_content IS NOT NULL AND anon_content != ''`,
      )
      .get(act.chat_id, lastRun) as { n: number };
    return newCount.n > 0;
  });
  log.info(
    `Todo extraction over ${lookback}h: ${activities.length} active chat(s), ${filtered.length} with new messages since last run`,
  );

  let total = 0;
  for (const act of filtered) {
    try {
      const created = await extractTodosForChat(act, config, llmConfig);
      total += created.length;
    } catch (e) {
      log.warn(`extractTodosForChat failed for ${act.chat_id}: ${e}`);
    }
  }
  audit('todo_extraction_run', undefined, 'cron', {
    chats: activities.length,
    processed: filtered.length,
    created: total,
  });
  log.info(`Todo extraction done — ${total} new todo(s)`);
}

export function listOpenTodos(limit = 50): TodoRow[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM todos WHERE status = 'open' ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as TodoRow[];
}

export function markTodoDone(idOrSuffix: string): number {
  const db = getDb();
  const now = Date.now();
  if (idOrSuffix === 'all') {
    const r = db
      .prepare(`UPDATE todos SET status = 'done', completed_at = ? WHERE status = 'open'`)
      .run(now);
    audit('todo_done_all', undefined, 'todo', { count: r.changes });
    return r.changes;
  }
  const r = db
    .prepare(
      `UPDATE todos SET status = 'done', completed_at = ? WHERE status = 'open' AND (id = ? OR id LIKE ?)`,
    )
    .run(now, idOrSuffix, `%${idOrSuffix}`);
  if (r.changes > 0) audit('todo_done', idOrSuffix, 'todo', { count: r.changes });
  return r.changes;
}
