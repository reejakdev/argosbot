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
import { validateAndConsumeToken } from '../gateway/approval.js';
import { executeShellExec } from './shell-exec.js';

const ulid = monotonicFactory();
import type { Proposal, ProposedAction } from '../types.js';
import type { Config } from '../config/schema.js';

const log = createLogger('workers');

// Late-bound sender — set once MTProto channel is ready
let _sendDirectMessage: ((chatId: string, text: string) => Promise<void>) | null = null;

export function setSendDirectMessage(fn: (chatId: string, text: string) => Promise<void>): void {
  _sendDirectMessage = fn;
}

export async function sendDirectReply(
  to: string,
  chatId: string,
  content: string,
  config: Config,
): Promise<WorkerResult> {
  return executeDraftReply({ to, chatId, content }, config);
}

// ─── Worker result ────────────────────────────────────────────────────────────

export interface WorkerResult {
  success: boolean;
  output: string;
  dryRun: boolean;
  data?: unknown;
}

// ─── De-anonymization ─────────────────────────────────────────────────────────

/** Recursively restore placeholder values in an action input object. */
function deAnonymizeInput(
  input: Record<string, unknown>,
  lookup: Record<string, string>,
): Record<string, unknown> {
  if (Object.keys(lookup).length === 0) return input;

  function restore(val: unknown): unknown {
    if (typeof val === 'string') {
      // Replace all [PLACEHOLDER] tokens found in the lookup
      return val.replace(/\[[\w_]+\d*\]/g, (match) => lookup[match] ?? match);
    }
    if (Array.isArray(val)) return val.map(restore);
    if (val !== null && typeof val === 'object') {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, restore(v)]),
      );
    }
    return val;
  }

  return restore(input) as Record<string, unknown>;
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

