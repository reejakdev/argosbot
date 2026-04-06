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
import { loadConfig, getDataDir, hardenDataDir } from './config/index.js';
import { initDb, loadUlid, audit } from './db/index.js';
import { setLogLevel, setAuditCallback, createLogger } from './logger.js';
import { Anonymizer } from './privacy/anonymizer.js';
import { ContextWindowManager } from './ingestion/context-window.js';
import { purgeExpired } from './memory/store.js';
import { initApprovalGateway, expireStaleApprovals } from './gateway/approval.js';
import {
  registerBuiltinJobs,
  startAll as startCrons,
  stopAll as stopCrons,
  registerHandler,
  upsertCronJob,
} from './scheduler/index.js';
import {
  registerChannel,
  startAllChannels,
  stopAllChannels,
} from './ingestion/channels/registry.js';
import { createTelegramChannel } from './ingestion/channels/telegram.js';
import { createWhatsAppChannel } from './ingestion/channels/whatsapp.js';
import { createEmailChannel } from './ingestion/channels/email.js';
import { createSlackChannel } from './ingestion/channels/slack.js';
import { createSlackBot } from './ingestion/channels/slack-bot.js';
import { createDiscordChannel } from './ingestion/channels/discord.js';
import {
  loadKnowledge,
  refreshStaleKnowledge,
  reindexKnowledgeToVector,
} from './knowledge/index.js';
import { startWebApp } from './webapp/server.js';
import { pluginRegistry } from './plugins/registry.js';
import { buildPrivacyLlmConfig } from './core/privacy.js';
import { runProactivePlan } from './core/heartbeat.js';
import {
  ingestMessage,
  processWindow,
  sendDailyBriefing,
  setSendToApprovalChat,
} from './core/pipeline.js';
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
  hardenDataDir();

  // 2. DB
  const db = initDb(getDataDir());
  await loadUlid();

  // 3a. Skills — load builtin skills + user-defined agents into registry
  const { loadBuiltinSkills } = await import('./skills/registry.js');
  const { loadUserAgents } = await import('./agents/index.js');
  await loadBuiltinSkills();
  await loadUserAgents(config);

  setAuditCallback((level, module, msg, data) => {
    if (level === 'error' || level === 'warn') {
      try {
        audit(`log.${level}`, undefined, module, { msg, data });
      } catch {}
    }
  });
  log.info('DB initialized');

  // 3b. Wallet init — generate keys if enabled and not yet created
  let walletMonitorStop: (() => void) | null = null;
  if (config.wallet?.enabled) {
    const { ensureWallet } = await import('./wallet/index.js');
    const addrs = await ensureWallet(config.dataDir, config.wallet.encryptionSecret, {
      evm: Object.values(config.wallet.chains ?? {}).some((c) => 'chainId' in c),
      solana: Object.values(config.wallet.chains ?? {}).some((c) => !('chainId' in c)),
    });
    if (addrs.evm) log.info(`Wallet EVM:    ${addrs.evm}`);
    if (addrs.solana) log.info(`Wallet Solana: ${addrs.solana}`);

    // Wallet monitor — detects incoming txs and injects them into the pipeline
    if (config.wallet.monitor?.enabled) {
      const { createWalletMonitor } = await import('./wallet/monitor.js');
      const monitor = createWalletMonitor(
        addrs,
        config.wallet.chains ?? {},
        {
          pollIntervalSeconds: config.wallet.monitor.pollIntervalSeconds,
          watchNative: config.wallet.monitor.watchNative,
          watchTokens: config.wallet.monitor.watchTokens,
        },
        async (msg) => {
          await ingestMessage(msg, llmConfig, privacyConfig, config, anonymizer, windowManager);
        },
      );
      monitor.start();
      walletMonitorStop = monitor.stop;
      log.info('Wallet monitor started');
    }
  }

  // 3. LLM configs
  const { llmConfigFromConfig } = await import('./llm/index.js');
  const llmConfig = llmConfigFromConfig(config, {
    maxTokens: config.claude.maxTokens,
    maxIterations: config.claude.maxIterations,
  });

  if (llmConfig.provider !== 'compatible' && !llmConfig.apiKey) {
    throw new Error(
      'No LLM API key configured. Run  npm run setup  or check ~/.argos/.config.json',
    );
  }

  // Privacy agent — local model, zéro cloud egress pour les rôles privacy
  const privacyConfig: LLMConfig | null = buildPrivacyLlmConfig(config, {
    maxTokens: config.claude.maxTokens,
  });

  // 4. Privacy layer (anonymizer)
  const anonymizer = new Anonymizer(config.anonymizer);

  // 5. Context window manager
  const tgListener = config.channels.telegram.listener;
  const windowManager = new ContextWindowManager(tgListener.contextWindow, (window) =>
    processWindow(llmConfig, privacyConfig, config, anonymizer, window),
  );

  // Replay pending windows in background — never block boot
  ContextWindowManager.replayPending((window) =>
    processWindow(llmConfig, privacyConfig, config, anonymizer, window),
  ).catch(e => log.warn(`Window replay failed (non-blocking): ${e}`));

  // 6. Channels
  const tgPersonal = config.channels.telegram.personal;
  const personalToken =
    tgPersonal.botToken ?? config.secrets?.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
  const approvalChatId = tgPersonal.approvalChatId;

  // Listener — Telegram MTProto (user token, v1)
  let telegramChannel: Awaited<ReturnType<typeof createTelegramChannel>> | null = null;
  if (process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH) {
    telegramChannel = createTelegramChannel(getDataDir());
    registerChannel(telegramChannel);
    log.info('Telegram MTProto listener registered');
  }

  // Personal bot — owner-only, notifications + commands
  let telegramBot: InstanceType<
    typeof import('./ingestion/channels/telegram-bot.js').TelegramBot
  > | null = null;
  if (personalToken) {
    const { TelegramBot } = await import('./ingestion/channels/telegram-bot.js');
    telegramBot = new TelegramBot({
      token: personalToken,
      allowedUsers: tgPersonal.allowedUsers.length
        ? tgPersonal.allowedUsers
        : approvalChatId && approvalChatId !== 'me'
          ? [approvalChatId]
          : [],
      llmConfig,
      config,
      mtprotoChannel: telegramChannel ?? undefined,
    });
    await telegramBot.start();
    log.info('Telegram personal bot started');

    // Si pas de listener MTProto, le bot sert aussi de gateway
    if (!telegramChannel) {
      initApprovalGateway(
        async (chatId, text) => {
          await telegramBot!.sendMessage(chatId, text);
          return { message_id: 0 };
        },
        approvalChatId,
        config.security?.cloudMode ?? false,
      );
    }
  }

  let whatsappChannel: InstanceType<
    typeof import('./ingestion/channels/whatsapp.js').WhatsAppChannel
  > | null = null;
  if (process.env.WHATSAPP_ENABLED === 'true' || config.secrets?.WHATSAPP_ENABLED === 'true') {
    whatsappChannel = createWhatsAppChannel(getDataDir());
    if (config.channels.whatsapp?.approvalJid) {
      whatsappChannel.configure({
        partnerJids: {},
        approvalJid: config.channels.whatsapp.approvalJid,
      });
    }
    registerChannel(whatsappChannel);
    log.info('WhatsApp listener registered');
  }

  let slackBot: InstanceType<typeof import('./ingestion/channels/slack-bot.js').SlackBot> | null =
    null;

  if (
    config.channels.slack?.enabled &&
    (process.env.SLACK_USER_TOKEN || config.secrets?.SLACK_USER_TOKEN)
  ) {
    if (config.secrets?.SLACK_USER_TOKEN)
      process.env.SLACK_USER_TOKEN = config.secrets.SLACK_USER_TOKEN;
    const slackChannel = createSlackChannel(config.channels.slack);
    if (slackChannel) {
      registerChannel(slackChannel);
      log.info('Slack user-token listener registered');
    }
  }

  // Slack personal bot — owner notifications + commands (/proposals, /approve, /reject, …)
  const slackBotToken =
    config.channels.slack?.personal?.botToken ??
    config.secrets?.SLACK_BOT_TOKEN ??
    process.env.SLACK_BOT_TOKEN;
  const slackApprovalChannelId = config.channels.slack?.personal?.approvalChannelId;
  if (slackBotToken && slackApprovalChannelId) {
    slackBot = createSlackBot(
      {
        botToken: slackBotToken,
        approvalChannelId: slackApprovalChannelId,
        allowedUserIds: config.channels.slack?.personal?.allowedUserIds ?? [],
      },
      llmConfig,
      config,
    );
    await slackBot.start();
    log.info(`Slack personal bot started — approval channel: ${slackApprovalChannelId}`);
  }

  if (
    config.channels.discord?.enabled &&
    (process.env.DISCORD_BOT_TOKEN || config.secrets?.DISCORD_BOT_TOKEN)
  ) {
    if (config.secrets?.DISCORD_BOT_TOKEN)
      process.env.DISCORD_BOT_TOKEN = config.secrets.DISCORD_BOT_TOKEN;
    const discordChannel = createDiscordChannel(config.channels.discord);
    if (discordChannel) {
      registerChannel(discordChannel);
      log.info('Discord listener registered');
    }
  }

  // Signal channel — signal-cli sidecar (JSON-RPC over Unix socket)
  let signalChannel: InstanceType<
    typeof import('./ingestion/channels/signal.js').SignalChannel
  > | null = null;
  if (config.channels.signal?.enabled && config.channels.signal.phoneNumber) {
    const { createSignalChannel } = await import('./ingestion/channels/signal.js');
    signalChannel = createSignalChannel({
      signalCliBin: config.channels.signal.signalCliBin ?? 'signal-cli',
      phoneNumber: config.channels.signal.phoneNumber,
      allowedNumbers: config.channels.signal.allowedNumbers ?? [],
      socketPath: config.channels.signal.socketPath ?? '/tmp/argos-signal.sock',
      signalDataDir: config.channels.signal.signalDataDir,
    });
    registerChannel(signalChannel);
    log.info('Signal listener registered');
  }

  // 7. Approval gateway — Telegram bot > MTProto > Slack bot > web app only
  const cloudMode = config.security?.cloudMode ?? false;
  if (telegramBot) {
    initApprovalGateway(
      async (chatId, text) => {
        await telegramBot!.sendMessage(chatId, text);
        return { message_id: 0 };
      },
      approvalChatId,
      cloudMode,
    );
  } else if (telegramChannel) {
    initApprovalGateway(
      (chatId, text, opts) => telegramChannel!.sendMessage(chatId, text, opts),
      approvalChatId,
      cloudMode,
    );
  } else if (slackBot) {
    initApprovalGateway(
      async (_chatId, text) => {
        await slackBot!.sendToApprovalChat(text);
        return { message_id: 0 };
      },
      slackApprovalChannelId!,
      cloudMode,
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
  // Generate self-description first — then auto-index it + .config
  writeSelfDoc(config);

  // Auto-inject built-in self-knowledge sources (no user config needed)
  // NOTE: .config is intentionally NOT indexed — it may contain $REF tokens
  // and structural info already captured in argos-self.md. Never send raw config to LLM.
  const builtinSelf = {
    type: 'local' as const,
    name: 'Argos self',
    paths: ['~/.argos/argos-self.md'],
    refreshHours: 1,
  };
  const autoSources = [builtinSelf].filter(
    (a) =>
      !config.knowledge.sources.some(
        (s) => s.type === 'local' && (s as { name: string }).name === a.name,
      ),
  );
  if (autoSources.length) {
    config.knowledge.sources.push(...autoSources);
  }

  await loadKnowledge(config);
  void reindexKnowledgeToVector(config); // re-index existing docs into vector store (non-blocking)

  // Late-bind notification function.
  // Notifications push (proposals, alertes, heartbeat) → canal unique choisi via config.notifications.preferredChannel.
  // Les réponses conversationnelles utilisent toujours le canal d'origine (géré par chaque bot séparément).
  const preferred = config.notifications?.preferredChannel;

  function buildSendToApprovalChat(): (text: string) => Promise<void> {
    // Explicit preference — use the requested channel if available, warn + fallback if not.
    if (preferred === 'telegram_bot') {
      if (telegramBot)
        return async (t) => {
          await telegramBot!.sendMessage(approvalChatId, t);
        };
      log.warn(
        'notifications.preferredChannel=telegram_bot but no bot token configured — falling back',
      );
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
      log.warn(
        'notifications.preferredChannel=whatsapp but WhatsApp not configured — falling back',
      );
    }

    // Auto-detect priority: telegram_bot > telegram > slack > whatsapp
    if (telegramBot)
      return async (t) => {
        await telegramBot!.sendMessage(approvalChatId, t);
      };
    if (telegramChannel) return (t) => telegramChannel!.sendToApprovalChat(t);
    if (slackBot) return (t) => slackBot!.sendToApprovalChat(t);
    if (whatsappChannel) return (t) => whatsappChannel!.sendToApprovalChat(t);
    return async (_t) => {
      log.warn('No messaging channel configured — notification not sent');
    };
  }

  const sendToApprovalChat = buildSendToApprovalChat();
  if (preferred) log.info(`Notification channel: ${preferred}`);

  setSendToApprovalChat(sendToApprovalChat);

  // Wire direct message sender — bot only (MTProto listener is read-only).
  // If a personal bot token is configured, use it to send approved draft replies.
  // Bot can only send to chats where it has been added / started a conversation.
  if (telegramBot) {
    const { setSendDirectMessage } = await import('./workers/index.js');
    setSendDirectMessage(async (chatId, text) => {
      await telegramBot!.sendMessage(chatId, text);
    });
    log.info('Direct message sender wired via bot');
  }

  // 9. Heartbeat — core, channel-agnostic
  registerHandler('proactive_plan', async (jobConfig) => {
    await runProactivePlan(config, {
      prompt: String(jobConfig.prompt ?? ''),
      label: String(jobConfig.description ?? 'agent_cron'),
      sendToApprovalChat,
    });
  });

  if (config.heartbeat?.enabled) {
    const intervalMin = config.heartbeat.intervalMinutes ?? 60;
    const cronExpr =
      intervalMin < 60 ? `*/${intervalMin} * * * *` : `0 */${Math.round(intervalMin / 60)} * * *`;
    upsertCronJob('heartbeat', cronExpr, 'proactive_plan', {
      prompt: config.heartbeat.prompt ?? '',
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
    () => (telegramChannel ? sendDailyBriefing(config, telegramChannel) : Promise.resolve()),
    () => refreshStaleKnowledge(config),
  );

  // Task briefings — morning / noon / evening
  const { upsertCronJob: upsert } = await import('./scheduler/index.js');
  const briefSend = sendToApprovalChat;
  upsert('briefing_morning', '0 8 * * 1-5', 'briefing', { period: 'morning' });
  upsert('briefing_noon', '0 12 * * 1-5', 'briefing', { period: 'noon' });
  upsert('briefing_evening', '0 18 * * 1-5', 'briefing', { period: 'evening' });
  const { registerHandler: regHandler } = await import('./scheduler/index.js');
  regHandler('briefing', async (jobConfig) => {
    await sendTaskBriefing(jobConfig.period as 'morning' | 'noon' | 'evening', briefSend);
  });

  startCrons();

  // 11. Web app — with proactive follow-up on proposal execution
  startWebApp({
    sendToApprovalChat,
    getConfig: () => config,
    onProposalExecuted: telegramBot
      ? (result: import('./workers/proposal-executor.js').ExecutionResult, proposalId: string) => {
          void (async () => {
            // Feed script results back to the bot so LLM can analyze and react
            const allOutput = [...result.results, ...result.errors].join('\n');
            const summary = result.success
              ? `[Proposal ${proposalId.slice(-8)} — execution succeeded]\n\n${allOutput}`
              : `[Proposal ${proposalId.slice(-8)} — execution FAILED]\n\n${allOutput}`;
            // Find the owner's user ID — from allowedUsers or from the most recent conversation
            let ownerUserId: string | undefined = config.channels.telegram.personal.allowedUsers[0];
            if (!ownerUserId) {
              try {
                const { getDb: _getDb } = await import('./db/index.js');
                const row = _getDb()
                  .prepare('SELECT user_id FROM conversations ORDER BY updated_at DESC LIMIT 1')
                  .get() as { user_id: string } | undefined;
                ownerUserId = row?.user_id;
              } catch {
                /* non-blocking */
              }
            }
            log.info(
              `Proactive follow-up: sending result to userId=${ownerUserId} chatId=${approvalChatId}`,
            );
            if (ownerUserId) {
              telegramBot!.injectAndProcess(ownerUserId, approvalChatId, summary).catch((e) => {
                log.error(`Proactive follow-up failed: ${(e as Error)?.message}`);
              });
            }
          })();
        }
      : undefined,
  });

  // 12. Argos Display — only starts when Immersive Experience is enabled
  if (config.voice?.immersive) {
    const display = config.voice.display ?? { botName: 'Argos', accentColor: '#4f6eff', port: 3005 };
    const { startJarvisDisplay } = await import('./webapp/jarvis.js');
    startJarvisDisplay({
      botName: config.owner.botName ?? display.botName ?? 'Argos',
      logoUrl: display.logoUrl,
      accentColor: display.accentColor ?? '#4f6eff',
      port: display.port ?? 3005,
      stars: display.stars ?? false,
      effects: config.voice.effects,
    });
    const webappPort = config.webapp?.port ?? 3000;
    log.info(`Argos Display: https://localhost:${webappPort}/display (or http://localhost:${display.port ?? 3005})`);
  }

  const privacyInfo = privacyConfig
    ? ` | privacy: ${privacyConfig.model} (${config.privacy.provider})`
    : ' | privacy: none (all roles → primary)';
  log.info(
    `✅ Argos live — read-only: ${config.readOnly}, primary: ${llmConfig.model}${privacyInfo}`,
  );
  audit('argos_started', undefined, 'system', {
    model: llmConfig.model,
    readOnly: config.readOnly,
  });

  const shutdown = async (signal: string) => {
    log.info(`Shutting down (${signal})…`);
    await pluginRegistry.emitShutdown();
    await windowManager.flushAll();
    await stopAllChannels();
    slackBot?.stop();
    await signalChannel?.stop();
    walletMonitorStop?.();
    stopCrons();
    db.close();
    process.exit(0);
  };
  const handleSignal = (signal: string) => {
    // Force exit after 3s in case graceful shutdown hangs (e.g. gramjs disconnect)
    setTimeout(() => process.exit(0), 3000).unref();
    shutdown(signal).catch(() => process.exit(0));
  };
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
}

boot().catch((e) => {
  console.error('Fatal boot error:', e);
  process.exit(1);
});
