/**
 * Argos — main entry point.
 *
 * Boots the full pipeline:
 *   1. Load config + env
 *   2. Init SQLite DB
 *   3. Init LLM provider
 *   4. Register channels (Telegram, ...)
 *   5. Start approval gateway
 *   6. Register built-in cron jobs
 *   7. Start listening
 *
 * Pipeline per message:
 *   Telegram → sanitize → anonymize → context window → classify
 *   → memory store → plan → approval request → [human approves] → worker
 */

import 'dotenv/config';
import { loadConfig, getDataDir } from './config/index.js';
import { initDb, loadUlid, audit } from './db/index.js';
import { setLogLevel, setAuditCallback, createLogger } from './logger.js';
import { Anonymizer } from './privacy/anonymizer.js';
import { sanitize } from './privacy/sanitizer.js';
import { ContextWindowManager } from './ingestion/context-window.js';
import { classify } from './ingestion/classifier.js';
import { store as storeMemory, saveTask, purgeExpired } from './memory/store.js';
import { plan } from './planner/index.js';
import {
  initApprovalGateway,
  requestApproval,
  expireStaleApprovals,
} from './gateway/approval.js';
import {
  registerBuiltinJobs,
  startAll as startCrons,
  stopAll as stopCrons,
  emitEvent,
} from './scheduler/index.js';
import {
  registerChannel,
  startAllChannels,
  stopAllChannels,
} from './ingestion/channels/registry.js';
import { createTelegramChannel, TelegramChannel } from './ingestion/channels/telegram.js';
import { createWhatsAppChannel } from './ingestion/channels/whatsapp.js';
import { createEmailChannel } from './ingestion/channels/email.js';
import { loadContextSources, refreshStaleContextSources } from './context/index.js';
import { runHeartbeat, runProactivePlan } from './heartbeat/index.js';
import { registerHandler } from './scheduler/index.js';
import { startWebApp, broadcastEvent } from './webapp/server.js';
import type { RawMessage, ContextWindow, ClassificationResult } from './types.js';
import type { LLMConfig } from './llm/index.js';

const log = createLogger('argos');