export async function executeProposal(
  proposal: Proposal,
  actions: ProposedAction[],
  config: Config,
  sendToApprovalChat: (text: string) => Promise<void>,
  executionToken: string,
): Promise<void> {
  const db = getDb();

  // ── SECURITY GATE ─────────────────────────────────────────────────────────
  // Layer 2: validate ephemeral token generated at human approval time.
  // This is independent of the DB status check — both must pass.
  if (!validateAndConsumeToken(proposal.id, executionToken)) {
    log.error(`SECURITY: Execution of proposal ${proposal.id} blocked — invalid or missing token`);
    audit('execution_rejected', proposal.id, 'security', { reason: 'invalid_execution_token' });
    await sendToApprovalChat(
      `🚫 *Execution blocked* — proposal \`${proposal.id.slice(-8)}\` was rejected by the security gate.\nThe approval token was invalid, expired, or already used.`,
    );
    return;
  }
  // ──────────────────────────────────────────────────────────────────────────

  log.info(`Executing proposal ${proposal.id}`, {
    actions: actions.length,
    readOnly: config.readOnly,
  });

  // Mark linked task as in_progress when execution starts
  if (proposal.taskId) {
    db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ? AND status = 'open'`).run(
      proposal.taskId,
    );
  }

  // Load the anon lookup for this proposal — resolves placeholders back to real values.
  // Applied to each action's input just before execution. Never logged, never sent to LLM.
  let anonLookup: Record<string, string> = {};
  try {
    const row = db.prepare('SELECT anon_lookup FROM proposals WHERE id = ?').get(proposal.id) as
      | { anon_lookup: string | null }
      | undefined;
    if (row?.anon_lookup) anonLookup = JSON.parse(row.anon_lookup) as Record<string, string>;
  } catch {
    /* non-fatal — workers still run with placeholder text */
  }

  const results: WorkerResult[] = [];

  for (const action of actions) {
    const payload = action.payload as { tool: string; input: Record<string, unknown> };
    // De-anonymize string values in the input before handing to the worker.
    // Placeholders like [ADDR_1], [PERSON_1], [AMT_1] are restored to real values.
    const resolvedInput = deAnonymizeInput(payload.input, anonLookup);
    log.info(`Executing: ${action.description}`);

    try {
      let result: WorkerResult;

      switch (payload.tool) {
        case 'draft_reply':
          result = await executeDraftReply(resolvedInput, config);
          break;
        case 'create_calendar_event':
          result = await executeCalendar(resolvedInput, config);
          break;
        case 'create_notion_entry':
          result = await executeNotion(resolvedInput, config);
          break;
        case 'prepare_tx_pack':
          result = await executeTxPack(resolvedInput, config);
          break;
        case 'create_task':
          result = executeCreateTask(resolvedInput);
          break;
        case 'set_reminder':
          result = executeSetReminder(resolvedInput);
          break;
        case 'create_cron_job':
          result = executeCreateCronJob(resolvedInput);
          break;
        case 'delete_cron_job':
          result = executeDeleteCronJob(resolvedInput);
          break;
        case 'telegram_add_chat':
        case 'telegram_ignore_chat':
        case 'telegram_list_chats':
          result = executeTelegramTool(payload.tool, resolvedInput);
          break;
        case 'send_email':
          result = await executeEmailSend(resolvedInput, config);
          break;
        case 'browser_action':
          result = await executeBrowserAction(resolvedInput, config);
          break;
        case 'sign_tx':
          result = await executeSignTx(resolvedInput, config);
          break;
        case 'add_knowledge_source':
          result = await executeAddKnowledgeSource(resolvedInput, config);
          break;
        case 'create_agent':
          result = await executeCreateAgent(resolvedInput, config);
          break;
        case 'edit_config':
          result = await executeEditConfig(resolvedInput, config);
          break;
        case 'linear_create_issue':
          result = await executeLinearCreateIssue(resolvedInput, config);
          break;
        case 'linear_close_issue':
        case 'linear_update_issue':
          result = await executeLinearUpdateIssue(resolvedInput, config);
          break;
        case 'shell_exec':
          result = await executeShellExec(resolvedInput, config);
          break;
        default:
          result = { success: false, output: `Unknown tool: ${payload.tool}`, dryRun: true };
      }

      results.push(result);
      audit('worker_executed', proposal.id, payload.tool, {
        result: result.output,
        dryRun: result.dryRun,
      });
    } catch (e) {
      const errMsg = String(e);
      log.error(`Worker failed: ${payload.tool}`, e);
      results.push({ success: false, output: `Error: ${errMsg}`, dryRun: false });
    }
  }

  // Atomically mark proposal executed + complete linked task.
  // A transaction ensures they succeed or fail together — no orphaned state.
  const now = Date.now();
  const allSucceeded = results.every((r) => r.success);
  db.transaction(() => {
    db.prepare(
      `UPDATE proposals SET status = 'executed', executed_at = ? WHERE id = ? AND status = 'approved'`,
    ).run(now, proposal.id);
    if (proposal.taskId && allSucceeded) {
      db.prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`).run(
        now,
        proposal.taskId,
      );
    }
  })();

  // Send execution summary to owner
  const summary = results
    .map((r, i) => {
      const icon = r.success ? '✅' : '❌';
      const draft = r.dryRun ? ' _(draft)_' : '';
      return `${icon} Action ${i + 1}${draft}: ${r.output.slice(0, 200)}`;
    })
    .join('\n');

  await sendToApprovalChat(`🚀 *Proposal ${proposal.id.slice(-8)} executed*\n\n${summary}`);
}

// ─── Individual workers ───────────────────────────────────────────────────────

