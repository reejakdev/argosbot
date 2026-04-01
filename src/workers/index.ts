/**
 * Worker registry — executes approved actions.
 *
 * Each worker has minimal permissions:
 *   - reply     → read-only by default (draft mode), write after explicit enable
 *   - calendar  → Google Calendar read+write
 *   - notion    → agent workspace only, never main workspace
 *   - tx_prep   → read-only, produces a human-readable transaction review pack
 *
 * Workers are only called AFTER owner approval from the gateway.
 * Read-only mode (config.readOnly = true): workers produce output but don't write.
 */

import { monotonicFactory } from 'ulid';
import { getDb, audit } from '../db/index.js';
import { createLogger } from '../logger.js';
import { upsertCronJob, disableCronJob, validateCronSchedule } from '../scheduler/index.js';
import { executeTelegramTool } from '../plugins/telegram.js';

const ulid = monotonicFactory();
import type { Proposal, ProposedAction } from '../types.js';
import type { Config } from '../config/schema.js';

const log = createLogger('workers');

// Late-bound sender — set once MTProto channel is ready
let _sendDirectMessage: ((chatId: string, text: string) => Promise<void>) | null = null;

export function setSendDirectMessage(fn: (chatId: string, text: string) => Promise<void>): void {
  _sendDirectMessage = fn;
}

export async function sendDirectReply(to: string, chatId: string, content: string, config: Config): Promise<WorkerResult> {
  return executeDraftReply({ to, chatId, content }, config);
}

// ─── Worker result ────────────────────────────────────────────────────────────

export interface WorkerResult {
  success: boolean;
  output: string;
  dryRun: boolean;
  data?: unknown;
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

export async function executeProposal(
  proposal: Proposal,
  actions: ProposedAction[],
  config: Config,
  sendToApprovalChat: (text: string) => Promise<void>,
): Promise<void> {
  const db = getDb();

  log.info(`Executing proposal ${proposal.id}`, {
    actions: actions.length,
    readOnly: config.readOnly,
  });

  // Mark linked task as in_progress when execution starts
  if (proposal.taskId) {
    db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ? AND status = 'open'`).run(proposal.taskId);
  }

  const results: WorkerResult[] = [];

  for (const action of actions) {
    const payload = action.payload as { tool: string; input: Record<string, unknown> };
    log.info(`Executing: ${action.description}`);

    try {
      let result: WorkerResult;

      switch (payload.tool) {
        case 'draft_reply':
          result = await executeDraftReply(payload.input, config);
          break;
        case 'create_calendar_event':
          result = await executeCalendar(payload.input, config);
          break;
        case 'create_notion_entry':
          result = await executeNotion(payload.input, config);
          break;
        case 'prepare_tx_pack':
          result = await executeTxPack(payload.input, config);
          break;
        case 'create_task':
          result = executeCreateTask(payload.input);
          break;
        case 'set_reminder':
          result = executeSetReminder(payload.input);
          break;
        case 'create_cron_job':
          result = executeCreateCronJob(payload.input);
          break;
        case 'delete_cron_job':
          result = executeDeleteCronJob(payload.input);
          break;
        case 'telegram_add_chat':
        case 'telegram_ignore_chat':
        case 'telegram_list_chats':
          result = executeTelegramTool(payload.tool, payload.input);
          break;
        case 'send_email':
          result = await executeEmailSend(payload.input, config);
          break;
        case 'browser_action':
          result = await executeBrowserAction(payload.input, config);
          break;
        case 'sign_tx':
          result = await executeSignTx(payload.input, config);
          break;
        case 'add_knowledge_source':
          result = await executeAddKnowledgeSource(payload.input, config);
          break;
        default:
          result = { success: false, output: `Unknown tool: ${payload.tool}`, dryRun: true };
      }

      results.push(result);
      audit('worker_executed', proposal.id, payload.tool, { result: result.output, dryRun: result.dryRun });

    } catch (e) {
      const errMsg = String(e);
      log.error(`Worker failed: ${payload.tool}`, e);
      results.push({ success: false, output: `Error: ${errMsg}`, dryRun: false });
    }
  }

  // Atomically mark proposal executed + complete linked task.
  // A transaction ensures they succeed or fail together — no orphaned state.
  const now = Date.now();
  const allSucceeded = results.every(r => r.success);
  db.transaction(() => {
    db.prepare(`UPDATE proposals SET status = 'executed', executed_at = ? WHERE id = ? AND status = 'approved'`).run(now, proposal.id);
    if (proposal.taskId && allSucceeded) {
      db.prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`).run(now, proposal.taskId);
    }
  })();

  // Send execution summary to owner
  const summary = results.map((r, i) => {
    const icon = r.success ? '✅' : '❌';
    const draft = r.dryRun ? ' _(draft)_' : '';
    return `${icon} Action ${i + 1}${draft}: ${r.output.slice(0, 200)}`;
  }).join('\n');

  await sendToApprovalChat(
    `🚀 *Proposal ${proposal.id.slice(-8)} executed*\n\n${summary}`
  );
}

