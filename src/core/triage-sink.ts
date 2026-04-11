/**
 * Triage sink — persists a TriageResult to the right destination.
 *
 * Routes:
 *   my_task / team_task → SQLite tasks + Notion todo (if configured)
 *   my_reply            → proposal in DB (draft reply, needs approval)
 *   tx_whitelist        → tx review pack proposal
 */

import { createLogger } from '../logger.js';
import { getDb, audit } from '../db/index.js';
import { monotonicFactory } from 'ulid';
import { formatMessageLinks } from '../ingestion/channels/telegram.js';
import type { Config } from '../config/schema.js';
import type { LLMConfig } from '../llm/index.js';
import type { TriageResult } from './triage.js';

const log = createLogger('triage-sink');
const ulid = monotonicFactory();

/**
 * Build a human-readable legend for anonymized placeholders in a message body.
 * Helps the LLM understand what [ADDR_1], [AMT_10K-100K_USDC], [PERSON_1] etc. refer to
 * so it can write natural drafts without echoing the raw placeholder tokens.
 */
function buildPlaceholderLegend(body: string): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const [, token] of body.matchAll(/\[([A-Z0-9_\-]+)\]/g)) {
    if (seen.has(token)) continue;
    seen.add(token);

    if (/^ADDR_/.test(token)) lines.push(`[${token}] = a wallet / blockchain address`);
    else if (/^AMT_/.test(token)) lines.push(`[${token}] = an amount (crypto or fiat)`);
    else if (/^HASH_/.test(token)) lines.push(`[${token}] = a transaction hash`);
    else if (/^ENS_/.test(token)) lines.push(`[${token}] = an ENS domain`);
    else if (/^PERSON_/.test(token)) lines.push(`[${token}] = a person's name`);
    else if (/^EMAIL_/.test(token)) lines.push(`[${token}] = an email address`);
    else if (/^PHONE_/.test(token)) lines.push(`[${token}] = a phone number`);
    else if (/^IBAN_/.test(token)) lines.push(`[${token}] = a bank account (IBAN)`);
    else lines.push(`[${token}] = a redacted value`);
  }

  return lines.join('\n');
}

