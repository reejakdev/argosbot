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

export function getSendToApprovalChat(): (text: string) => Promise<void> {
  return _sendToApprovalChat;
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
    length: msg.content.length,
  });

  // Persist raw reference (no content stored — just metadata + hash)
  const db = getDb();
  const crypto = await import('crypto');
  const contentHash = crypto.createHash('sha256').update(msg.content).digest('hex');

  db.prepare(
    `
    INSERT OR IGNORE INTO messages
    (id, source, channel, chat_id, partner_name, sender_id, sender_name, content_hash, received_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `,
  ).run(
    msg.id,
    msg.source,
    msg.channel,
    msg.chatId,
    msg.partnerName ?? null,
    msg.senderId ?? null,
    msg.senderName ?? null,
    contentHash,
    msg.receivedAt,
  );

  // ── Phase 1: fast regex injection screen on RAW content (no LLM, no privacy risk) ──
  const fast = fastScreen(msg.content);
  if (!fast.safe) {
    log.warn(`Injection blocked from ${msg.chatId}`, { patterns: fast.patterns });
    audit('injection_detected', msg.chatId, 'message', {
      patterns: fast.patterns,
      preview: msg.content.slice(0, 200),
    });
    db.prepare(`UPDATE messages SET status = 'blocked', processed_at = ? WHERE id = ?`).run(
      Date.now(),
      msg.id,
    );
    return;
  }

  // ── Phase 2: anonymize (regex pass) ──────────────────────────────────────────
  let anon = anonymizer.anonymize(msg.content);

  // LLM second pass — catches what regex missed (names, companies, project names…)
  // ONLY runs if a local privacy provider is configured for the llmAnon role.
  // Skipped entirely when anonymizer.mode === 'none'.
  const llmAnonConfig = llmForRole('llmAnon', llmConfig, privacyConfig, config);
  if (config.anonymizer.mode !== 'none' && llmAnonConfig !== llmConfig) {
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
  // Optimization: only run the LLM scan when the regex pre-screen flagged something
  // suspicious. Clean messages skip the LLM call entirely. fastScreen already ran on
  // raw content above (and blocks on hit), so by re-checking the anonymized text we
  // catch any pattern that survived anonymization without paying for clean messages.
  const deepCheck = fastScreen(anon.text);
  if (anon.text.length > 500 && !deepCheck.safe) {
    const sanitizerConfig = llmForRole('sanitize', llmConfig, privacyConfig, config);
    const deep = await deepSanitize(anon.text, msg.channel, sanitizerConfig);
    if (!deep.safe) {
      const scanError = deep.injectionPatterns.includes('llm_scan_failed');
      if (scanError) {
        log.warn(`Sanitizer LLM error — message blocked from ${msg.chatId} (fail-closed)`);
      } else {
        log.warn(`LLM injection detected from ${msg.chatId}`, { patterns: deep.injectionPatterns });
      }
      db.prepare(`UPDATE messages SET status = 'blocked', processed_at = ? WHERE id = ?`).run(
        Date.now(),
        msg.id,
      );
      return;
    }
  }

  // Populate anonText so plugins and triage have access to the anonymized version
  msg.anonText = anon.text;

  // ── Agent routing — channel-linked agents bypass the planner entirely ─────────
  // If this chat is linked to a user-defined agent, route directly to it and skip
  // the context window + planner pipeline.
  {
    const { getAgentForChannel, runAgent } = await import('../agents/index.js');
    const agentName = getAgentForChannel(msg.channel, msg.chatId);
    if (agentName) {
      const agentDef = (config.agents ?? []).find((a) => a.name === agentName);
      if (agentDef?.enabled !== false) {
        log.info(`Routing message to agent "${agentName}" (channel: ${msg.channel}:${msg.chatId})`);
        db.prepare(`UPDATE messages SET status = 'processed', processed_at = ? WHERE id = ?`).run(
          Date.now(),
          msg.id,
        );
        runAgent(agentDef as import('../agents/index.js').AgentDefinition, anon.text, config)
          .then((result) => _sendToApprovalChat(`🤖 *${agentName}*\n\n${result.output}`))
          .catch((e) => log.warn(`Agent "${agentName}" error:`, e));
        return; // skip normal window/planner
      }
    }
  }

  // Feed into context window (batching)
  // Pass raw content only when storeRaw=true — kept in-memory until window closes,
  // then persisted in memories.raw_content (accessible to privacy LLM only).
  const rawForWindow = config.privacy.storeRaw ? msg.content : undefined;
  windowManager.add(msg, anon.text, anon.lookup, rawForWindow);
  // Persist lookup + anonymized text — lookup for de-anonymization at execution time,
  // anon_content for conversation traceability (raw content is never stored).
  let encryptedContent: string | null = null;
  if (config.privacy.encryptMessages) {
    try {
      const { loadEncryptionKey, encryptMessage } = await import('../privacy/encryption.js');
      encryptedContent = encryptMessage(msg.content, loadEncryptionKey());
    } catch (e) {
      log.warn('Message encryption failed — encrypted_content not stored:', e);
    }
  }

  db.prepare(
    `UPDATE messages SET status = 'windowed', anon_lookup = ?, anon_content = ?, encrypted_content = ? WHERE id = ?`,
  ).run(JSON.stringify(anon.lookup), anon.text, encryptedContent, msg.id);

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
    const { triageSink } = await import('./triage-sink.js');
    const triagePromise = runTriage(msg, config, llmConfig, privacyConfig)
      .then(async (triageResult) => {
        if (!triageResult) return;
        // Flag message so the window processor skips planner (triage already handled it)
        db.prepare(`UPDATE messages SET status = 'triaged' WHERE id = ?`).run(msg.id);
        await triageSink(triageResult, config, _sendToApprovalChat, llmConfig);
      })
      .catch((e) => log.warn('Triage error (non-blocking):', e));
    _triageInFlight.set(msg.id, triagePromise as Promise<void>);
  }

  // Completion detection — non-blocking, checks if new message resolves open tasks
  checkTaskCompletion(msg, anon.text, llmConfig, privacyConfig, config).catch((e) =>
    log.warn('Completion detection error (non-blocking):', e),
  );

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
  const openTasks = db
    .prepare(
      `
    SELECT id, title, description FROM tasks
    WHERE chat_id = ?
      AND (channel = ? OR channel IS NULL)
      AND (status = 'open' OR status = 'in_progress')
    LIMIT 10
  `,
    )
    .all(msg.chatId, msg.channel ?? msg.source) as Array<{
    id: string;
    title: string;
    description: string | null;
  }>;

  if (openTasks.length === 0) return;

  const { llmCall, extractJson, llmConfigFromConfig } = await import('../llm/index.js');

  // Use privacy LLM if configured, otherwise primary — keep raw content local
  const activeLlm = privacyConfig ?? llmConfigFromConfig(config);

  const taskList = openTasks.map((t) => `- [${t.id}] ${t.title}`).join('\n');

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
    if (!openTasks.some((t) => t.id === taskId)) continue; // safety check
    db.prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`).run(
      now,
      taskId,
    );
    // Cancel any pending draft reply proposals linked to this task
    db.prepare(
      `UPDATE proposals SET status = 'cancelled' WHERE task_id = ? AND status = 'proposed'`,
    ).run(taskId);
    log.info(`Task auto-completed: ${taskId} — ${result.reasoning?.slice(0, 80)}`);
    audit('task_auto_completed', taskId, 'task', {
      by: msg.senderName ?? msg.partnerName,
      channel: msg.channel,
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
    partner: window.partnerName,
  });

  // If all messages in this window were handled by triage, skip the planner
  // to avoid duplicate proposals and noisy notifications.
  const windowMsgIds: string[] = window.messages.map((m) => m.originalId).filter(Boolean);
  if (windowMsgIds.length > 0 && config.triage?.enabled) {
    // Await any in-flight triage promises so we don't check triaged status
    // before triage has finished writing — fixes the race condition.
    await Promise.allSettled(
      windowMsgIds.map((id) => _triageInFlight.get(id) ?? Promise.resolve()),
    );
    windowMsgIds.forEach((id) => _triageInFlight.delete(id));

    const placeholders = windowMsgIds.map(() => '?').join(',');
    const triaged = getDb()
      .prepare(
        `SELECT COUNT(*) as n FROM messages WHERE id IN (${placeholders}) AND status = 'triaged'`,
      )
      .get(...windowMsgIds) as { n: number };
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
    defaultTtlDays: config.memory.defaultTtlDays,
    archiveTtlDays: config.memory.archiveTtlDays,
    autoArchiveThreshold: config.memory.autoArchiveThreshold,
    storeRaw: config.privacy.storeRaw,
  });

  // Entity extraction — fire-and-forget, non-blocking, only for important messages
  const kgConfig = (
    config as unknown as { knowledgeGraph?: { enabled?: boolean; minImportance?: number } }
  ).knowledgeGraph;
  if (kgConfig?.enabled && (result.importance ?? 0) >= (kgConfig.minImportance ?? 5)) {
    const anonText = window.messages.map((m) => m.content).join('\n');
    const windowRef = window.id;
    const chan = window.channel;
    const cId = window.chatId;
    Promise.resolve()
      .then(async () => {
        const { extractEntities } = await import('../knowledge-graph/extractor.js');
        const { upsertEntity, addRelation } = await import('../knowledge-graph/store.js');
        const { entities, relations } = await extractEntities(anonText, llmConfig);
        const entityIds = new Map<string, string>();
        for (const ent of entities) {
          const id = upsertEntity(ent, windowRef, chan, cId);
          entityIds.set(ent.name, id);
        }
        for (const rel of relations) {
          const fromId = entityIds.get(rel.from);
          const toId = entityIds.get(rel.to);
          if (fromId && toId) addRelation(fromId, toId, rel.relation, rel.context, windowRef);
        }
      })
      .catch((e) => log.warn(`KG extraction failed: ${e}`));
  }

  // Vectorize full conversation — fire-and-forget, enables semantic retrieval over 30d rolling window
  const { vectorizeConversationAsync } = await import('../memory/store.js');
  vectorizeConversationAsync(window, result).catch((e) =>
    log.warn('Conversation vectorization failed:', e),
  );

  // Save task only when the owner is directly addressed.
  // Hard gate: if none of the owner's handles/name appear in the raw message text,
  // only create a task if isMyTask is explicitly true (LLM is very confident).
  // This prevents tasks from conversations between other people where the owner is just CC'd.
  const myHandles = config.triage?.myHandles ?? [];
  const ownerName = config.owner?.name ?? '';
  const rawText = window.messages
    .map((m) => m.content)
    .join(' ')
    .toLowerCase();
  const ownerMentioned =
    result.isMyTask ||
    myHandles.some((h) => rawText.includes(h.toLowerCase().replace(/^@/, ''))) ||
    (ownerName && rawText.includes(ownerName.toLowerCase()));

  const ownerInvolved =
    ownerMentioned ||
    (result.taskScope === 'my_task' && result.ownerConfidence >= 0.8) ||
    (result.category === 'client_request' && result.isMyTask && result.ownerConfidence >= 0.7);

  if (
    ownerInvolved &&
    (result.category === 'task' ||
      result.category === 'tx_request' ||
      result.category === 'client_request' ||
      result.requiresAction)
  ) {
    const taskId = saveTask(result.summary.slice(0, 120), result, window);
    broadcastEvent('task_created', {
      id: taskId,
      summary: result.summary,
      partner: window.partnerName,
    });
  }

  // Keyword suggestion — fire-and-forget, non-blocking
  suggestKeyword(result, config).catch(() => {});

  // Completion events for chained triggers
  for (const taskId of result.completedTaskIds ?? []) {
    emitEvent(`task_completed:${taskId}`, { taskId, partner: window.partnerName });
  }

  // Skip planning if nothing actionable
  if (!result.requiresAction && (result.importance ?? 0) < 4) {
    log.debug(`Window ${window.id} — no action required (importance ${result.importance})`);
    return;
  }

  // ── Triggered agents — run before planner, inject results into context ────────
  // Agents whose trigger conditions match this message run in parallel here.
  // Their output is appended to the window context so the planner can use it
  // without re-doing the same work.
  const triggerText = window.messages.map((m) => m.content).join('\n');
  {
    const { getTriggeredAgents, runAgent } = await import('../agents/index.js');
    const triggered = getTriggeredAgents(
      config,
      triggerText,
      window.messages[0]?.channel ?? '',
      result.category,
      result.importance,
    );

    if (triggered.length > 0) {
      log.info(
        `${triggered.length} agent trigger(s) matched for window ${window.id}: ${triggered.map((a) => a.name).join(', ')}`,
      );

      const agentResults = await Promise.allSettled(
        triggered.map((def) => runAgent(def, triggerText, config)),
      );

      const injections: string[] = [];
      for (let i = 0; i < triggered.length; i++) {
        const r = agentResults[i];
        if (r.status === 'fulfilled' && r.value.success) {
          injections.push(`## Agent: ${triggered[i].name}\n\n${r.value.output}`);
          log.debug(`Trigger agent "${triggered[i].name}" completed`);
        } else {
          const err = r.status === 'rejected' ? String(r.reason) : r.value.output;
          log.warn(`Trigger agent "${triggered[i].name}" failed: ${err}`);
        }
      }

      if (injections.length > 0) {
        // Attach agent results to the window so the planner prompt builder picks them up
        window.agentContext = injections.join('\n\n---\n\n');
      }
    }
  }

  const proposal = await plan(window, result, config);

  // Fallback: if planner produced no actions but the request needs attention,
  // notify the owner directly so the partner's request is never silently dropped.
  if (!proposal || proposal.actions.length === 0) {
    if (result.requiresAction && result.importance >= 3 && result.category !== 'ignore') {
      const partner = window.partnerName ?? window.chatId;
      const summary = result.summary?.slice(0, 200) ?? 'New message requiring attention';
      const preview = window.messages[0]?.content?.slice(0, 120) ?? '';
      await _sendToApprovalChat(
        `📬 *${partner}* — ${result.category} (imp: ${result.importance}/10, ${result.urgency})\n${summary}\n\n_"${preview}${preview.length >= 120 ? '…' : ''}"_\n\n⚠️ No action was proposed — check /tasks or reply manually.`,
      ).catch((e) => log.warn('Fallback notify failed:', e));
    }
    return;
  }

  // Auto-execute owner workspace actions (Notion, tasks, reminders) — DISABLED in readOnly mode
  // In autonomousMode, ALL actions are auto-executed (bypass approval entirely)
  const autonomous = (config as Record<string, unknown>).autonomousMode === true;
  const autoActions = autonomous
    ? proposal.actions
    : proposal.actions.filter((a) => !a.requiresApproval);
  const approvalActions = autonomous
    ? []
    : proposal.actions.filter((a) => a.requiresApproval);

  if (autoActions.length > 0 && !config.readOnly) {
    const { executeProposal } = await import('../workers/index.js');
    const { generateExecutionToken } = await import('../gateway/approval.js');
    const autoToken = generateExecutionToken(proposal.id);
    log.info(`Auto-executing ${autoActions.length} action(s) (owner workspace)`);
    await executeProposal(
      { ...proposal, actions: autoActions },
      autoActions,
      config,
      _sendToApprovalChat,
      autoToken,
    ).catch((e) => log.error('Auto-execution failed', e));
    audit('auto_executed', proposal.id, 'proposal', {
      actions: autoActions.map((a) => a.description),
    });

    // Notify owner immediately for task/reminder creations
    const taskActions = autoActions.filter((a) =>
      ['create_task', 'set_reminder'].includes((a.payload as { tool?: string })?.tool ?? ''),
    );
    for (const a of taskActions) {
      const input = (a.payload as { input?: Record<string, unknown> })?.input ?? {};
      const title = String(input.title ?? input.message ?? a.description).slice(0, 120);
      const partner = window.partnerName ?? window.chatId;
      const icon = (a.payload as { tool?: string })?.tool === 'set_reminder' ? '⏰' : '📋';
      await _sendToApprovalChat(`${icon} *${title}*\n_${partner}_`).catch(() => {});
    }
  } else if (autoActions.length > 0 && config.readOnly) {
    // In readOnly mode: silently skip — tasks are already persisted upstream
    // by saveTask()/sinkTask(), so the owner sees them via /tasks. No spam notif.
    log.info(`readOnly: suppressed ${autoActions.length} auto-action(s) — tasks already persisted upstream`);
  }

  if (approvalActions.length > 0) {
    // In readOnly mode: drop draft_reply actions silently (no spam notifications),
    // and skip the approval flow for everything else (since nothing can be executed).
    // Tasks are still persisted upstream — that's the only durable artifact.
    if (config.readOnly) {
      const draftCount = approvalActions.filter(
        (a) => (a.payload as { tool?: string })?.tool === 'draft_reply',
      ).length;
      if (draftCount > 0) {
        log.debug(`readOnly: suppressed ${draftCount} draft_reply notification(s)`);
      }
      const otherCount = approvalActions.length - draftCount;
      if (otherCount > 0) {
        log.debug(`readOnly: suppressed ${otherCount} approval action(s)`);
      }
    } else {
      // Active mode — all actions go through approval, draft_reply sends on approve
      proposal.actions = approvalActions;
      await requestApproval(proposal);
      emitEvent(`proposal_created:${proposal.id}`, { proposalId: proposal.id });
      broadcastEvent('proposal_created', { id: proposal.id, summary: proposal.contextSummary });
    }
  }
}

