/**
 * Argos core pipeline.
 *
 * Extracted from src/index.ts to keep the entry point lean.
 *
 * Two main stages:
 *
 *   ingestMessage — called per inbound RawMessage:
 *     1. Persist metadata (no raw content stored)
 *     2. Injection sanitize (fail-closed)
 *     3. Anonymize (regex + lookup table)
 *     4. Feed into context window (batching)
 *     5. Fire triage plugin (non-blocking)
 *
 *   processWindow — called when the context window closes:
 *     1. Classify
 *     2. Store memory
 *     3. Save task if detected
 *     4. Plan (LLM tool use)
 *     5. Auto-execute owner workspace actions
 *     6. Send remaining actions to approval gateway
 *
 * sendToApprovalChat is late-bound via setSendToApprovalChat() once
 * channels are initialized at boot, so both functions can reference it
 * without requiring it as an argument.
 */

import { createLogger } from '../logger.js';
import { getDb, audit } from '../db/index.js';
import { fastScreen, deepSanitize } from '../privacy/sanitizer.js';
import { classify } from '../ingestion/classifier.js';
import { store as storeMemory, saveTask } from '../memory/store.js';
import { plan } from '../planner/index.js';
import { requestApproval } from '../gateway/approval.js';
import { emitEvent } from '../scheduler/index.js';
import { broadcastEvent } from '../webapp/server.js';
import { llmForRole } from './privacy.js';
import { pluginRegistry } from '../plugins/registry.js';
import type { Anonymizer } from '../privacy/anonymizer.js';
import type { ContextWindowManager } from '../ingestion/context-window.js';
import type { RawMessage, ContextWindow, ClassificationResult } from '../types.js';
import type { LLMConfig } from '../llm/index.js';
import type { Config } from '../config/schema.js';
import type { TelegramChannel } from '../ingestion/channels/telegram.js';

const log = createLogger('pipeline');

// Late-bound — set once channels are ready (avoids circular deps + boot ordering issues)
let _sendToApprovalChat: (text: string) => Promise<void> = async () => {};

// Track in-flight triage promises so processWindow can await them before deciding to skip planner
const _triageInFlight = new Map<string, Promise<void>>();

export function setSendToApprovalChat(fn: (text: string) => Promise<void>): void {
  _sendToApprovalChat = fn;
}

// ─── Message ingestion ────────────────────────────────────────────────────────