// Late-bound notification function — set after channels are initialized
let _sendToApprovalChat: (text: string) => Promise<void> = async () => {};

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  log.info('🔭 Argos booting…');

  // 1. Config
  const config = loadConfig();
  setLogLevel(config.logLevel);

  // 2. DB
  const db = initDb(getDataDir());
  await loadUlid();

  // 3. Wire audit callback into logger (debug events → audit_log)
  setAuditCallback((level, module, msg, data) => {
    if (level === 'error' || level === 'warn') {
      try {
        audit(`log.${level}`, undefined, module, { msg, data });
      } catch {}
    }
  });

  log.info('DB initialized');

  // 4. Build LLM config from config file (supports OAuth, multi-provider)
  const { llmConfigFromConfig } = await import('./llm/index.js');
  const llmConfig = llmConfigFromConfig(config, { maxTokens: config.claude.maxTokens });

  if (!llmConfig.apiKey) {
    throw new Error(
      'No LLM API key configured. Run  npm run setup  or check ~/.argos/config.json → llm.providers',
    );
  }

  // 5. Privacy layer
  const anonymizer = new Anonymizer(config.anonymizer);

  // 6. Context window manager
  const windowManager = new ContextWindowManager(
    config.telegram.contextWindow,
    processWindow.bind(null, llmConfig, config, anonymizer),
  );

  // Replay any windows that were open before a crash
  await ContextWindowManager.replayPending(
    processWindow.bind(null, llmConfig, config, anonymizer),
  );

  // 7. Channels — all optional, at least one needed for interaction
  let telegramChannel: Awaited<ReturnType<typeof createTelegramChannel>> | null = null;

  // Telegram MTProto (monitoring plugin — uses YOUR account)
  if (process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH) {
    telegramChannel = createTelegramChannel(getDataDir());
    registerChannel(telegramChannel);
    log.info('Telegram MTProto channel registered');
  }

  // Telegram Bot (interaction — chat with Argos, approvals, commands)
  const botToken = config.secrets?.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
  let telegramBot: InstanceType<typeof import('./ingestion/channels/telegram-bot.js').TelegramBot> | null = null;
  if (botToken) {
    const { TelegramBot } = await import('./ingestion/channels/telegram-bot.js');
    const approvalChatId = config.telegram?.approvalChatId;
    telegramBot = new TelegramBot({
      token: botToken,
      allowedUsers: approvalChatId && approvalChatId !== 'me' ? [approvalChatId] : [],
      llmConfig,
      config,
    });
    await telegramBot.start();
    log.info('Telegram Bot started — chatting enabled');

    // Use bot for approvals if no MTProto
    if (!telegramChannel && approvalChatId) {
      initApprovalGateway(
        async (chatId, text) => { await telegramBot!.sendMessage(chatId, text); return { message_id: 0 }; },
        approvalChatId,
      );
    }
  }

  // WhatsApp (optional — requires Baileys + WHATSAPP_ENABLED=true)
  if (process.env.WHATSAPP_ENABLED === 'true' || config.secrets?.WHATSAPP_ENABLED === 'true') {
    const waChannel = createWhatsAppChannel(getDataDir());
    registerChannel(waChannel);
    log.info('WhatsApp channel registered');
  }

  // 8. Approval gateway (MTProto takes priority, then bot — set above)
  if (telegramChannel) {
    initApprovalGateway(
      (chatId, text, opts) => telegramChannel!.sendMessage(chatId, text, opts),
      config.telegram.approvalChatId,
    );
  } else if (!botToken) {
    log.warn('No messaging channel configured — approvals via web app only');
  }

  // Email IMAP (optional — requires EMAIL_IMAP_* env vars)
  const emailChannel = createEmailChannel();
  if (emailChannel) {
    registerChannel(emailChannel);
    log.info('Email IMAP channel registered');
  }

  await startAllChannels(async (msg: RawMessage) => {
    await ingestMessage(msg, llmConfig, config, anonymizer, windowManager);
  });

  // 10. MCP servers — connect via stdio, discover tools
  if (config.mcpServers?.length) {
    const { connectMcpServers } = await import('./mcp/client.js');
    await connectMcpServers(config.mcpServers);
  }

  // 11. Context sources (docs, GitHub repos, Notion pages)
  await loadContextSources(config);

  // 11. Cron jobs
  const approvalChatId = config.telegram?.approvalChatId;
  const sendToApprovalChat = telegramChannel
    ? (text: string) => telegramChannel!.sendToApprovalChat(text)
    : telegramBot && approvalChatId
      ? async (text: string) => { await telegramBot!.sendMessage(approvalChatId, text); }
      : async (_text: string) => { log.warn('No messaging channel — message not sent'); };

  // Make available to processWindow for auto-execution notifications
  _sendToApprovalChat = sendToApprovalChat;

  // Register the proactive_plan handler — used by agent-created cron jobs
  registerHandler('proactive_plan', async (jobConfig) => {
    await runProactivePlan(config, {
      prompt:              String(jobConfig.prompt ?? ''),
      label:               String(jobConfig.description ?? 'agent_cron'),
      sendToApprovalChat,
    });
  });

  registerBuiltinJobs(
    () => purgeExpired(),
    () => expireStaleApprovals(),
    () => telegramChannel ? sendDailyBriefing(config, telegramChannel) : Promise.resolve(),
    () => refreshStaleContextSources(config),
  );

  // Register heartbeat cron if enabled
  if (config.heartbeat?.enabled) {
    const intervalMin = config.heartbeat.intervalMinutes ?? 60;
    // Convert minutes to cron expression: every N minutes
    const cronExpr = intervalMin < 60
      ? `*/${intervalMin} * * * *`
      : `0 */${Math.round(intervalMin / 60)} * * *`;

    const { upsertCronJob } = await import('./scheduler/index.js');
    upsertCronJob('heartbeat', cronExpr, 'proactive_plan', {
      prompt:      config.heartbeat.prompt ?? '',
      description: 'heartbeat',
    });

    log.info(`Heartbeat enabled — every ${intervalMin} min [${cronExpr}]`);
  }

  startCrons();

  // 11. Local web app (mobile UI)
  startWebApp({
    sendToApprovalChat,
    getConfig: () => config,
  });

  log.info(`✅ Argos is live — read-only: ${config.readOnly}, model: ${llmConfig.model} (${llmConfig.provider})`);
  audit('argos_started', undefined, 'system', {
    model: llmConfig.model,
    readOnly: config.readOnly,
  });

  // Graceful shutdown
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  async function shutdown(signal: string) {
    log.info(`Shutting down (${signal})…`);
    await windowManager.flushAll();
    await stopAllChannels();
    stopCrons();
    db.close();
    process.exit(0);
  }
}

// ─── Message ingestion pipeline ───────────────────────────────────────────────