// ─── Keyword suggestion ───────────────────────────────────────────────────────
// When a relevant message is processed but its tags don't match any existing
// keyword, suggest 1 new keyword to the owner so they can expand their triage rules.

async function suggestKeyword(result: ClassificationResult, config: Config): Promise<void> {
  // Only suggest when the message was relevant enough
  if ((result.importance ?? 0) < 5 || result.category === 'ignore' || result.category === 'info')
    return;
  if (!result.tags?.length) return;

  // Collect all known keywords (teams + whitelist + myHandles)
  const known = new Set<string>();
  for (const team of config.triage?.watchedTeams ?? []) {
    for (const kw of team.keywords ?? []) known.add(kw.toLowerCase());
    for (const h of team.handles ?? []) known.add(h.toLowerCase());
  }
  for (const kw of config.triage?.whitelistKeywords ?? []) known.add(kw.toLowerCase());
  for (const h of config.triage?.myHandles ?? []) known.add(h.toLowerCase());

  // Tags that aren't in the known set
  const newTags = result.tags.filter(
    (t) => !known.has(t.toLowerCase()) && t.length > 2 && t.length < 30,
  );
  if (!newTags.length) return;

  // Pick one at random — variety > determinism here
  const pick = newTags[Math.floor(Math.random() * newTags.length)];

  await _sendToApprovalChat(
    `💡 *Keyword suggéré:* \`${pick}\`\n` +
      `_Ajouté via: "${result.summary.slice(0, 80)}"_\n` +
      `→ /add_keyword pour l'ajouter à une équipe`,
  ).catch(() => {});
}