/** Truncate at word boundary, appending ellipsis if cut. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

// ─── Notification formatting ──────────────────────────────────────────────────

function notionPageUrl(pageId: string | null | undefined): string | null {
  if (!pageId) return null;
  return `https://notion.so/${pageId.replace(/-/g, '')}`;
}

function sourceLinks(messageUrl?: string | null, notionPageId?: string | null): string {
  const parts: string[] = [];
  if (messageUrl) parts.push(`[↗ Message](${messageUrl})`);
  const notionUrl = notionPageUrl(notionPageId);
  if (notionUrl) parts.push(`[↗ Notion](${notionUrl})`);
  return parts.join('  ·  ');
}

function formatTaskNotif(
  title: string,
  partner: string | undefined,
  urgency: string,
  icon: string,
  messageUrl?: string | null,
  notionPageId?: string | null,
): string {
  const links = sourceLinks(messageUrl, notionPageId);
  const partnerLine = partner ? `\n_${partner}_` : '';
  const linksLine = links ? `\n${links}` : '';
  return `${icon} *${truncate(title, 90)}*${partnerLine}${linksLine}`;
}

// ─── In-memory LRU cache for memory+knowledge searches in generateDraftReply ──
// Process-local, TTL 5 min, cap 50 entries. Cuts duplicate FTS5/vector searches
// when the same partner sends similar messages in a short window.
interface DraftSearchCacheEntry {
  memories: Array<{ content: string }>;
  styleMemories: Array<{ content: string }>;
  knowledgeContext: string;
  expires: number;
}
const _draftSearchCache = new Map<string, DraftSearchCacheEntry>();
const DRAFT_CACHE_TTL_MS = 5 * 60 * 1000;
const DRAFT_CACHE_MAX = 50;
function _draftCacheGet(key: string): DraftSearchCacheEntry | undefined {
  const entry = _draftSearchCache.get(key);
  if (!entry) return undefined;
  if (entry.expires < Date.now()) {
    _draftSearchCache.delete(key);
    return undefined;
  }
  // LRU touch
  _draftSearchCache.delete(key);
  _draftSearchCache.set(key, entry);
  return entry;
}
function _draftCacheSet(key: string, entry: DraftSearchCacheEntry): void {
  _draftSearchCache.set(key, entry);
  while (_draftSearchCache.size > DRAFT_CACHE_MAX) {
    const oldest = _draftSearchCache.keys().next().value;
    if (oldest === undefined) break;
    _draftSearchCache.delete(oldest);
  }
}

// ─── Main sink ─────────────────────────────────────────────────────────────────

export async function triageSink(
  result: TriageResult,
  config: Config,
  sendNotification: (text: string) => Promise<void>,
  llmConfig?: LLMConfig,
): Promise<void> {
  switch (result.route) {
    case 'my_task':
    case 'team_task':
      await sinkTask(result, config, sendNotification, llmConfig);
      break;
    case 'my_reply':
      await sinkReply(result, config, sendNotification, llmConfig);
      break;
    case 'notification':
      await sinkNotification(result, config, sendNotification, llmConfig);
      break;
    case 'tx_whitelist':
      await sinkTxWhitelist(result, config, sendNotification, llmConfig);
      break;
  }
}

// ─── Task sink (my_task + team_task) ──────────────────────────────────────────

async function sinkTask(
  result: TriageResult,
  config: Config,
  notify: (text: string) => Promise<void>,
  llmConfig?: LLMConfig,
): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const isMyTask = result.route === 'my_task' ? 1 : 0;

  // Dedup — if an open/in_progress task already exists for this chat, skip creation.
  // Also catches recently-completed tasks (< 2h) to prevent restart-replay duplicates.
  // chat_id is globally unique per platform so no need to filter by channel.
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const existing = db
    .prepare(
      `
    SELECT id FROM tasks
    WHERE chat_id = ?
      AND (
        status IN ('open', 'in_progress')
        OR (status = 'completed' AND completed_at > ?)
      )
    ORDER BY detected_at DESC
    LIMIT 1
  `,
    )
    .get(result.chatId, twoHoursAgo) as { id: string } | undefined;

  if (existing) {
    log.debug(
      `Task dedup — open task ${existing.id} already exists for ${result.partner}, skipping`,
    );
    // Dedup path: still notify for my_task (new message on same thread).
    // createNotification deduplicates in DB (upsert per chat).
    if (isMyTask && result.urgency !== 'low') {
      try {
        const { createNotification } = await import('./notifications.js');
        await createNotification(result, config, llmConfig);
      } catch (e) {
        log.warn(`createNotification (dedup) failed: ${e}`);
      }
      const icon = result.urgency === 'high' ? '🔴' : '🟡';
      await notify(formatTaskNotif(result.title, result.partner, result.urgency, icon, result.messageUrl, null) + '\n_↩ déjà dans ta liste_').catch(() => {});
    }
    // Low-urgency or team_task dedup → silent (no notify, owner already has the task open)
    return;
  }

  const id = ulid();

  // 1. SQLite — tasks are always persisted (even in readOnly), so the owner
  // has a real to-do list. Only side-effects (Notion writes, draft generation,
  // outbound sends) are suppressed by readOnly.
  db.prepare(
    `
    INSERT INTO tasks (id, title, description, category, source_ref, partner_name,
                       chat_id, channel, assigned_team, is_my_task, status, detected_at, message_url)
    VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `,
  ).run(
    id,
    result.title,
    result.body,
    `triage:${result.rawRef}`,
    result.partner,
    result.chatId,
    result.channel,
    result.assignee && result.assignee !== 'me' ? result.assignee : null,
    isMyTask,
    now,
    result.messageUrl ?? null,
  );

  log.info(`Task saved: ${id} — "${result.title.slice(0, 60)}"`);
  audit('triage_task_created', id, 'task', { route: result.route, partner: result.partner });

  // 2. Notion Kanban — create before notification so we have the page URL
  const notionPageId = await createNotionTaskPage(
    config, id, result.title, result.body, result.partner, result.channel,
    result.urgency, result.route, result.messageUrl, now, 'midas',
  );

  // 3. Draft reply — only for my_reply route (direct ping/question). my_task is
  //    an action item, not a conversational reply — drafting there produces off-topic output.

  // 4. Notification — for my_task with urgency high or medium.
  // Low-urgency or team_task → silent (pull via /tasks).
  if (isMyTask && result.urgency !== 'low') {
    const icon = result.urgency === 'high' ? '🔴' : '🟡';
    await notify(formatTaskNotif(result.title, result.partner, result.urgency, icon, result.messageUrl, notionPageId)).catch(() => {});
  } else if (isMyTask) {
    log.info(`Silent my_task (urgency=${result.urgency}) — no notification ping`);
  } else {
    log.info(`Silent team_task created for "${result.assignee ?? 'unassigned'}" — no notification`);
  }
}

// ─── Draft reply generator ────────────────────────────────────────────────────

async function generateDraftReply(
  result: TriageResult,
  taskId: string,
  config: Config,
  llmConfig: LLMConfig,
  notify: (text: string) => Promise<void>,
): Promise<void> {
  const { llmCall } = await import('../llm/index.js');
  const { search } = await import('../memory/store.js');
  const ownerName = config.owner?.name ?? 'the owner';

  // Cache key — partner + first 200 chars of body
  const cacheKey = `${result.partner}::${result.body.slice(0, 200)}`;
  const cached = _draftCacheGet(cacheKey);

  let memories: Array<{ content: string }>;
  let knowledgeContext = '';

  if (cached) {
    memories = cached.memories;
    knowledgeContext = cached.knowledgeContext;
    log.debug(`generateDraftReply: cache hit for ${result.partner}`);
  } else {
    // 1. Search memory for relevant context (addresses, past interactions, docs)
    // Writing style is already in the system prompt via user.md (/train command)
    memories = search({
      query: result.body,
      partnerName: result.partner,
      limit: 5,
    });

    log.debug(
      `generateDraftReply: ${memories.length} memory result(s) for partner=${result.partner}`,
    );

    // 3. Search knowledge sources (Notion, files) via semantic search if available
    try {
      const { hybridSearch } = await import('../vector/store.js');
      const embCfg = (
        config as unknown as { embeddings?: import('../config/schema.js').EmbeddingsConfig }
      ).embeddings;
      if (embCfg?.enabled) {
        const results = await hybridSearch(result.body, embCfg, { topK: 3, minSimilarity: 0.35 });
        if (results.length) {
          knowledgeContext = results.map((r) => r.chunk.content).join('\n\n');
        }
      }
    } catch (e) {
      log.warn(`Knowledge semantic search failed in generateDraftReply: ${e}`);
    }

    _draftCacheSet(cacheKey, {
      memories,
      styleMemories: [],
      knowledgeContext,
      expires: Date.now() + DRAFT_CACHE_TTL_MS,
    });
  }

  const memoryContext = memories.length
    ? `\n\nRelevant context from memory:\n${memories.map((m) => `- ${m.content}`).join('\n')}`
    : '';

  const knowledgeBlock = knowledgeContext
    ? `\n\nRelevant knowledge:\n${knowledgeContext.slice(0, 4000)}`
    : '';

  // Build a placeholder legend so the LLM understands anonymized values
  // e.g. [ADDR_1] = "the wallet address mentioned", [AMT_10K-100K_USDC] = "the USDC amount"
  const placeholderLegend = buildPlaceholderLegend(result.body);
  const legendBlock = placeholderLegend
    ? `\n\nNote on anonymized placeholders in the message:\n${placeholderLegend}`
    : '';

  const response = await llmCall(llmConfig, [
    {
      role: 'system',
      content: `You are ${ownerName}. Write a reply to a partner message IN FIRST PERSON.
- Match the owner's writing style (see user profile above): concise, direct, same language as the partner.
- If the partner asks for specific data (addresses, amounts) AND you have it in context — include it.
- If you don't have the data — say you'll send it shortly, never make things up.
- Placeholders like [ADDR_1] or [AMT_...] in the message represent real values — reference them naturally (e.g. "I'll send you the address shortly" instead of "I'll send you [ADDR_1]").
- No greeting, no subject line — just the message body. Never refer to yourself in third person.${memoryContext}${knowledgeBlock}${legendBlock}`,
    },
    {
      role: 'user',
      content: `Partner: ${result.partner}\nTheir message: ${result.body}`,
    },
  ]);

  const draft = response.content.trim();
  if (!draft) return;

  // Store as proposal — owner must approve before it's sent
  const db = getDb();
  const pid = ulid();
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000; // 24h

  const actions = JSON.stringify([
    {
      tool: 'draft_reply',
      input: { to: result.partner, chatId: result.chatId, content: draft },
      description: `Reply to ${result.partner}`,
    },
  ]);

  db.prepare(
    `
    INSERT INTO proposals (id, task_id, context_summary, plan, actions, draft_reply, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
  `,
  ).run(
    pid,
    taskId,
    result.body.slice(0, 500),
    `Draft reply to ${result.partner}`,
    actions,
    draft,
    now,
    expiresAt,
  );

  audit('triage_draft_created', pid, 'proposal', {
    partner: result.partner,
    chatId: result.chatId,
  });

  await notify(
    `✏️ *Draft reply proposé* — ${result.partner}\n\n_"${draft.slice(0, 200)}"_\n\n_Approuve sur le web app pour envoyer_`,
  ).catch(() => {});
}

// ─── Reply sink ────────────────────────────────────────────────────────────────

async function sinkReply(
  result: TriageResult,
  config: Config,
  notify: (text: string) => Promise<void>,
  llmConfig?: LLMConfig,
): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const id = ulid();

  // Dedup — skip proposal creation if an unproposed draft already exists for this chat in last 30min
  const recentProposal = db
    .prepare(
      `SELECT id FROM proposals WHERE context_summary LIKE ? AND status = 'proposed' AND created_at > ? LIMIT 1`,
    )
    .get(`%${result.partner}%`, now - 30 * 60 * 1000) as { id: string } | undefined;

  if (recentProposal) {
    log.debug(`sinkReply dedup — proposal already exists for ${result.partner} (${recentProposal.id})`);
    // Still push notification (createNotification deduplicates by chat)
    const urgentIcon = result.urgency === 'high' ? '🔴' : result.urgency === 'medium' ? '🟡' : '💬';
    try {
      const { createNotification } = await import('./notifications.js');
      await createNotification(result, config, llmConfig);
    } catch (e) {
      log.warn(`createNotification (reply dedup) failed: ${e}`);
    }
    const links = sourceLinks(result.messageUrl);
    await notify(`${urgentIcon} *${result.partner}* — ${result.title}${links ? `\n${links}` : ''}\n_/proposals_`).catch(() => {});
    return;
  }

  // Generate a proper RAG-backed draft (same pipeline as my_task) when LLM available
  // Falls back to raw body placeholder so the proposal is never empty
  let draft = `[Draft — review before sending]\n\n${result.body}`;

  if (llmConfig && !config.readOnly) {
    try {
      // Re-use generateDraftReply — fires async, stores proposal separately.
      // Here we want the draft inline, so we call the LLM directly with the same
      // memory+knowledge context that generateDraftReply builds.
      const { llmCall } = await import('../llm/index.js');
      const { search } = await import('../memory/store.js');
      const ownerName = config.owner?.name ?? 'the owner';

      const memories = search({ query: result.body, partnerName: result.partner, limit: 5 });
      const memCtx = memories.length
        ? `\n\nRelevant context:\n${memories.map((m) => `- ${m.content}`).join('\n')}`
        : '';

      let knowledgeCtx = '';
      try {
        const { hybridSearch } = await import('../vector/store.js');
        const embCfg = (
          config as unknown as { embeddings?: import('../config/schema.js').EmbeddingsConfig }
        ).embeddings;
        if (embCfg?.enabled) {
          const hits = await hybridSearch(result.body, embCfg, { topK: 3, minSimilarity: 0.2 });
          if (hits.length)
            knowledgeCtx = `\n\nRelevant knowledge:\n${hits
              .map((r) => r.chunk.content)
              .join('\n\n')
              .slice(0, 4000)}`;
        }
      } catch {
        /* vector store optional */
      }

      const response = await llmCall(llmConfig, [
        {
          role: 'system',
          content: `You are ${ownerName}. Write a reply IN FIRST PERSON. Same language as the partner. No greeting, no subject — just the message body. If specific data is in context, include it. Otherwise say you'll follow up.${memCtx}${knowledgeCtx}`,
        },
        { role: 'user', content: `Partner: ${result.partner}\nTheir message: ${result.body}` },
      ]);

      if (response.content.trim()) draft = response.content.trim();
    } catch (e) {
      log.warn(`sinkReply: draft generation failed, using placeholder: ${e}`);
    }
  }

  const actions = JSON.stringify([
    {
      tool: 'draft_reply',
      input: { to: result.partner, content: draft, urgency: result.urgency },
      description: `Reply to ${result.partner}`,
    },
  ]);

  db.prepare(
    `
    INSERT INTO proposals (id, task_id, context_summary, plan, actions, draft_reply, status, created_at, expires_at)
    VALUES (?, NULL, ?, ?, ?, ?, 'proposed', ?, ?)
  `,
  ).run(
    id,
    `[Triage] Reply needed — ${result.partner}: ${result.title}`,
    result.body,
    actions,
    draft,
    now,
    now + 24 * 60 * 60 * 1000,
  );

  log.info(`Reply proposal created: ${id} — "${result.title.slice(0, 50)}"`);
  audit('triage_reply_proposal', id, 'proposal', { partner: result.partner });

  const urgentIcon = result.urgency === 'high' ? '🔴' : result.urgency === 'medium' ? '🟡' : '💬';
  try {
    const { createNotification } = await import('./notifications.js');
    await createNotification(result, config, llmConfig);
  } catch (e) {
    log.warn(`createNotification (reply) failed: ${e}`);
  }
  const links = sourceLinks(result.messageUrl);
  await notify(
    `${urgentIcon} *${result.partner}* — ${result.title}${links ? `\n${links}` : ''}\n\n_"${draft.slice(0, 160)}"_\n/proposals`,
  ).catch(() => {});
}