export async function ingestMessage(
  msg: RawMessage,
  llmConfig: LLMConfig,
  privacyConfig: LLMConfig | null,
  config: Config,
  anonymizer: Anonymizer,
  windowManager: ContextWindowManager,
): Promise<void> {
  log.debug(`Ingesting message from ${msg.partnerName ?? msg.chatId}`, {
    channel: msg.channel,
    length:  msg.content.length,
  });

  // Persist raw reference (no content stored — just metadata + hash)
  const db     = getDb();
  const crypto = await import('crypto');
  const contentHash = crypto.createHash('sha256').update(msg.content).digest('hex');

  db.prepare(`
    INSERT OR IGNORE INTO messages
    (id, source, channel, chat_id, partner_name, sender_id, sender_name, content_hash, received_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    msg.id, msg.source, msg.channel, msg.chatId, msg.partnerName ?? null,
    msg.senderId ?? null, msg.senderName ?? null,
    contentHash, msg.receivedAt,
  );

  // ── Phase 1: fast regex injection screen on RAW content (no LLM, no privacy risk) ──
  const fast = fastScreen(msg.content);
  if (!fast.safe) {
    log.warn(`Injection blocked from ${msg.chatId}`, { patterns: fast.patterns });
    audit('injection_detected', msg.chatId, 'message', { patterns: fast.patterns, preview: msg.content.slice(0, 200) });
    db.prepare(`UPDATE messages SET status = 'blocked', processed_at = ? WHERE id = ?`).run(Date.now(), msg.id);
    return;
  }

  // ── Phase 2: anonymize (regex pass) ──────────────────────────────────────────
  let anon = anonymizer.anonymize(msg.content);

  // LLM second pass — catches what regex missed (names, companies, project names…)
  // ONLY runs if a local privacy provider is configured for the llmAnon role.
  // Never runs with the primary (cloud) LLM — sending raw content to a cloud model
  // to "anonymize" it defeats the entire privacy model.
  const llmAnonConfig = llmForRole('llmAnon', llmConfig, privacyConfig, config);
  if (llmAnonConfig !== llmConfig) {
    try {
      const { enhanceWithLlm } = await import('../privacy/llm-anonymizer.js');
      const enhanced = await enhanceWithLlm(anon, llmAnonConfig, { skipIfClean: false });
      anon = enhanced;
      if (enhanced.llmApplied > 0) {
        log.debug(`LLM anonymizer applied ${enhanced.llmApplied} additional redactions`);
      }
    } catch (e) {
      log.warn('LLM anonymizer failed, falling back to regex-only result:', e);
    }
  }

  // ── Phase 3: LLM deep injection scan on ANONYMIZED text ──────────────────────
  // Now safe to use any LLM provider — PII has already been stripped.
  // Only runs for longer messages where regex alone isn't sufficient.
  if (anon.text.length > 500) {
    const sanitizerConfig = llmForRole('sanitize', llmConfig, privacyConfig, config);
    const deep = await deepSanitize(anon.text, msg.channel, sanitizerConfig);
    if (!deep.safe) {
      const scanError = deep.injectionPatterns.includes('llm_scan_failed');
      if (scanError) {
        log.warn(`Sanitizer LLM error — message blocked from ${msg.chatId} (fail-closed)`);
      } else {
        log.warn(`LLM injection detected from ${msg.chatId}`, { patterns: deep.injectionPatterns });
      }
      db.prepare(`UPDATE messages SET status = 'blocked', processed_at = ? WHERE id = ?`).run(Date.now(), msg.id);
      return;
    }
  }

  // Populate anonText so plugins and triage have access to the anonymized version
  msg.anonText = anon.text;

  // Feed into context window (batching)
  // Pass raw content only when storeRaw=true — kept in-memory until window closes,
  // then persisted in memories.raw_content (accessible to privacy LLM only).
  const rawForWindow = config.privacy.storeRaw ? msg.content : undefined;
  windowManager.add(msg, anon.text, anon.lookup, rawForWindow);
  // Persist lookup so it survives restarts — used to de-anonymize approved replies
  db.prepare(`UPDATE messages SET status = 'windowed', anon_lookup = ? WHERE id = ?`)
    .run(JSON.stringify(anon.lookup), msg.id);

  // Plugin hooks — non-blocking, after sanitize+anonymize
  // msg.content = raw (injection-safe), msg.anonText = anonymized
  pluginRegistry.emitMessage(msg, {
    config,
    llmConfig,
    privacyConfig,
    notify: _sendToApprovalChat,
  });

  // Triage — non-blocking, fires only when pre-screen matches.
  // Store the promise so processWindow can await it before checking triaged status,
  // preventing the race condition where the window closes before triage completes.
  if (config.triage?.enabled) {
    const { triage: runTriage } = await import('./triage.js');
    const { triageSink }        = await import('./triage-sink.js');
    const triagePromise = runTriage(msg, config, llmConfig, privacyConfig).then(async triageResult => {
      if (!triageResult) return;
      // Flag message so the window processor skips planner (triage already handled it)
      db.prepare(`UPDATE messages SET status = 'triaged' WHERE id = ?`).run(msg.id);
      await triageSink(triageResult, config, _sendToApprovalChat, llmConfig);
    }).catch(e => log.warn('Triage error (non-blocking):', e));
    _triageInFlight.set(msg.id, triagePromise as Promise<void>);
  }

  // Completion detection — non-blocking, checks if new message resolves open tasks
  checkTaskCompletion(msg, anon.text, llmConfig, privacyConfig, config)
    .catch(e => log.warn('Completion detection error (non-blocking):', e));
}

// ─── Task completion detection ────────────────────────────────────────────────
// When a new message arrives in a monitored chat, check if it resolves any open tasks.
// Matches by chatId + channel to avoid cross-channel false positives.

async function checkTaskCompletion(
  msg: RawMessage,
  anonText: string,
  llmConfig: LLMConfig,
  privacyConfig: LLMConfig | null,
  config: Config,
): Promise<void> {
  const db = getDb();
  const openTasks = db.prepare(`
    SELECT id, title, description FROM tasks
    WHERE chat_id = ?
      AND (channel = ? OR channel IS NULL)
      AND (status = 'open' OR status = 'in_progress')
    LIMIT 10
  `).all(msg.chatId, msg.channel ?? msg.source) as Array<{ id: string; title: string; description: string | null }>;

  if (openTasks.length === 0) return;

  const { llmCall, extractJson, llmConfigFromConfig } = await import('../llm/index.js');

  // Use privacy LLM if configured, otherwise primary — keep raw content local
  const activeLlm = privacyConfig ?? llmConfigFromConfig(config);

  const taskList = openTasks.map(t => `- [${t.id}] ${t.title}`).join('\n');

  const response = await llmCall(activeLlm, [
    {
      role: 'system',
      content: `You are a task completion detector for a fintech operations team.
Given a new message and a list of open tasks for this conversation, determine if any tasks are now resolved.
A task is resolved if: the message confirms it was done, the request was cancelled, or the issue is clearly resolved.
Respond ONLY with valid JSON (no markdown): {"completed": ["task_id_1"], "reasoning": "brief reason"}
If no tasks are resolved, return {"completed": [], "reasoning": ""}`,
    },
    {
      role: 'user',
      content: `Open tasks:\n${taskList}\n\nNew message from ${msg.senderName ?? msg.partnerName}:\n${anonText.slice(0, 800)}`,
    },
  ]);

  const result = extractJson<{ completed: string[]; reasoning: string }>(response.content);
  if (!result.completed?.length) return;

  const now = Date.now();
  for (const taskId of result.completed) {
    if (!openTasks.some(t => t.id === taskId)) continue; // safety check
    db.prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`)
      .run(now, taskId);
    // Cancel any pending draft reply proposals linked to this task
    db.prepare(`UPDATE proposals SET status = 'cancelled' WHERE task_id = ? AND status = 'proposed'`)
      .run(taskId);
    log.info(`Task auto-completed: ${taskId} — ${result.reasoning?.slice(0, 80)}`);
    audit('task_auto_completed', taskId, 'task', {
      by:        msg.senderName ?? msg.partnerName,
      channel:   msg.channel,
      reasoning: result.reasoning?.slice(0, 200),
    });
  }
}