async function executeDraftReply(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const content = input.content as string;
  const to = input.to as string;
  const chatId = (input.chatId as string | undefined) ?? to;

  if (config.readOnly) {
    return {
      success: true,
      dryRun: true,
      output: `Draft (read-only):\n"${content.slice(0, 300)}"`,
      data: { to, content },
    };
  }

  if (!_sendDirectMessage) {
    return {
      success: true,
      dryRun: true,
      output: `Draft (MTProto not ready):\n"${content.slice(0, 300)}"`,
      data: { to, content },
    };
  }

  try {
    await _sendDirectMessage(chatId, content);
    log.info(`Reply sent to chatId=${chatId}`);
    return {
      success: true,
      dryRun: false,
      output: `✅ Message envoyé à ${to}`,
      data: { to, content },
    };
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
  const existing = db
    .prepare(
      `
    SELECT id FROM tasks
    WHERE title = ? AND status IN ('open', 'in_progress')
    LIMIT 1
  `,
    )
    .get(title) as { id: string } | undefined;

  if (existing) {
    log.debug(
      `Task dedup — open task ${existing.id} already exists with title "${title.slice(0, 60)}"`,
    );
    return {
      success: true,
      dryRun: false,
      output: `Task already exists (id: ${existing.id}): ${title}`,
      data: { id: existing.id, deduplicated: true },
    };
  }

  const id = ulid();
  db.prepare(
    `
    INSERT INTO tasks (id, title, description, category, source_ref, assigned_team, is_my_task, status, detected_at)
    VALUES (?, ?, ?, 'task', 'worker', ?, 0, 'open', ?)
  `,
  ).run(id, title, input.description ?? null, input.assigned_team ?? null, Date.now());

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

  db.prepare(
    `
    INSERT INTO chain_events (id, event_key, payload, emitted_at, consumed)
    VALUES (?, 'reminder', ?, ?, 0)
  `,
  ).run(
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
  const rawName = String(input.name ?? '')
    .replace(/[^a-z0-9_]/gi, '_')
    .toLowerCase();
  const name = `agent:${rawName}`;
  const schedule = String(input.schedule ?? '');
  const prompt = String(input.prompt ?? '');
  const desc = String(input.description ?? prompt.slice(0, 80));

  if (!name || !schedule || !prompt) {
    return {
      success: false,
      output: 'create_cron_job: name, schedule, and prompt are required',
      dryRun: false,
    };
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
  if (config.readOnly) {
    return {
      success: true,
      dryRun: true,
      output: '[read-only mode] Would add knowledge source',
      data: input,
    };
  }
  const { getDataDir } = await import('../config/index.js');
  const { readFileSync, writeFileSync } = await import('fs');
  const { default: path } = await import('path');

  const cfgPath = path.join(getDataDir(), '.config.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  const knowledge = (raw.knowledge as Record<string, unknown>) ?? {};
  const sources = (knowledge.sources as unknown[]) ?? [];

  let newSource: Record<string, unknown>;
  let label: string;

  if (input.type === 'github' || (input.owner && input.repo)) {
    const owner = String(input.owner ?? '');
    const repo = String(input.repo ?? '');
    const paths = (input.paths as string[]) ?? ['README.md'];
    newSource = { type: 'github', owner, repo, paths, refreshHours: 168 };
    label = `github:${owner}/${repo}`;
  } else if (input.url) {
    const url = String(input.url);
    const name = String(input.name ?? url.split('/').pop() ?? 'source');
    newSource = { type: 'url', name, url, refreshHours: 168 };
    label = url;
  } else {
    return {
      success: false,
      output: 'add_knowledge_source: url or owner+repo required',
      dryRun: false,
    };
  }

  // Deduplicate
  const alreadyExists = sources.some((s: unknown) => {
    const src = s as Record<string, unknown>;
    return (
      (src.type === 'url' && src.url === (newSource.url ?? '')) ||
      (src.type === 'github' && src.owner === newSource.owner && src.repo === newSource.repo)
    );
  });

  if (!alreadyExists) {
    sources.push(newSource);
    knowledge.sources = sources;
    raw.knowledge = knowledge;
    writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8');
  }

  // Index immediately
  try {
    const { fetchUrl } = await import('../knowledge/connectors/url.js');
    const { fetchGitHub } = await import('../knowledge/connectors/github.js');
    const { indexDocument } = await import('../knowledge/indexer.js');

    let doc = null;
    if (newSource.type === 'url') {
      doc = await fetchUrl({
        url: String(newSource.url),
        name: String(newSource.name),
        refreshDays: 7,
      });
    } else {
      doc = await fetchGitHub({
        owner: String(newSource.owner),
        repo: String(newSource.repo),
        paths: newSource.paths as string[],
        refreshDays: 7,
      });
    }

    if (doc) {
      await indexDocument(doc, config);
      return { success: true, dryRun: false, output: `📚 Knowledge source indexed: ${label}` };
    }
    return {
      success: true,
      dryRun: false,
      output: `⚠️ Source saved but returned no content: ${label}`,
    };
  } catch (e) {
    return {
      success: false,
      dryRun: false,
      output: `Source saved but indexing failed: ${(e as Error).message}`,
    };
  }
}

// ─── edit_config ──────────────────────────────────────────────────────────────
// Modifies .config.json at a given dot-path. Restricted to safe paths only.
// High-risk paths (secrets, tokens, llm) are blocked — they require manual edit.

const SAFE_CONFIG_PATHS = new Set([
  'owner.name',
  'owner.teams',
  'owner.roles',
  'triage.enabled',
  'triage.mentionOnly',
  'triage.ignoreOwnTeam',
  'triage.myHandles',
  'triage.watchedTeams',
  'triage.whitelistKeywords',
  'heartbeat.enabled',
  'heartbeat.intervalMinutes',
  'heartbeat.prompt',
  'memory.defaultTtlDays',
  'memory.archiveTtlDays',
  'memory.autoArchiveThreshold',
  'knowledge.sources',
  'knowledge.refreshHours',
  'channels.telegram.listener.monitoredChats',
  'channels.telegram.listener.ignoredChats',
  'channels.telegram.listener.contextWindow',
  'channels.slack.monitoredChannels',
  'channels.slack.monitorDMs',
  'channels.slack.pollIntervalSeconds',
  'channels.slack.enabled',
  'readOnly',
  'logLevel',
]);

// Prefixes that are unconditionally blocked (even if path starts with one of these)
const BLOCKED_PREFIXES = ['secrets', 'llm.providers', 'approval', 'wallet'];

async function executeEditConfig(
  input: Record<string, unknown>,
  _config: Config,
): Promise<WorkerResult> {
  if (_config.readOnly) {
    return {
      success: true,
      dryRun: true,
      output: '[read-only mode] Would edit config',
      data: input,
    };
  }
  const configPath = String(input.path ?? '');
  const value = input.value;
  const reason = String(input.reason ?? '');

  if (!configPath) {
    return { success: false, output: 'edit_config: path is required', dryRun: false };
  }

  // Security: block dangerous paths
  if (BLOCKED_PREFIXES.some((p) => configPath === p || configPath.startsWith(p + '.'))) {
    return {
      success: false,
      dryRun: false,
      output: `edit_config: path "${configPath}" is restricted. Edit manually in ~/.argos/.config.json.`,
    };
  }

  // Only allow explicitly safe paths (or sub-paths of safe paths)
  const isSafe = [...SAFE_CONFIG_PATHS].some(
    (safe) =>
      configPath === safe || configPath.startsWith(safe + '.') || safe.startsWith(configPath + '.'),
  );
  if (!isSafe) {
    return {
      success: false,
      dryRun: false,
      output: `edit_config: path "${configPath}" is not in the safe-paths list. Propose the change via the web app or edit manually.`,
    };
  }

  try {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { default: path } = await import('node:path');
    const { getDataDir } = await import('../config/index.js');

    const cfgPath = path.join(getDataDir(), '.config.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;

    // Set nested value at dot-path
    setNestedPath(raw, configPath, value);
    writeFileSync(cfgPath, JSON.stringify(raw, null, 2), { mode: 0o600 });

    // Regenerate self-doc so it reflects the new config
    try {
      const { loadConfig } = await import('../config/index.js');
      const { writeSelfDoc } = await import('../core/self-doc.js');
      writeSelfDoc(loadConfig());
    } catch {
      /* non-blocking */
    }

    return {
      success: true,
      dryRun: false,
      output: `✅ Config updated: \`${configPath}\` = ${JSON.stringify(value)}${reason ? `\nReason: ${reason}` : ''}`,
    };
  } catch (e) {
    return { success: false, dryRun: false, output: `edit_config failed: ${(e as Error).message}` };
  }
}

function setNestedPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const keys = dotPath.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

// ─── linear_create_issue ──────────────────────────────────────────────────────

const LINEAR_API = 'https://api.linear.app/graphql';

async function linearGql(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Linear API HTTP ${res.status}`);
  const data = (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string }>;
  };
  if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join(', '));
  return data.data ?? {};
}

async function executeLinearCreateIssue(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const apiKey = config.linear?.apiKey ?? process.env.LINEAR_API_KEY ?? '';
  if (!apiKey)
    return {
      success: false,
      dryRun: false,
      output: 'linear_create_issue: LINEAR_API_KEY not configured',
    };

  const title = String(input.title ?? '');
  const teamId = String(input.teamId ?? '');
  const description = input.description ? String(input.description) : undefined;
  const priority = typeof input.priority === 'number' ? input.priority : undefined; // 0-4

  if (!title || !teamId)
    return {
      success: false,
      dryRun: false,
      output: 'linear_create_issue: title and teamId required',
    };

  if (config.readOnly)
    return {
      success: true,
      dryRun: true,
      output: `[dry-run] Would create Linear issue: "${title}" in team ${teamId}`,
    };

  const data = await linearGql(
    apiKey,
    `
    mutation CreateIssue($title: String!, $teamId: String!, $description: String, $priority: Int) {
      issueCreate(input: { title: $title, teamId: $teamId, description: $description, priority: $priority }) {
        success
        issue { id identifier url title }
      }
    }
  `,
    { title, teamId, description, priority },
  );

  const issue = (data.issueCreate as { issue?: { identifier: string; url: string } })?.issue;
  if (!issue)
    return { success: false, dryRun: false, output: 'linear_create_issue: no issue returned' };

  audit('linear_issue_created', issue.identifier, 'linear', { title, teamId, url: issue.url });
  return {
    success: true,
    dryRun: false,
    output: `✅ Linear issue created: [${issue.identifier}] ${title}\n${issue.url}`,
  };
}

async function executeLinearUpdateIssue(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const apiKey = config.linear?.apiKey ?? process.env.LINEAR_API_KEY ?? '';
  if (!apiKey)
    return {
      success: false,
      dryRun: false,
      output: 'linear_update_issue: LINEAR_API_KEY not configured',
    };

  const issueId = String(input.issueId ?? input.id ?? '');
  if (!issueId)
    return { success: false, dryRun: false, output: 'linear_update_issue: issueId required' };

  if (config.readOnly)
    return {
      success: true,
      dryRun: true,
      output: `[dry-run] Would update Linear issue ${issueId}`,
    };

  // If close/complete requested, find the team's completed state first
  const wantClose = input.close === true || input.status === 'done' || input.status === 'completed';

  let stateId: string | undefined = input.stateId ? String(input.stateId) : undefined;

  if (wantClose && !stateId) {
    // Fetch the issue's team to find completed state
    const issueData = await linearGql(
      apiKey,
      `
      query IssueTeam($id: String!) {
        issue(id: $id) { team { states { nodes { id type name } } } }
      }
    `,
      { id: issueId },
    );
    const states = ((issueData.issue as Record<string, unknown>)?.team as Record<string, unknown>)
      ?.states as { nodes: Array<{ id: string; type: string }> } | undefined;
    stateId = states?.nodes.find((s) => s.type === 'completed')?.id;
  }

  const updateInput: Record<string, unknown> = {};
  if (stateId) updateInput.stateId = stateId;
  if (input.title) updateInput.title = String(input.title);
  if (input.description) updateInput.description = String(input.description);
  if (typeof input.priority === 'number') updateInput.priority = input.priority;

  const data = await linearGql(
    apiKey,
    `
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { identifier url title }
      }
    }
  `,
    { id: issueId, input: updateInput },
  );

  const issue = (data.issueUpdate as { issue?: { identifier: string; url: string; title: string } })
    ?.issue;
  const label = wantClose ? 'closed' : 'updated';
  audit(`linear_issue_${label}`, issueId, 'linear', { ...updateInput });
  return {
    success: true,
    dryRun: false,
    output: `✅ Linear issue ${label}: [${issue?.identifier ?? issueId}] ${issue?.title ?? ''}\n${issue?.url ?? ''}`,
  };
}

async function executeCreateAgent(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  if (config.readOnly) {
    return {
      success: true,
      dryRun: true,
      output: '[read-only mode] Would create agent',
      data: input,
    };
  }
  const name = String(input.name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
  if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
    return {
      success: false,
      dryRun: false,
      output: 'create_agent: invalid name — must be snake_case',
    };
  }
  if (!input.systemPrompt || !input.tools) {
    return {
      success: false,
      dryRun: false,
      output: 'create_agent: systemPrompt and tools are required',
    };
  }

  const { getDataDir } = await import('../config/index.js');
  const { readFileSync, writeFileSync } = await import('fs');
  const { default: path } = await import('path');

  const cfgPath = path.join(getDataDir(), '.config.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  const agents = (raw.agents as Array<Record<string, unknown>>) ?? [];

  // Dedup — update existing agent with same name rather than duplicating
  const existing = agents.findIndex((a) => a.name === name);
  const agentDef: Record<string, unknown> = {
    name,
    description: String(input.description ?? ''),
    systemPrompt: String(input.systemPrompt),
    tools: (input.tools as string[]) ?? ['web_search', 'fetch_url', 'semantic_search'],
    linkedChannels: (input.linkedChannels as string[]) ?? [],
    provider: input.provider ? String(input.provider) : undefined,
    model: input.model ? String(input.model) : undefined,
    isolatedWorkspace: input.isolatedWorkspace !== false,
    maxIterations: Number(input.maxIterations ?? 8),
    temperature: Number(input.temperature ?? 0.3),
    maxTokens: Number(input.maxTokens ?? 2048),
    enabled: true,
  };

  if (existing >= 0) {
    agents[existing] = agentDef;
  } else {
    agents.push(agentDef);
  }

  raw.agents = agents;
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8');

  // Hot-reload — register the new agent immediately without restart
  const { loadUserAgents } = await import('../agents/index.js');
  await loadUserAgents({ ...config, agents: agents as Config['agents'] });

  const verb = existing >= 0 ? 'updated' : 'created';
  log.info(`Agent "${name}" ${verb} via worker`);
  return {
    success: true,
    dryRun: false,
    output: `✅ Agent "${name}" ${verb} and live — no restart needed.\n${String(input.reason ?? '')}`,
    data: { name },
  };
}
