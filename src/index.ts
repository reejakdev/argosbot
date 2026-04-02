/**
 * Argos — entry point.
 *
 * Boot order:
 *   1. Config + env
 *   2. DB
 *   3. LLM configs (primary + privacy)
 *   4. Privacy layer (anonymizer)
 *   5. Context window manager
 *   6. Channels (listener + personal)
 *   7. Approval gateway
 *   8. Knowledge sources
 *   9. Heartbeat cron
 *  10. Cron jobs
 *  11. Web app
 *  12. Graceful shutdown
 */

import 'dotenv/config';
import { loadConfig, getDataDir } from './config/index.js';
import { initDb, loadUlid, audit } from './db/index.js';
import { setLogLevel, setAuditCallback, createLogger } from './logger.js';
import { Anonymizer } from './privacy/anonymizer.js';
import { ContextWindowManager } from './ingestion/context-window.js';
import { purgeExpired } from './memory/store.js';
import { initApprovalGateway, expireStaleApprovals } from './gateway/approval.js';
import { registerBuiltinJobs, startAll as startCrons, stopAll as stopCrons, registerHandler, upsertCronJob } from './scheduler/index.js';
import { registerChannel, startAllChannels, stopAllChannels } from './ingestion/channels/registry.js';
import { createTelegramChannel } from './ingestion/channels/telegram.js';
import { createWhatsAppChannel } from './ingestion/channels/whatsapp.js';
import { createEmailChannel } from './ingestion/channels/email.js';
import { createSlackChannel } from './ingestion/channels/slack.js';
import { createSlackBot } from './ingestion/channels/slack-bot.js';
import { createDiscordChannel } from './ingestion/channels/discord.js';
import { loadKnowledge, refreshStaleKnowledge } from './knowledge/index.js';
import { startWebApp } from './webapp/server.js';
import { pluginRegistry } from './plugins/registry.js';
import { buildPrivacyLlmConfig } from './core/privacy.js';
import { runProactivePlan } from './core/heartbeat.js';
import { ingestMessage, processWindow, sendDailyBriefing, setSendToApprovalChat } from './core/pipeline.js';
import { writeSelfDoc } from './core/self-doc.js';
import { sendTaskBriefing } from './core/briefing.js';
import type { RawMessage } from './types.js';
import type { LLMConfig } from './llm/index.js';

const log = createLogger('argos');