// ─── Context window processor ─────────────────────────────────────────────────

export async function processWindow(
  llmConfig: LLMConfig,
  privacyConfig: LLMConfig | null,
  config: Config,
  anonymizer: Anonymizer,
  window: ContextWindow,
): Promise<void> {
  if (window.messages.length === 0) {
    log.warn(`Window ${window.id} has no messages — skipping`);
    return;
  }

  log.info(`Processing window ${window.id}`, {
    messages: window.messages.length,
    partner:  window.partnerName,
  });

  // If all messages in this window were handled by triage, skip the planner
  // to avoid duplicate proposals and noisy notifications.
  const windowMsgIds: string[] = window.messages.map(m => m.originalId).filter(Boolean);
  if (windowMsgIds.length > 0 && config.triage?.enabled) {
    // Await any in-flight triage promises so we don't check triaged status
    // before triage has finished writing — fixes the race condition.
    await Promise.allSettled(windowMsgIds.map(id => _triageInFlight.get(id) ?? Promise.resolve()));
    windowMsgIds.forEach(id => _triageInFlight.delete(id));

    const placeholders = windowMsgIds.map(() => '?').join(',');
    const triaged = getDb().prepare(
      `SELECT COUNT(*) as n FROM messages WHERE id IN (${placeholders}) AND status = 'triaged'`,
    ).get(...windowMsgIds) as { n: number };
    if (triaged.n === windowMsgIds.length) {
      log.debug(`Window ${window.id} fully triaged — skipping planner`);
      return;
    }
  }

  // Classify — routing via privacy layer
  const classifierConfig = llmForRole('classify', llmConfig, privacyConfig, config);
  const result: ClassificationResult = await classify(window, classifierConfig, config);

  // Store memory
  storeMemory(result.summary, result, window, {
    defaultTtlDays:      config.memory.defaultTtlDays,
    archiveTtlDays:      config.memory.archiveTtlDays,
    autoArchiveThreshold: config.memory.autoArchiveThreshold,
  });

  // Vectorize full conversation — fire-and-forget, enables semantic retrieval over 30d rolling window
  const { vectorizeConversationAsync } = await import('../memory/store.js');
  vectorizeConversationAsync(window, result).catch(e => log.warn('Conversation vectorization failed:', e));

  // Save task if detected
  if (result.category === 'task' || result.category === 'tx_request' || result.category === 'client_request') {
    const taskId = saveTask(result.summary.slice(0, 120), result, window);
    broadcastEvent('task_created', { id: taskId, summary: result.summary, partner: window.partnerName });
  }

  // Completion events for chained triggers
  for (const taskId of result.completedTaskIds ?? []) {
    emitEvent(`task_completed:${taskId}`, { taskId, partner: window.partnerName });
  }

  // Skip planning if nothing actionable
  if (!result.requiresAction && (result.importance ?? 0) < 4) {
    log.debug(`Window ${window.id} — no action required (importance ${result.importance})`);
    return;
  }

  const proposal = await plan(window, result, config);
  if (!proposal || proposal.actions.length === 0) return;

  // Auto-execute owner workspace actions (Notion, tasks, reminders)
  const autoActions     = proposal.actions.filter(a => !a.requiresApproval);
  const approvalActions = proposal.actions.filter(a =>  a.requiresApproval);

  if (autoActions.length > 0) {
    const { executeProposal } = await import('../workers/index.js');
    log.info(`Auto-executing ${autoActions.length} action(s) (owner workspace)`);
    await executeProposal({ ...proposal, actions: autoActions }, autoActions, config, _sendToApprovalChat)
      .catch(e => log.error('Auto-execution failed', e));
    audit('auto_executed', proposal.id, 'proposal', {
      actions: autoActions.map(a => a.description),
    });
  }

  if (approvalActions.length > 0) {
    proposal.actions = approvalActions;
    await requestApproval(proposal);
    emitEvent(`proposal_created:${proposal.id}`, { proposalId: proposal.id });
    broadcastEvent('proposal_created', { id: proposal.id, summary: proposal.contextSummary });
  }
}