// ─── Notification-only sink (important info, no task) ────────────────────────

async function sinkNotification(
  result: TriageResult,
  config: Config,
  notify: (text: string) => Promise<void>,
  llmConfig?: LLMConfig,
): Promise<void> {
  // Only fire for medium+ urgency — low urgency notifications are silent
  if (result.urgency === 'low') {
    log.debug(`Notification-only: skipping low urgency for ${result.partner}`);
    return;
  }

  try {
    const { createNotification } = await import('./notifications.js');
    await createNotification(result, config, llmConfig);
  } catch (e) {
    log.warn(`createNotification (notification route) failed: ${e}`);
  }

  const icon = result.urgency === 'high' ? '🔴' : '🟡';
  const links = sourceLinks(result.messageUrl);
  await notify(`${icon} *${result.partner}*\n${result.title}${links ? `\n${links}` : ''}`).catch(() => {});

  log.info(`Notification-only: ${result.partner} — "${result.title.slice(0, 60)}" [${result.urgency}]`);
}

// ─── Tx whitelist sink ────────────────────────────────────────────────────────

async function sinkTxWhitelist(
  result: TriageResult,
  config: Config,
  notify: (text: string) => Promise<void>,
  _llmConfig?: LLMConfig,
): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const id = ulid();

  // Extract any addresses from title/body for display
  const ethAddrRegex = /\b0x[0-9a-fA-F]{40}\b/g;
  const addrs = [...(result.title + ' ' + result.body).matchAll(ethAddrRegex)].map((m) => m[0]);

  // Save as a task — owner handles the actual whitelisting via their own tooling
  db.prepare(
    `
    INSERT INTO tasks (id, title, description, category, source_ref, partner_name,
                       chat_id, channel, assigned_team, is_my_task, status, detected_at, message_url)
    VALUES (?, ?, ?, 'tx_request', ?, ?, ?, ?, NULL, 1, 'open', ?, ?)
  `,
  ).run(
    id,
    result.title,
    result.body,
    `triage:${result.rawRef}`,
    result.partner,
    result.chatId,
    result.channel,
    now,
    result.messageUrl ?? null,
  );

  log.info(`Whitelist task: ${id} — ${result.partner}`);
  audit('triage_whitelist_task', id, 'task', { partner: result.partner, addrs });

  // ── Notification ──────────────────────────────────────────────────────────
  const addrNote = addrs.length ? `\`${addrs.join('`  `')}\`` : '_adresse non détectée_';
  const links = sourceLinks(result.messageUrl);
  await notify(`🔐 *${result.partner}* — whitelist\n${addrNote}${links ? `\n${links}` : ''}\n/proposals`).catch(() => {});

  // Notion Kanban — tx_whitelist also goes to Todo — Midas
  await createNotionTaskPage(config, id, result.title, result.body, result.partner, result.channel, result.urgency, 'tx_whitelist', result.messageUrl, now);
}