async function ingestMessage(
  msg: RawMessage,
  llmConfig: LLMConfig,
  config: ReturnType<typeof loadConfig>,
  anonymizer: Anonymizer,
  windowManager: ContextWindowManager,
): Promise<void> {
  log.debug(`Ingesting message from ${msg.partnerName ?? msg.chatId}`, {
    source: msg.source,
    length: msg.content.length,
  });

  // Persist raw reference (no content stored — just metadata + hash)
  const db = (await import('./db/index.js')).getDb();
  const crypto = await import('crypto');
  const contentHash = crypto.createHash('sha256').update(msg.content).digest('hex');

  db.prepare(`
    INSERT OR IGNORE INTO messages
    (id, source, chat_id, partner_name, sender_id, sender_name, content_hash, received_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    msg.id, msg.source, msg.chatId, msg.partnerName ?? null,
    msg.senderId ?? null, msg.senderName ?? null,
    contentHash, msg.receivedAt,
  );

  // Prompt injection check
  const sanitized = await sanitize(msg.content, msg.source, llmConfig);
  if (!sanitized.safe) {
    log.warn(`Injection blocked from ${msg.chatId}`, { patterns: sanitized.injectionPatterns });
    db.prepare(`UPDATE messages SET status = 'blocked', processed_at = ? WHERE id = ?`).run(Date.now(), msg.id);
    return;
  }

  // Anonymize
  const anon = anonymizer.anonymize(msg.content);

  // Feed into context window (batching)
  windowManager.add(msg, anon.text, anon.lookup);

  db.prepare(`UPDATE messages SET status = 'windowed' WHERE id = ?`).run(msg.id);
}

// ─── Context window processor (called when window closes) ─────────────────────

async function processWindow(
  llmConfig: LLMConfig,
  config: ReturnType<typeof loadConfig>,
  anonymizer: Anonymizer,
  window: ContextWindow,
): Promise<void> {
  log.info(`Processing window ${window.id}`, {
    messages: window.messages.length,
    partner: window.partnerName,
  });

  // Classify the window
  const result: ClassificationResult = await classify(window, llmConfig, config);

  // Store memory
  const memory = storeMemory(result.summary, result, window, {
    defaultTtlDays: config.memory.defaultTtlDays,
    archiveTtlDays: config.memory.archiveTtlDays,
    autoArchiveThreshold: config.memory.autoArchiveThreshold,
  });

  // Save task if detected
  if (result.category === 'task' || result.category === 'tx_request' || result.category === 'client_request') {
    const taskId = saveTask(result.summary.slice(0, 120), result, window);
    broadcastEvent('task_created', { id: taskId, summary: result.summary, partner: window.partnerName });
  }

  // Emit completion events for chained triggers
  if (result.completedTaskIds.length > 0) {
    for (const taskId of result.completedTaskIds) {
      emitEvent(`task_completed:${taskId}`, { taskId, partner: window.partnerName });
    }
  }

  // Plan if action required
  if (!result.requiresAction && result.importance < 4) {
    log.debug(`Window ${window.id} — no action required (importance ${result.importance})`);
    return;
  }

  const proposal = await plan(window, result, config);

  if (proposal && proposal.actions.length > 0) {
    // Separate auto-approved actions (owner workspace: Notion, tasks, reminders)
    // from actions that require human approval
    const autoActions = proposal.actions.filter(a => !a.requiresApproval);
    const approvalActions = proposal.actions.filter(a => a.requiresApproval);

    // Execute auto-approved actions immediately
    if (autoActions.length > 0) {
      const { executeProposal } = await import('./workers/index.js');
      const autoProposal = { ...proposal, actions: autoActions };
      log.info(`Auto-executing ${autoActions.length} action(s) (owner workspace)`);
      await executeProposal(autoProposal, autoActions, config, _sendToApprovalChat).catch(e => {
        log.error('Auto-execution failed', e);
      });
      audit('auto_executed', proposal.id, 'proposal', {
        actions: autoActions.map(a => a.description),
      });
    }

    // Send remaining actions to approval gateway
    if (approvalActions.length > 0) {
      proposal.actions = approvalActions;
      await requestApproval(proposal);
      emitEvent(`proposal_created:${proposal.id}`, { proposalId: proposal.id });
      broadcastEvent('proposal_created', { id: proposal.id, summary: proposal.contextSummary });
    }
  }
}

// ─── Daily briefing ───────────────────────────────────────────────────────────

async function sendDailyBriefing(
  config: ReturnType<typeof loadConfig>,
  telegram: TelegramChannel,
): Promise<void> {
  const db = (await import('./db/index.js')).getDb();

  const openTasks = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE status = 'open'`).get() as { c: number };
  const pendingApprovals = db.prepare(`SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'`).get() as { c: number };
  const myTasks = db.prepare(`SELECT * FROM tasks WHERE status = 'open' AND is_my_task = 1 ORDER BY detected_at DESC LIMIT 5`).all() as Array<{ title: string; partner_name: string | null }>;

  const lines = [
    `☀️ *Argos Morning Briefing*`,
    ``,
    `📋 Open tasks: **${openTasks.c}** (${pendingApprovals.c} pending approval)`,
    ``,
  ];

  if (myTasks.length > 0) {
    lines.push(`👤 *Your tasks:*`);
    for (const t of myTasks) {
      const partner = t.partner_name ? ` [${t.partner_name}]` : '';
      lines.push(`• ${t.title}${partner}`);
    }
  } else {
    lines.push(`✅ No tasks assigned to you`);
  }

  lines.push(``, `_Have a productive day, ${config.owner.name}._`);

  await telegram.sendToApprovalChat(lines.join('\n'));
}

// ─── Run ──────────────────────────────────────────────────────────────────────

boot().catch(e => {
  console.error('Fatal boot error:', e);
  process.exit(1);
});