async function boot() {
  log.info('🔭 Argos booting…');

  // 1. Config
  const config = loadConfig();
  setLogLevel(config.logLevel);

  // 2. DB
  const db = initDb(getDataDir());
  await loadUlid();

  setAuditCallback((level, module, msg, data) => {
    if (level === 'error' || level === 'warn') {
      try { audit(`log.${level}`, undefined, module, { msg, data }); } catch {}
    }
  });
  log.info('DB initialized');

  // 3b. Wallet init — generate keys if enabled and not yet created
  if (config.wallet?.enabled) {
    const { ensureWallet } = await import('./wallet/index.js');
    const addrs = await ensureWallet(
      config.dataDir,
      config.wallet.encryptionSecret,
      {
        evm:    Object.values(config.wallet.chains ?? {}).some(c => 'chainId' in c),
        solana: Object.values(config.wallet.chains ?? {}).some(c => !('chainId' in c)),
      },
    );
    if (addrs.evm)    log.info(`Wallet EVM:    ${addrs.evm}`);
    if (addrs.solana) log.info(`Wallet Solana: ${addrs.solana}`);
  }

  // 3. LLM configs
  const { llmConfigFromConfig } = await import('./llm/index.js');
  const llmConfig = llmConfigFromConfig(config, { maxTokens: config.claude.maxTokens });

  if (llmConfig.provider !== 'compatible' && !llmConfig.apiKey) {
    throw new Error('No LLM API key configured. Run  npm run setup  or check ~/.argos/config.json');
  }

  // Privacy agent — local model, zéro cloud egress pour les rôles privacy
  const privacyConfig: LLMConfig | null = buildPrivacyLlmConfig(config, { maxTokens: config.claude.maxTokens });

  // 4. Privacy layer (anonymizer)
  const anonymizer = new Anonymizer(config.anonymizer);

  // 5. Context window manager
  const tgListener   = config.channels.telegram.listener;
  const windowManager = new ContextWindowManager(
    tgListener.contextWindow,
    (window) => processWindow(llmConfig, privacyConfig, config, anonymizer, window),
  );

  await ContextWindowManager.replayPending(
    (window) => processWindow(llmConfig, privacyConfig, config, anonymizer, window),
  );

  // 6. Channels
  const tgPersonal   = config.channels.telegram.personal;
  const personalToken = tgPersonal.botToken
    ?? config.secrets?.TELEGRAM_BOT_TOKEN
    ?? process.env.TELEGRAM_BOT_TOKEN;
  const approvalChatId = tgPersonal.approvalChatId;

  // Listener — Telegram MTProto (user token, v1)
  let telegramChannel: Awaited<ReturnType<typeof createTelegramChannel>> | null = null;
  if (process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH) {
    telegramChannel = createTelegramChannel(getDataDir());
    registerChannel(telegramChannel);
    log.info('Telegram MTProto listener registered');
  }

  // Personal bot — owner-only, notifications + commands
  let telegramBot: InstanceType<typeof import('./ingestion/channels/telegram-bot.js').TelegramBot> | null = null;
  if (personalToken) {
    const { TelegramBot } = await import('./ingestion/channels/telegram-bot.js');
    telegramBot = new TelegramBot({
      token:        personalToken,
      allowedUsers: tgPersonal.allowedUsers.length
        ? tgPersonal.allowedUsers
        : approvalChatId !== 'me' ? [approvalChatId] : [],
      llmConfig,
      config,
      mtprotoChannel: telegramChannel ?? undefined,
    });
    await telegramBot.start();
    log.info('Telegram personal bot started');

    // Si pas de listener MTProto, le bot sert aussi de gateway
    if (!telegramChannel) {
      initApprovalGateway(
        async (chatId, text) => { await telegramBot!.sendMessage(chatId, text); return { message_id: 0 }; },
        approvalChatId,
      );
    }
  }

  let whatsappChannel: InstanceType<typeof import('./ingestion/channels/whatsapp.js').WhatsAppChannel> | null = null;
  if (process.env.WHATSAPP_ENABLED === 'true' || config.secrets?.WHATSAPP_ENABLED === 'true') {
    whatsappChannel = createWhatsAppChannel(getDataDir());
    if (config.channels.whatsapp?.approvalJid) {
      whatsappChannel.configure({ partnerJids: {}, approvalJid: config.channels.whatsapp.approvalJid });
    }
    registerChannel(whatsappChannel);
    log.info('WhatsApp listener registered');
  }

  let slackBot: InstanceType<typeof import('./ingestion/channels/slack-bot.js').SlackBot> | null = null;

  if (config.channels.slack?.enabled && (process.env.SLACK_USER_TOKEN || config.secrets?.SLACK_USER_TOKEN)) {
    if (config.secrets?.SLACK_USER_TOKEN) process.env.SLACK_USER_TOKEN = config.secrets.SLACK_USER_TOKEN;
    const slackChannel = createSlackChannel(config.channels.slack);
    if (slackChannel) { registerChannel(slackChannel); log.info('Slack user-token listener registered'); }
  }

  // Slack personal bot — owner notifications + commands (/proposals, /approve, /reject, …)
  const slackBotToken = config.channels.slack?.personal?.botToken ?? config.secrets?.SLACK_BOT_TOKEN ?? process.env.SLACK_BOT_TOKEN;
  const slackApprovalChannelId = config.channels.slack?.personal?.approvalChannelId;
  if (slackBotToken && slackApprovalChannelId) {
    slackBot = createSlackBot(
      {
        botToken:          slackBotToken,
        approvalChannelId: slackApprovalChannelId,
        allowedUserIds:    config.channels.slack?.personal?.allowedUserIds ?? [],
      },
      llmConfig,
      config,
    );
    await slackBot.start();
    log.info(`Slack personal bot started — approval channel: ${slackApprovalChannelId}`);
  }

  if (config.channels.discord?.enabled && (process.env.DISCORD_BOT_TOKEN || config.secrets?.DISCORD_BOT_TOKEN)) {
    if (config.secrets?.DISCORD_BOT_TOKEN) process.env.DISCORD_BOT_TOKEN = config.secrets.DISCORD_BOT_TOKEN;
    const discordChannel = createDiscordChannel(config.channels.discord);
    if (discordChannel) { registerChannel(discordChannel); log.info('Discord listener registered'); }
  }

  // 7. Approval gateway — Telegram bot > MTProto > Slack bot > web app only
  if (telegramBot) {
    initApprovalGateway(
      async (chatId, text) => { await telegramBot!.sendMessage(chatId, text); return { message_id: 0 }; },
      approvalChatId,
    );
  } else if (telegramChannel) {
    initApprovalGateway(
      (chatId, text, opts) => telegramChannel!.sendMessage(chatId, text, opts),
      approvalChatId,
    );
  } else if (slackBot) {
    initApprovalGateway(
      async (_chatId, text) => { await slackBot!.sendToApprovalChat(text); return { message_id: 0 }; },
      slackApprovalChannelId!,
    );
    log.info('Approval gateway wired via Slack bot');
  } else {
    log.warn('No messaging channel configured — approvals via web app only');
  }

  const emailChannel = createEmailChannel();
  if (emailChannel) {
    registerChannel(emailChannel);
    log.info('Email IMAP listener registered');
  }

  await startAllChannels(async (msg: RawMessage) => {
    await ingestMessage(msg, llmConfig, privacyConfig, config, anonymizer, windowManager);
  });

  // MCP servers
  if (config.mcpServers?.length) {
    const { connectMcpServers } = await import('./mcp/client.js');
    await connectMcpServers(config.mcpServers);
  }

  // 8. Knowledge sources
  // Generate self-description first — then auto-index it + config.json
  writeSelfDoc(config);

  // Auto-inject built-in self-knowledge sources (no user config needed)
  const builtinSelf = { type: 'local' as const, name: 'Argos self', paths: ['~/.argos/argos-self.md'], refreshHours: 1 };
  const builtinCfg  = { type: 'local' as const, name: 'Argos config', paths: ['~/.argos/config.json'], refreshHours: 1 };
  const autoSources = [builtinSelf, builtinCfg].filter(
    a => !config.knowledge.sources.some(s => s.type === 'local' && (s as { name: string }).name === a.name),
  );
  if (autoSources.length) {
    config.knowledge.sources.push(...autoSources);
  }

  await loadKnowledge(config);

  // Late-bind notification function.
  // Notifications push (proposals, alertes, heartbeat) → canal unique choisi via config.notifications.preferredChannel.
  // Les réponses conversationnelles utilisent toujours le canal d'origine (géré par chaque bot séparément).
  const preferred = config.notifications?.preferredChannel;

  function buildSendToApprovalChat(): (text: string) => Promise<void> {
    // Explicit preference — use the requested channel if available, warn + fallback if not.
    if (preferred === 'telegram_bot') {
      if (telegramBot) return async (t) => { await telegramBot!.sendMessage(approvalChatId, t); };
      log.warn('notifications.preferredChannel=telegram_bot but no bot token configured — falling back');
    }
    if (preferred === 'telegram') {
      if (telegramChannel) return (t) => telegramChannel!.sendToApprovalChat(t);
      log.warn('notifications.preferredChannel=telegram but MTProto not configured — falling back');
    }
    if (preferred === 'slack') {
      if (slackBot) return (t) => slackBot!.sendToApprovalChat(t);
      log.warn('notifications.preferredChannel=slack but no Slack bot configured — falling back');
    }
    if (preferred === 'whatsapp') {
      if (whatsappChannel) return (t) => whatsappChannel!.sendToApprovalChat(t);
      log.warn('notifications.preferredChannel=whatsapp but WhatsApp not configured — falling back');
    }

    // Auto-detect priority: telegram_bot > telegram > slack > whatsapp
    if (telegramBot)     return async (t) => { await telegramBot!.sendMessage(approvalChatId, t); };
    if (telegramChannel) return (t) => telegramChannel!.sendToApprovalChat(t);
    if (slackBot)        return (t) => slackBot!.sendToApprovalChat(t);
    if (whatsappChannel) return (t) => whatsappChannel!.sendToApprovalChat(t);
    return async (_t) => { log.warn('No messaging channel configured — notification not sent'); };
  }

  const sendToApprovalChat = buildSendToApprovalChat();
  if (preferred) log.info(`Notification channel: ${preferred}`);

  setSendToApprovalChat(sendToApprovalChat);

  // Wire direct message sender — bot only (MTProto listener is read-only).
  // If a personal bot token is configured, use it to send approved draft replies.
  // Bot can only send to chats where it has been added / started a conversation.
  if (telegramBot) {
    const { setSendDirectMessage } = await import('./workers/index.js');
    setSendDirectMessage(async (chatId, text) => { await telegramBot!.sendMessage(chatId, text); });
    log.info('Direct message sender wired via bot');
  }

  // 9. Heartbeat — core, channel-agnostic
  registerHandler('proactive_plan', async (jobConfig) => {
    await runProactivePlan(config, {
      prompt:             String(jobConfig.prompt ?? ''),
      label:              String(jobConfig.description ?? 'agent_cron'),
      sendToApprovalChat,
    });
  });

  if (config.heartbeat?.enabled) {
    const intervalMin = config.heartbeat.intervalMinutes ?? 60;
    const cronExpr    = intervalMin < 60
      ? `*/${intervalMin} * * * *`
      : `0 */${Math.round(intervalMin / 60)} * * *`;
    upsertCronJob('heartbeat', cronExpr, 'proactive_plan', {
      prompt:      config.heartbeat.prompt ?? '',
      description: 'heartbeat',
    });
    log.info(`Heartbeat enabled — every ${intervalMin}min [${cronExpr}]`);
  }

  // Plugins optionnels
  const pluginCtx = { config, llmConfig, privacyConfig, notify: sendToApprovalChat };
  await pluginRegistry.emitBoot(pluginCtx);

  // 10. Cron jobs built-in
  registerBuiltinJobs(
    () => purgeExpired(),
    () => expireStaleApprovals(),
    () => telegramChannel ? sendDailyBriefing(config, telegramChannel) : Promise.resolve(),
    () => refreshStaleKnowledge(config),
  );

  // Task briefings — morning / noon / evening
  const { upsertCronJob: upsert } = await import('./scheduler/index.js');
  const briefSend = sendToApprovalChat;
  upsert('briefing_morning', '0 8 * * 1-5',  'briefing', { period: 'morning' });
  upsert('briefing_noon',    '0 12 * * 1-5', 'briefing', { period: 'noon' });
  upsert('briefing_evening', '0 18 * * 1-5', 'briefing', { period: 'evening' });
  const { registerHandler: regHandler } = await import('./scheduler/index.js');
  regHandler('briefing', async (jobConfig) => {
    await sendTaskBriefing(jobConfig.period as 'morning' | 'noon' | 'evening', briefSend);
  });

  startCrons();

  // 11. Web app
  startWebApp({ sendToApprovalChat, getConfig: () => config });

  const privacyInfo = privacyConfig
    ? ` | privacy: ${privacyConfig.model} (${config.privacy.provider})`
    : ' | privacy: none (all roles → primary)';
  log.info(`✅ Argos live — read-only: ${config.readOnly}, primary: ${llmConfig.model}${privacyInfo}`);
  audit('argos_started', undefined, 'system', { model: llmConfig.model, readOnly: config.readOnly });

  const shutdown = async (signal: string) => {
    log.info(`Shutting down (${signal})…`);
    await pluginRegistry.emitShutdown();
    await windowManager.flushAll();
    await stopAllChannels();
    slackBot?.stop();
    stopCrons();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

boot().catch(e => {
  console.error('Fatal boot error:', e);
  process.exit(1);
});