// ─── Individual workers ───────────────────────────────────────────────────────

async function executeDraftReply(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const content = input.content as string;
  const to      = input.to as string;
  const chatId  = (input.chatId as string | undefined) ?? to;

  if (config.readOnly) {
    return { success: true, dryRun: true, output: `Draft (read-only):\n"${content.slice(0, 300)}"`, data: { to, content } };
  }

  if (!_sendDirectMessage) {
    return { success: true, dryRun: true, output: `Draft (MTProto not ready):\n"${content.slice(0, 300)}"`, data: { to, content } };
  }

  try {
    await _sendDirectMessage(chatId, content);
    log.info(`Reply sent to chatId=${chatId}`);
    return { success: true, dryRun: false, output: `✅ Message envoyé à ${to}`, data: { to, content } };
  } catch (e) {
    return { success: false, dryRun: false, output: `❌ Envoi échoué: ${(e as Error).message}` };
  }
}

async function executeCalendar(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const { CalendarWorker } = await import('./calendar.js');
  const worker = new CalendarWorker(config);
  return worker.createEvent(input);
}

async function executeNotion(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const { NotionWorker } = await import('./notion.js');
  const worker = new NotionWorker(config);
  return worker.createEntry(input);
}

async function executeTxPack(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const { TxPrepWorker } = await import('./tx-prep.js');
  const worker = new TxPrepWorker();
  return worker.prepare(input, config.readOnly);
}

function executeCreateTask(input: Record<string, unknown>): WorkerResult {
  const db = getDb();

  // Dedup by title — avoid duplicate tasks for the same thing
  const title = String(input.title ?? '').trim();
  const existing = db.prepare(`
    SELECT id FROM tasks
    WHERE title = ? AND status IN ('open', 'in_progress')
    LIMIT 1
  `).get(title) as { id: string } | undefined;

  if (existing) {
    log.debug(`Task dedup — open task ${existing.id} already exists with title "${title.slice(0, 60)}"`);
    return {
      success: true,
      dryRun: false,
      output: `Task already exists (id: ${existing.id}): ${title}`,
      data: { id: existing.id, deduplicated: true },
    };
  }

  const id = ulid();
  db.prepare(`
    INSERT INTO tasks (id, title, description, category, source_ref, assigned_team, is_my_task, status, detected_at)
    VALUES (?, ?, ?, 'task', 'worker', ?, 0, 'open', ?)
  `).run(id, title, input.description ?? null, input.assigned_team ?? null, Date.now());

  return {
    success: true,
    dryRun: false,
    output: `Task created: ${title}`,
    data: { id },
  };
}

function executeSetReminder(input: Record<string, unknown>): WorkerResult {
  const fireAt = new Date(input.fire_at as string).getTime();

  // Store as a chain event that the scheduler will pick up
  const db = getDb();

  db.prepare(`
    INSERT INTO chain_events (id, event_key, payload, emitted_at, consumed)
    VALUES (?, 'reminder', ?, ?, 0)
  `).run(
    ulid(),
    JSON.stringify({ message: input.message, fireAt, contextRef: input.context_ref }),
    Date.now(),
  );

  return {
    success: true,
    dryRun: false,
    output: `Reminder set for ${new Date(fireAt).toLocaleString('fr-FR')}`,
  };
}

// Agent-created cron jobs are prefixed "agent:" to distinguish from built-in jobs.
// The handler 'proactive_plan' is registered at boot and calls runProactivePlan().

