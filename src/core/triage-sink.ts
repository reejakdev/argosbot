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
import type { Config } from '../config/schema.js';
import type { LLMConfig } from '../llm/index.js';
import type { TriageResult } from './triage.js';

const log = createLogger('triage-sink');
const ulid = monotonicFactory();

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

  // Dedup — if an open/in_progress task already exists for this partner+channel, skip creation
  const existing = db
    .prepare(
      `
    SELECT id FROM tasks
    WHERE chat_id = ? AND (channel = ? OR channel IS NULL)
      AND status IN ('open', 'in_progress')
    LIMIT 1
  `,
    )
    .get(result.chatId, result.channel) as { id: string } | undefined;

  if (existing) {
    log.debug(
      `Task dedup — open task ${existing.id} already exists for ${result.partner}, skipping`,
    );
    // Still generate draft reply and notify, but no new task
    if (llmConfig && !config.readOnly) {
      generateDraftReply(result, existing.id, config, llmConfig, notify).catch((e) =>
        log.warn(`Draft reply generation failed: ${e}`),
      );
    }
    const icon = isMyTask ? '📋' : '👥';
    const urgent = result.urgency === 'high' ? ' 🔴' : '';
    const link = result.messageUrl ? `\n[↗ source](${result.messageUrl})` : '';
    await notify(
      `${icon} *${result.title}*${urgent} _(task already open)_\n_${result.partner}_${link}`,
    ).catch(() => {});
    return;
  }

  const id = ulid();

  // 1. SQLite — always
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

  // 2. Notion — if configured and not read-only
  if (config.notion && !config.readOnly) {
    const dbId =
      config.triage.notionTodoDatabaseId ??
      (isMyTask ? config.notion.ownerDatabaseId : config.notion.agentDatabaseId) ??
      config.notion.agentDatabaseId;

    if (dbId) {
      try {
        const { NotionWorker } = await import('../workers/notion.js');
        const worker = new NotionWorker(config);
        await worker.createEntry({
          title: result.title,
          content: result.body,
          database_type: 'task',
          tags: [result.partner, result.urgency, ...(result.assignee ? [result.assignee] : [])],
          priority:
            result.urgency === 'high' ? 'High' : result.urgency === 'medium' ? 'Medium' : 'Low',
        });
        log.info(`Notion task created for "${result.title.slice(0, 50)}"`);
      } catch (e) {
        log.warn(`Notion write failed (task still saved in SQLite): ${e}`);
        audit('notion_sync_failed', id, 'task', {
          error: String(e),
          title: result.title.slice(0, 80),
        });
      }
    }
  }

  // 3. Draft reply — generate and store as proposal (requires approval before send)
  if (llmConfig && !config.readOnly) {
    generateDraftReply(result, id, config, llmConfig, notify).catch((e) =>
      log.warn(`Draft reply generation failed: ${e}`),
    );
  }

  // 4. Notification
  const icon = isMyTask ? '📋' : '👥';
  const team = result.assignee && result.assignee !== 'me' ? ` → ${result.assignee}` : '';
  const urgent = result.urgency === 'high' ? ' 🔴' : '';
  const link = result.messageUrl ? `\n[↗ source](${result.messageUrl})` : '';
  await notify(`${icon} *${result.title}*${team}${urgent}\n_${result.partner}_${link}`).catch(
    () => {},
  );
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

  // 1. Search memory for relevant context (addresses, past interactions, docs)
  const memories = search({
    query: result.body,
    partnerName: result.partner,
    limit: 5,
  });
  log.debug(
    `generateDraftReply: ${memories.length} memory result(s) for partner=${result.partner}`,
  );

  // 2. Search knowledge sources (Notion, files) via semantic search if available
  let knowledgeContext = '';
  try {
    const { hybridSearch } = await import('../vector/store.js');
    const embCfg = (
      config as unknown as { embeddings?: import('../config/schema.js').EmbeddingsConfig }
    ).embeddings;
    log.debug(`generateDraftReply: embeddings enabled=${embCfg?.enabled}`);
    if (embCfg?.enabled) {
      // hybridSearch = semantic + keyword — catches camelCase token names that don't embed well
      const results = await hybridSearch(result.body, embCfg, { topK: 3, minSimilarity: 0.35 });
      log.debug(`generateDraftReply: ${results.length} knowledge chunk(s) found`);
      if (results.length) {
        knowledgeContext = results.map((r) => r.chunk.content).join('\n\n');
      }
    }
  } catch (e) {
    log.warn(`Knowledge semantic search failed in generateDraftReply: ${e}`);
  }
  log.debug(
    `generateDraftReply: calling LLM for draft (knowledgeContext=${knowledgeContext.length} chars, body="${result.body.slice(0, 80)}")`,
  );

  const memoryContext = memories.length
    ? `\n\nRelevant context from memory:\n${memories.map((m) => `- ${m.content}`).join('\n')}`
    : '';

  const knowledgeBlock = knowledgeContext
    ? `\n\nRelevant knowledge:\n${knowledgeContext.slice(0, 4000)}`
    : '';

  const response = await llmCall(llmConfig, [
    {
      role: 'system',
      content: `You are ${ownerName}. Write a reply to a partner message IN FIRST PERSON.
If the partner is asking for specific data (addresses, amounts, info) AND you have it in the context below — include it directly in your reply.
If you don't have the data — say you'll send it shortly, don't make things up.
Same language as the partner. No greeting, no subject line — just the message body.
NEVER refer to yourself in third person.${memoryContext}${knowledgeBlock}`,
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
    INSERT INTO proposals (id, context_summary, plan, actions, draft_reply, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)
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

  const urgent = result.urgency === 'high' ? ' 🔴' : '';
  await notify(
    `💬 *Reply needed — ${result.partner}*${urgent}\n${result.title}\n\n_"${draft.slice(0, 180)}"_\n\n_Proposal \`${id.slice(-8)}\` — approve in the web app_`,
  ).catch(() => {});
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
  const addrNote = addrs.length
    ? `\nAddresses: \`${addrs.join('`, `')}\``
    : '\n⚠️ No address extracted';
  const link = result.messageUrl ? `\n[↗ source](${result.messageUrl})` : '';

  await notify(`🔐 *${result.title}*\n_${result.partner}_${addrNote}${link}`).catch(() => {});
}