// ─── Daily briefing ───────────────────────────────────────────────────────────

export async function sendDailyBriefing(
  config: Config,
  telegram: TelegramChannel,
): Promise<void> {
  const db = getDb();

  const openTasks = db.prepare(
    `SELECT COUNT(*) as c FROM tasks WHERE status = 'open'`,
  ).get() as { c: number };
  const pendingApprovals = db.prepare(
    `SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'`,
  ).get() as { c: number };
  const myTasks = db.prepare(
    `SELECT * FROM tasks WHERE status = 'open' AND is_my_task = 1 ORDER BY detected_at DESC LIMIT 5`,
  ).all() as Array<{ title: string; partner_name: string | null }>;

  const lines = [
    `☀️ *Argos Morning Briefing*`,
    ``,
    `📋 Open tasks: **${openTasks.c}** (${pendingApprovals.c} pending approval)`,
    ``,
  ];

  if (myTasks.length > 0) {
    lines.push(`👤 *Your tasks:*`);
    for (const t of myTasks) {
      lines.push(`• ${t.title}${t.partner_name ? ` [${t.partner_name}]` : ''}`);
    }
  } else {
    lines.push(`✅ No tasks assigned to you`);
  }

  lines.push(``, `_Have a productive day, ${config.owner.name}._`);

  await telegram.sendToApprovalChat(lines.join('\n'));
}