// ─── Shared Notion task page creator (via NotionWorker) ───────────────────────

async function createNotionTaskPage(
  config: Config,
  taskId: string,
  title: string,
  body: string,
  partner: string | undefined,
  channel: string | undefined,
  urgency: string | undefined,
  type: string,
  messageUrl: string | undefined,
  detectedAt: number,
  database: 'midas' | 'personal' = 'midas',
): Promise<string | null> {
  if (!config.notion || config.readOnly) return null;

  const dbId = database === 'personal'
    ? config.triage.notionPersonalDatabaseId
    : (config.triage.notionTaskDatabaseId ?? config.triage.notionTodoDatabaseId);

  if (!dbId) return null;

  // Generate checklist — use primary LLM (anonymised title+body already safe to send)
  let steps: string[] = [];
  try {
    const { llmCall, llmConfigFromConfig, extractJson } = await import('../llm/index.js');
    const llm = llmConfigFromConfig(config);
    const resp = await llmCall(llm, [
      {
        role: 'system',
        content: `You are a task planner for a DeFi/fintech operations team. Given a task title and context, produce a concise ordered checklist of concrete steps to complete the task. Max 8 steps, 1 sentence each. Respond ONLY with JSON: {"steps": ["step 1", "step 2", ...]}. No markdown.`,
      },
      {
        role: 'user',
        content: `Task: ${title}\n\nContext: ${(body || '').slice(0, 1000)}`,
      },
    ]);
    const parsed = extractJson<{ steps: string[] }>(resp.content);
    if (Array.isArray(parsed?.steps)) steps = parsed.steps.slice(0, 8).map(String);
  } catch (e) {
    log.debug(`Checklist generation failed (non-blocking): ${e}`);
  }

  const { NotionWorker } = await import('../workers/notion.js');
  const worker = new NotionWorker(config);
  const result = await worker.createKanbanTask({
    database_id: dbId,
    title,
    body,
    partner,
    source_url: messageUrl,
    channel,
    urgency,
    type,
    detected_at: detectedAt,
    task_id: taskId,
    database,
    steps,
  });

  if (result.success && result.pageId) {
    getDb().prepare('UPDATE tasks SET notion_page_id = ? WHERE id = ?').run(result.pageId, taskId);
    return result.pageId;
  }

  if (!result.success) {
    audit('notion_sync_failed', taskId, 'task', { error: result.output, title: title.slice(0, 80) });
  }
  return null;
}

// ─── Public: create a personal todo in Notion ────────────────────────────────

export async function createPersonalTodo(
  config: Config,
  title: string,
  body?: string,
  source?: string,
): Promise<{ taskId: string; notionPageId: string | null }> {
  const db = getDb();
  const id = ulid();
  const now = Date.now();

  db.prepare(
    `INSERT INTO tasks (id, title, description, category, source_ref, is_my_task, status, detected_at)
     VALUES (?, ?, ?, 'personal', ?, 1, 'open', ?)`,
  ).run(id, title, body ?? null, source ?? null, now);

  const pageId = await createNotionTaskPage(
    config, id, title, body ?? '', undefined, undefined, 'medium', 'personal', undefined, now, 'personal',
  );

  log.info(`Personal todo created: ${id} — "${title.slice(0, 50)}"`);
  audit('personal_todo_created', id, 'task', { title: title.slice(0, 80) });
  return { taskId: id, notionPageId: pageId };
}