function executeCreateCronJob(input: Record<string, unknown>): WorkerResult {
  const rawName  = String(input.name ?? '').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const name     = `agent:${rawName}`;
  const schedule = String(input.schedule ?? '');
  const prompt   = String(input.prompt ?? '');
  const desc     = String(input.description ?? prompt.slice(0, 80));

  if (!name || !schedule || !prompt) {
    return { success: false, output: 'create_cron_job: name, schedule, and prompt are required', dryRun: false };
  }

  if (!validateCronSchedule(schedule)) {
    return { success: false, output: `Invalid cron expression: "${schedule}"`, dryRun: false };
  }

  const job = upsertCronJob(name, schedule, 'proactive_plan', { prompt, description: desc });

  return {
    success: true,
    dryRun: false,
    output: `Cron job "${name}" scheduled [${schedule}] — ${desc}. Job ID: ${job.id}`,
    data: { jobId: job.id, name, schedule },
  };
}

function executeDeleteCronJob(input: Record<string, unknown>): WorkerResult {
  const rawName = String(input.name ?? '');
  // Accept with or without the "agent:" prefix
  const name = rawName.startsWith('agent:') ? rawName : `agent:${rawName}`;

  disableCronJob(name);

  return {
    success: true,
    dryRun: false,
    output: `Cron job "${name}" disabled`,
  };
}

async function executeBrowserAction(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const { BrowserActionWorker } = await import('./browser-action.js');
  return new BrowserActionWorker(config).execute(input);
}

async function executeSignTx(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const { executeSignTx: sign } = await import('./tx-sign.js');
  return sign(input, config);
}

async function executeEmailSend(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const { EmailSendWorker } = await import('./email-send.js');
  return new EmailSendWorker(config).send(input);
}

async function executeAddKnowledgeSource(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const { getDataDir } = await import('../config/index.js');
  const { readFileSync, writeFileSync } = await import('fs');
  const { default: path } = await import('path');

  const cfgPath = path.join(getDataDir(), 'config.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  const knowledge = (raw.knowledge as Record<string, unknown>) ?? {};
  const sources = (knowledge.sources as unknown[]) ?? [];

  let newSource: Record<string, unknown>;
  let label: string;

  if (input.type === 'github' || (input.owner && input.repo)) {
    const owner = String(input.owner ?? '');
    const repo  = String(input.repo  ?? '');
    const paths = (input.paths as string[]) ?? ['README.md'];
    newSource = { type: 'github', owner, repo, paths, refreshHours: 168 };
    label = `github:${owner}/${repo}`;
  } else if (input.url) {
    const url  = String(input.url);
    const name = String(input.name ?? url.split('/').pop() ?? 'source');
    newSource = { type: 'url', name, url, refreshHours: 168 };
    label = url;
  } else {
    return { success: false, output: 'add_knowledge_source: url or owner+repo required', dryRun: false };
  }

  // Deduplicate
  const alreadyExists = sources.some((s: unknown) => {
    const src = s as Record<string, unknown>;
    return (src.type === 'url' && src.url === (newSource.url ?? '')) ||
      (src.type === 'github' && src.owner === newSource.owner && src.repo === newSource.repo);
  });

  if (!alreadyExists) {
    sources.push(newSource);
    knowledge.sources = sources;
    raw.knowledge = knowledge;
    writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8');
  }

  // Index immediately
  try {
    const { fetchUrl }      = await import('../knowledge/connectors/url.js');
    const { fetchGitHub }   = await import('../knowledge/connectors/github.js');
    const { indexDocument } = await import('../knowledge/indexer.js');

    let doc = null;
    if (newSource.type === 'url') {
      doc = await fetchUrl({ url: String(newSource.url), name: String(newSource.name), refreshDays: 7 });
    } else {
      doc = await fetchGitHub({
        owner: String(newSource.owner),
        repo:  String(newSource.repo),
        paths: newSource.paths as string[],
        refreshDays: 7,
      });
    }

    if (doc) {
      await indexDocument(doc, config);
      return { success: true, dryRun: false, output: `📚 Knowledge source indexed: ${label}` };
    }
    return { success: true, dryRun: false, output: `⚠️ Source saved but returned no content: ${label}` };
  } catch (e) {
    return { success: false, dryRun: false, output: `Source saved but indexing failed: ${(e as Error).message}` };
  }
}