// ─── Daily briefing ───────────────────────────────────────────────────────────

export async function sendDailyBriefing(
  config: Config,
  telegram: TelegramChannel,
): Promise<void> {
  const briefing = config.briefing ?? {
    enabled: true,
    cronExpression: '0 8 * * 1-5',
    sections: { needsReply: true, stagnatingTasks: true, newTodos: true, pendingApprovals: true },
    silentWhenEmpty: true,
    language: 'fr' as const,
  };
  if (briefing.enabled === false) {
    log.info('briefing skipped — disabled in config');
    return;
  }
  const lang = briefing.language ?? 'fr';
  const L = lang === 'en'
    ? {
        title: '☀️ *Daily briefing*',
        respond: '📩 *To reply*',
        stagnate: '🚧 *Stagnating tasks*',
        todos: '🆕 *New todos*',
        approvals: '🔔 *Pending approvals*',
        empty: 'Nothing to report today.',
        dayShort: 'd',
      }
    : {
        title: '☀️ *Briefing du jour*',
        respond: '📩 *À répondre*',
        stagnate: '🚧 *Tâches qui stagnent*',
        todos: '🆕 *Nouveaux todos*',
        approvals: '🔔 *Approvals en attente*',
        empty: 'Rien à signaler aujourd\'hui.',
        dayShort: 'j',
      };

  const db = getDb();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const since24h = now - DAY;
  const stagnateCutoff = now - 3 * DAY;

  // ─ Section 1: À répondre ────────────────────────────────────────────────
  const sectionRespond: string[] = [];
  if (briefing.sections?.needsReply !== false) try {
    const notifs = db
      .prepare(
        `SELECT title, partner_name, message_url FROM notifications
         WHERE status = 'unread' AND created_at > ? ORDER BY created_at DESC LIMIT 5`,
      )
      .all(since24h) as Array<{
      title: string;
      partner_name: string | null;
      message_url: string | null;
    }>;
    if (notifs.length > 0) {
      for (const n of notifs) {
        const who = n.partner_name ? `[${n.partner_name}] ` : '';
        const link = n.message_url ? ` → ${n.message_url}` : '';
        sectionRespond.push(`• ${who}${n.title}${link}`);
      }
    } else {
      // Fallback: recent my-tasks
      const fallback = db
        .prepare(
          `SELECT title, partner_name FROM tasks
           WHERE status = 'open' AND is_my_task = 1 AND detected_at > ?
           ORDER BY detected_at DESC LIMIT 5`,
        )
        .all(since24h) as Array<{ title: string; partner_name: string | null }>;
      for (const t of fallback) {
        sectionRespond.push(`• ${t.partner_name ? `[${t.partner_name}] ` : ''}${t.title}`);
      }
    }
  } catch (e) {
    log.warn(`briefing: respond section failed: ${e}`);
  }

  // ─ Section 2: Tâches qui stagnent ───────────────────────────────────────
  const sectionStagnate: string[] = [];
  if (briefing.sections?.stagnatingTasks !== false) try {
    const stale = db
      .prepare(
        `SELECT title, partner_name, detected_at FROM tasks
         WHERE status IN ('open', 'in_progress') AND detected_at < ?
         ORDER BY detected_at ASC LIMIT 5`,
      )
      .all(stagnateCutoff) as Array<{
      title: string;
      partner_name: string | null;
      detected_at: number;
    }>;
    for (const t of stale) {
      const days = Math.floor((now - t.detected_at) / DAY);
      sectionStagnate.push(
        `• ${t.partner_name ? `[${t.partner_name}] ` : ''}${t.title} _(${days}${L.dayShort})_`,
      );
    }
  } catch (e) {
    log.warn(`briefing: stagnate section failed: ${e}`);
  }

  // ─ Section 3: Nouveaux todos ────────────────────────────────────────────
  const sectionTodos: string[] = [];
  if (briefing.sections?.newTodos !== false) try {
    const newTodos = db
      .prepare(
        `SELECT title, partner_name FROM todos
         WHERE status = 'open' AND created_at > ?
         ORDER BY created_at DESC LIMIT 5`,
      )
      .all(since24h) as Array<{ title: string; partner_name: string | null }>;
    for (const t of newTodos) {
      sectionTodos.push(`• ${t.partner_name ? `[${t.partner_name}] ` : ''}${t.title}`);
    }
  } catch (e) {
    log.warn(`briefing: todos section failed: ${e}`);
  }

  // ─ Section 4: Approvals en attente ──────────────────────────────────────
  const sectionApprovals: string[] = [];
  if (briefing.sections?.pendingApprovals !== false) try {
    const proposals = db
      .prepare(
        `SELECT id, reasoning FROM proposals
         WHERE status = 'proposed' AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC LIMIT 5`,
      )
      .all(now) as Array<{ id: string; reasoning: string | null }>;
    for (const p of proposals) {
      const label = (p.reasoning ?? '').slice(0, 80).replace(/\n/g, ' ') || p.id.slice(-8);
      sectionApprovals.push(`• ${label}`);
    }
  } catch (e) {
    log.warn(`briefing: approvals section failed: ${e}`);
  }

  // ─ Assemble ─────────────────────────────────────────────────────────────
  const allEmpty =
    sectionRespond.length === 0 &&
    sectionStagnate.length === 0 &&
    sectionTodos.length === 0 &&
    sectionApprovals.length === 0;

  if (allEmpty) {
    if (briefing.silentWhenEmpty !== false) {
      log.info('briefing skipped — nothing actionable today');
      return;
    }
    await telegram.sendToApprovalChat(`${L.title}\n\n${L.empty}`);
    return;
  }

  const lines: string[] = [L.title, ``];
  if (sectionRespond.length) {
    lines.push(L.respond, ...sectionRespond, ``);
  }
  if (sectionStagnate.length) {
    lines.push(L.stagnate, ...sectionStagnate, ``);
  }
  if (sectionTodos.length) {
    lines.push(L.todos, ...sectionTodos, ``);
  }
  if (sectionApprovals.length) {
    lines.push(L.approvals, ...sectionApprovals, ``);
  }

  await telegram.sendToApprovalChat(lines.join('\n').trimEnd());
}
