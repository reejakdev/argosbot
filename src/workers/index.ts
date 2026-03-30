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
import { upsertCronJob, disableCronJob } from '../scheduler/index.js';
import { executeTelegramTool } from '../plugins/telegram.js';

const ulid = monotonicFactory();
import type { Proposal, ProposedAction } from '../types.js';
import type { Config } from '../config/schema.js';

const log = createLogger('workers');

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

  // Mark proposal executed
  const now = Date.now();
  db.prepare(`UPDATE proposals SET status = 'executed', executed_at = ? WHERE id = ? AND status = 'approved'`).run(now, proposal.id);

  // Mark linked task as completed (only if all actions succeeded)
  if (proposal.taskId && results.every(r => r.success)) {
    db.prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`).run(now, proposal.taskId);
  }

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
  // In read-only mode: display the draft but don't send
  const content = input.content as string;
  const to = input.to as string;

  if (config.readOnly) {
    return {
      success: true,
      dryRun: true,
      output: `Draft for ${to} (not sent — read-only mode):\n"${content.slice(0, 300)}"`,
      data: { to, content },
    };
  }

  // Write mode not yet implemented — always draft for now
  return {
    success: true,
    dryRun: true,
    output: `Draft for ${to} (write mode not yet implemented):\n"${content.slice(0, 300)}"`,
    data: { to, content },
  };
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
  const id = ulid();

  db.prepare(`
    INSERT INTO tasks (id, title, description, category, source_ref, assigned_team, is_my_task, status, detected_at)
    VALUES (?, ?, ?, 'task', 'worker', ?, 0, 'open', ?)
  `).run(id, input.title, input.description ?? null, input.assigned_team ?? null, Date.now());

  return {
    success: true,
    dryRun: false,
    output: `Task created: ${input.title}`,
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

  if (!(require('node-cron') as typeof import('node-cron')).validate(schedule)) {
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

