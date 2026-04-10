import { z } from 'zod';

// ─── Privacy ──────────────────────────────────────────────────────────────────
// Première classe dans le core — pas un plugin.
// Chaque rôle du pipeline peut être routé vers le LLM local (privacy) ou cloud (primary).

const PrivacyRoleSchema = z.enum(['privacy', 'primary']);

const PrivacySchema = z
  .object({
    /**
     * Provider local pour les rôles 'privacy' — ex: "ollama", "lmstudio"
     * Doit correspondre à une clé dans llm.providers.
     * Si absent, tous les rôles privacy tombent sur le primary.
     */
    provider: z.string().optional(),
    /** Modèle à utiliser pour le provider privacy (défaut: premier modèle du provider) */
    model: z.string().optional(),
    /**
     * Routing par rôle — qui traite quoi.
     *   'privacy' = modèle local (zéro cloud egress pour le contenu)
     *   'primary' = modèle cloud (reçoit uniquement du contenu anonymisé)
     */
    roles: z
      .object({
        /**
         * Détection d'injection — envoie le contenu BRUT au LLM.
         * 'privacy' (local) = zero cloud egress (recommandé si LLM local disponible).
         * 'primary' (cloud) = plus fiable mais raw content part chez Anthropic.
         */
        sanitize: PrivacyRoleSchema.default('privacy'),
        /** Classification du message — contenu partenaire, local par défaut */
        classify: PrivacyRoleSchema.default('privacy'),
        /** Triage inbox — contenu partenaire, local par défaut */
        triage: PrivacyRoleSchema.default('privacy'),
        /** Anonymisation LLM second pass — local obligatoire */
        llmAnon: PrivacyRoleSchema.default('privacy'),
        /** Planning/raisonnement complexe — cloud, contenu anonymisé uniquement */
        plan: PrivacyRoleSchema.default('primary'),
      })
      .default({}),
    /**
     * Persiste le contenu brut (pré-anonymisation) dans la colonne raw_content de memories.
     * Accessible uniquement via les fonctions de recherche avec includeRaw=true —
     * à utiliser exclusivement pour les LLM locaux (rôle 'privacy').
     * Désactivé par défaut — opt-in explicite requis.
     */
    storeRaw: z.boolean().default(false),
    /**
     * Chiffre le contenu brut de chaque message avec AES-256-GCM avant stockage.
     * La clé est lue depuis ~/.argos/message.key (32 octets, générée automatiquement au premier démarrage).
     * Déchiffrement via : npm run decrypt -- <message_id>
     * Désactivé par défaut — opt-in explicite requis.
     */
    encryptMessages: z.boolean().default(false),
  })
  .default({});

// ─── Triage ───────────────────────────────────────────────────────────────────
// Core — channel-agnostic. Opère sur RawMessage peu importe la source.

const TriageTeamSchema = z.object({
  name: z.string(),
  handles: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  description: z.string().optional(), // context hint for LLM routing
  isOwnTeam: z.boolean().default(false), // true = internal team (not a partner)
});

const TriageSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Handles qui te désignent toi — @username, prénom, etc. */
    myHandles: z.array(z.string()).default([]),
    /** Teams à surveiller pour le routage team_task */
    watchedTeams: z.array(TriageTeamSchema).default([]),
    /** Mots-clés déclenchant un tx_whitelist */
    whitelistKeywords: z
      .array(z.string())
      .default([
        'whitelist',
        'add address',
        'ajouter adresse',
        'whitelist address',
        'can you add',
        'pouvez-vous ajouter',
      ]),
    /** Si true : messages de l'équipe interne (isOwnTeam) ignorés sauf si @mention */
    ignoreOwnTeam: z.boolean().default(true),
    /** Si true : triage uniquement si @mention explicite (pas de triage passif) */
    mentionOnly: z.boolean().default(false),
    /** Database Notion cible pour les tâches créées (optionnel) */
    notionTodoDatabaseId: z.string().optional(),
    /** Database Notion Kanban pour le task tracker Midas (Status: Todo/In Progress/Done) */
    notionTaskDatabaseId: z.string().optional(),
    /** Database Notion Kanban pour les todos personnels */
    notionPersonalDatabaseId: z.string().optional(),
    /** Pre-screen + LLM second opinion before creating a notification */
    notificationsLlmFilter: z.boolean().default(false),
  })
  .default({});

const TodoExtractionSchema = z
  .object({
    enabled: z.boolean().default(false),
    intervalHours: z.number().min(1).max(24).default(6),
    lookbackHours: z.number().min(1).max(168).default(6),
  })
  .default({});

// ─── Briefing ─────────────────────────────────────────────────────────────────
const BriefingSchema = z
  .object({
    enabled: z.boolean().default(true),
    cronExpression: z.string().default('0 8 * * 1-5'),
    sections: z
      .object({
        needsReply: z.boolean().default(true),
        stagnatingTasks: z.boolean().default(true),
        newTodos: z.boolean().default(true),
        pendingApprovals: z.boolean().default(true),
      })
      .default({}),
    silentWhenEmpty: z.boolean().default(true),
    language: z.enum(['fr', 'en']).default('fr'),
  })
  .default({});

// ─── Channels ─────────────────────────────────────────────────────────────────
// Séparation fondamentale : listener (sources non fiables) vs personal (owner-only).

const ContextWindowSchema = z.object({
  waitMs: z.number().min(500).max(300_000).default(30_000),
  maxMessages: z.number().min(1).max(20).default(5),
  resetOnMessage: z.boolean().default(true),
});

// Telegram listener — peut être un user token MTProto (v1) ou un bot company (v2)
const TelegramListenerSchema = z
  .object({
    /**
     * 'mtproto' = user token (ton propre compte Telegram, v1 solo)
     * 'bot'     = company bot (invité dans les channels partenaires, v2 entreprise)
     */
    mode: z.enum(['mtproto', 'bot']).default('mtproto'),
    /** Token du bot si mode='bot' */
    botToken: z.string().optional(),
    /** Chats à monitorer */
    monitoredChats: z
      .array(
        z.object({
          chatId: z.union([z.number(), z.string()]).transform(String),
          name: z.string(),
          tags: z.array(z.string()).default([]),
          isGroup: z.boolean().default(false),
        }),
      )
      .default([]),
    /** Chats ignorés (supprime les notifications de découverte) */
    ignoredChats: z.array(z.string()).default([]),
    /** Senders ignorés — par username (sans @) ou user ID. Leurs messages ne créent pas de tâches. */
    ignoredSenders: z.array(z.string()).default([]),
    /**
     * Notifie quand un nouveau chat inconnu envoie un message.
     * Crée une proposition pour l'ajouter aux chats monitorés.
     * Désactivé par défaut — opt-in si tu veux la découverte automatique.
     */
    discoverUnknownChats: z.boolean().default(false),
    /** Paramètres de la fenêtre de contexte */
    contextWindow: ContextWindowSchema.default({}),
  })
  .default({});

// Telegram personal — toujours un bot, accessible uniquement par le owner
const TelegramPersonalSchema = z
  .object({
    /** Token du bot Telegram personal */
    botToken: z.string().optional(),
    /** Telegram user IDs autorisés (doit contenir uniquement le owner) */
    allowedUsers: z.array(z.union([z.number(), z.string()]).transform(String)).default([]),
    /** Chat où envoyer les notifications et proposals (défaut: Saved Messages) */
    approvalChatId: z.union([z.number(), z.string()]).transform(String).default('me'),
  })
  .default({});

const TelegramChannelSchema = z
  .object({
    listener: TelegramListenerSchema,
    personal: TelegramPersonalSchema,
  })
  .default({});

// ─── Slack channel ────────────────────────────────────────────────────────────

const SlackMonitoredChannelSchema = z.object({
  channelId: z.string(),
  name: z.string(),
  tags: z.array(z.string()).default([]),
});

/** Listener — user token (xoxp- or xoxc-+cookie), read-only, sees all channels/DMs */
const SlackListenerSchema = z
  .object({
    enabled: z.boolean().default(false),
    monitoredChannels: z.array(SlackMonitoredChannelSchema).default([]),
    monitorDMs: z.boolean().default(true),
    /** Polling interval in seconds. Default: 300 (5 min). Keep high with xoxc- to avoid triggering presence signals. */
    pollIntervalSeconds: z.number().min(30).default(300),
    /**
     * Active listening window (local time, 24h). Polling is skipped outside this range.
     * Defaults: start=9 (09:00), end=22 (22:00). Set both to 0 to disable the filter.
     */
    activeHoursStart: z.number().min(0).max(23).default(9),
    activeHoursEnd: z.number().min(0).max(23).default(22),
  })
  .default({});

/** Personal bot — bot token (xoxb-), owner-only interactions + approval notifications */
const SlackPersonalSchema = z
  .object({
    /** Bot User OAuth Token (xoxb-...) */
    botToken: z.string().optional(),
    /** Channel ID where the bot listens and sends notifications (DM or private channel) */
    approvalChannelId: z.string().optional(),
    /** Slack user IDs allowed to issue commands (owner only). Empty = no auth check. */
    allowedUserIds: z.array(z.string()).default([]),
  })
  .default({});

const SlackChannelSchema = z
  .object({
    /** Legacy flat config — mapped to listener sub-object on load */
    enabled: z.boolean().default(false),
    monitoredChannels: z.array(SlackMonitoredChannelSchema).default([]),
    monitorDMs: z.boolean().default(true),
    pollIntervalSeconds: z.number().min(10).default(180),
    listener: SlackListenerSchema,
    personal: SlackPersonalSchema,
  })
  .default({});

// ─── Discord channel ──────────────────────────────────────────────────────────

const DiscordMonitoredChannelSchema = z.object({
  channelId: z.string(),
  name: z.string(),
  guildId: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

const DiscordChannelSchema = z
  .object({
    enabled: z.boolean().default(false),
    monitoredChannels: z.array(DiscordMonitoredChannelSchema).default([]),
    monitoredGuildIds: z.array(z.string()).default([]),
    monitorDMs: z.boolean().default(true),
  })
  .default({});

// ─── WhatsApp channel ─────────────────────────────────────────────────────────

const WhatsAppChannelSchema = z
  .object({
    /** JID (phone@s.whatsapp.net or group@g.us) to send approval notifications to */
    approvalJid: z.string().optional(),
  })
  .default({});

// ─── Signal channel ───────────────────────────────────────────────────────────
// Requires signal-cli sidecar (Java binary):
//   macOS: brew install signal-cli
//   Linux: https://github.com/AsamK/signal-cli/releases
//
// Register your number first:
//   signal-cli -a +YOURNUMBER register
//   signal-cli -a +YOURNUMBER verify CODE

const SignalChannelSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Path to signal-cli binary. Default: 'signal-cli' (must be on PATH) */
    signalCliBin: z.string().default('signal-cli'),
    /** Registered phone number, e.g. +33612345678 */
    phoneNumber: z.string(),
    /** Allowlist of sender phone numbers. Empty = allow all (NOT recommended) */
    allowedNumbers: z.array(z.string()).default([]),
    /** Unix socket path for JSON-RPC daemon. Default: /tmp/argos-signal.sock */
    socketPath: z.string().default('/tmp/argos-signal.sock'),
    /** signal-cli data directory (--config flag). Optional. */
    signalDataDir: z.string().optional(),
  })
  .optional();

// ─── Channels ─────────────────────────────────────────────────────────────────

const ChannelsSchema = z
  .object({
    telegram: TelegramChannelSchema,
    slack: SlackChannelSchema,
    discord: DiscordChannelSchema,
    whatsapp: WhatsAppChannelSchema,
    signal: SignalChannelSchema,
  })
  .default({});

// ─── Notifications ────────────────────────────────────────────────────────────
// Canal unique pour les notifications push (proposals, alertes, heartbeat).
// Séparé des réponses conversationnelles qui utilisent toujours le canal d'origine.

const NotificationsSchema = z
  .object({
    /** Master toggle — disable to silence all realtime notifications. */
    enabled: z.boolean().default(true),
    /** Minimum urgency level that triggers a notification. */
    minUrgency: z.enum(['low', 'medium', 'high']).default('high'),
    /**
     * Canal préféré pour les notifications push (proposals, alertes, heartbeat).
     * Si absent, Argos utilise la priorité automatique : telegram_bot > telegram > slack > whatsapp.
     * Les réponses conversationnelles ignorent ce réglage — elles répondent toujours sur le canal d'origine.
     */
    preferredChannel: z.enum(['telegram_bot', 'telegram', 'slack', 'whatsapp']).optional(),
  })
  .default({});

// ─── Owner ────────────────────────────────────────────────────────────────────

const OwnerSchema = z.object({
  name: z.string(),
  /** Bot identity name — used in system prompts via {{bot_name}}. Default: "Argos" */
  botName: z.string().default('Argos'),
  telegramUserId: z.number().optional(),
  teams: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]),
});

// ─── LLM providers ────────────────────────────────────────────────────────────

const ModelProviderSchema = z.object({
  name: z.string().optional(),
  api: z.enum(['anthropic', 'openai']).default('openai'),
  auth: z.enum(['api-key', 'bearer']).default('api-key'),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  models: z.array(z.string()).default([]),
  // OAuth tokens — used by callAnthropicBearerRaw to auto-refresh on expiry
  oauthAccess: z.string().optional(),
  oauthRefresh: z.string().optional(),
  oauthExpires: z.number().optional(),
});

const LlmSchema = z.object({
  activeProvider: z.string().default('anthropic'),
  activeModel: z.string().default('claude-opus-4-6'),
  thinking: z
    .object({
      planner: z.boolean().default(false),
      chat: z.boolean().default(false),
      heartbeat: z.boolean().default(false),
    })
    .default({}),
  askOwner: z.boolean().default(true),
  fallbackProvider: z.string().optional(),
  fallbackModel: z.string().optional(),
  providers: z.record(z.string(), ModelProviderSchema).default({
    anthropic: {
      name: 'Anthropic',
      api: 'anthropic',
      auth: 'api-key',
      models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    },
  }),
});

// ─── Memory ───────────────────────────────────────────────────────────────────

const MemorySchema = z.object({
  defaultTtlDays: z.number().min(1).max(365).default(7),
  archiveTtlDays: z.number().min(1).max(3650).default(365),
  purgeIntervalHours: z.number().min(1).max(168).default(24),
  autoArchiveThreshold: z.number().min(0).max(10).default(8),
});

// ─── Anonymizer ───────────────────────────────────────────────────────────────

const AnonymizerSchema = z.object({
  mode: z.enum(['regex', 'none']).default('regex'),
  knownPersons: z.array(z.string()).default([]),
  bucketAmounts: z.boolean().default(true),
  /**
   * URL of the GLiNER NER server (gliner_server.py).
   * When set, GLiNER replaces the LLM second-pass anonymizer — faster, no hallucinations.
   * Example: "http://127.0.0.1:7688"
   */
  glinerUrl: z.string().url().optional(),
  /**
   * Anonymize blockchain-style identifiers (ETH/BTC addresses, tx hashes, ENS names).
   * Default: false — identifiers are kept so Claude can reason about them for
   * whitelisting and review. Set to true for privacy-first deployments
   * where you don't need identifier-level reasoning.
   */
  anonymizeCryptoAddresses: z.boolean().default(false),
  customPatterns: z
    .array(
      z.object({
        pattern: z.string(),
        replacement: z.string(),
      }),
    )
    .default([]),
});

// ─── Knowledge ────────────────────────────────────────────────────────────────

const KnowledgeSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('notion'),
    name: z.string(),
    pageId: z.string(),
    sourceType: z.enum(['page', 'database', 'workspace']).default('page'),
    refreshHours: z.number().default(24),
  }),
  z.object({
    type: z.literal('github'),
    name: z.string().optional(),
    owner: z.string(),
    repo: z.string(),
    paths: z.array(z.string()).default(['README.md']),
    refreshHours: z.number().default(168), // 7 jours
  }),
  z.object({
    type: z.literal('url'),
    name: z.string(),
    url: z.string(),
    refreshHours: z.number().default(168),
  }),
  z.object({
    type: z.literal('linear'),
    name: z.string(),
    teamId: z.string(),
    refreshHours: z.number().default(6),
  }),
  z.object({
    type: z.literal('google-drive'),
    name: z.string(),
    /** Drive folder ID — fetch all readable files inside */
    folderId: z.string().optional(),
    /** Specific file IDs to fetch (instead of or in addition to a folder) */
    fileIds: z.array(z.string()).default([]),
    refreshHours: z.number().default(24),
  }),
  z.object({
    type: z.literal('file'),
    name: z.string(),
    filePath: z.string(),
    refreshHours: z.number().default(168),
  }),
  z.object({
    type: z.literal('local'),
    name: z.string(),
    /** Glob patterns or exact paths, relative to HOME or absolute */
    paths: z.array(z.string()),
    refreshHours: z.number().default(6),
  }),
  z.object({
    type: z.literal('github-issues'),
    name: z.string(),
    /** If omitted, fetches across all repos for the authenticated user */
    owner: z.string().optional(),
    repo: z.string().optional(),
    refreshHours: z.number().default(12),
  }),
]);

const KnowledgeSchema = z
  .object({
    sources: z.array(KnowledgeSourceSchema).default([]),
    /**
     * true  (défaut) → embeddings locaux (Ollama nomic-embed-text), zéro cloud
     * false → embeddings OpenAI/Anthropic (opt-in explicite, user assume)
     */
    indexLocally: z.boolean().default(true),
    /** Fréquence de refresh global en heures (override par source) */
    refreshHours: z.number().default(6),
  })
  .default({});

// ─── MCP servers ──────────────────────────────────────────────────────────────

const McpServerSchema = z.object({
  name: z.string(),
  type: z.enum(['url', 'stdio']),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  authorizationToken: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  toolPolicy: z
    .object({
      default: z.enum(['allow', 'approve', 'block']).default('approve'),
    })
    .catchall(z.enum(['allow', 'approve', 'block']))
    .optional(),
});

// ─── Skills ───────────────────────────────────────────────────────────────────

const SkillConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
});

// ─── Notion ───────────────────────────────────────────────────────────────────

const NotionSchema = z.object({
  apiKey: z.string(),
  agentDatabaseId: z.string(),
  ownerDatabaseId: z.string().optional(),
  mode: z.enum(['agent', 'owner', 'both']).default('agent'),
  /** Databases scanned by the notion-todo-tracker cron */
  todoDatabaseIds: z.array(z.string()).default([]),
  /** Recursion depth for the knowledge connector when fetching pages with sub-pages */
  recursionDepth: z.number().int().min(0).max(5).default(3),
  /** Notion stagnating-todo tracker cron config */
  todoTracker: z
    .object({
      enabled: z.boolean().default(false),
      cronExpression: z.string().default('0 9 * * *'),
      stagnationDays: z.number().int().min(1).max(30).default(7),
      priorityKeywords: z
        .array(z.string())
        .default(['P1', 'High', 'Élevée', 'Urgent']),
      statusDoneKeywords: z
        .array(z.string())
        .default(['Done', 'Terminé', 'Fini', 'Completed']),
      maxAlerts: z.number().int().min(1).max(50).default(10),
    })
    .default({}),
});

// ─── Linear ───────────────────────────────────────────────────────────────────

const LinearSchema = z.object({
  apiKey: z.string(),
});

// ─── Calendar ─────────────────────────────────────────────────────────────────

const CalendarSchema = z.object({
  credentials: z.object({
    clientId: z.string(),
    clientSecret: z.string(),
    refreshToken: z.string(),
  }),
  calendarId: z.string().default('primary'),
});

// ─── Google Drive ─────────────────────────────────────────────────────────────

const GoogleDriveSchema = z.object({
  /**
   * Path to the service account JSON key file downloaded from GCP Console.
   * The service account must have read access to the shared folders/files.
   */
  serviceAccountKeyPath: z.string(),
});

// ─── Cloudflare Tunnel ────────────────────────────────────────────────────────
// Expose the approval web app via Cloudflare Tunnel — no open ports on the VPS,
// no public IP needed. Only the outbound cloudflared process needs to run.

const CloudflareTunnelSchema = z.object({
  /**
   * Tunnel token from Cloudflare dashboard (Networks → Tunnels → Create tunnel).
   * Run:  cloudflared tunnel run --token <TOKEN>
   */
  token: z.string(),
  /**
   * Public hostname for the approval web app, e.g. argos.yourdomain.com
   * Must be configured in the Cloudflare Tunnel routing rules.
   */
  hostname: z.string(),
  /** Local port the approval web app listens on (defaults to webapp.port or 3000) */
  localPort: z.number().default(3000),
  enabled: z.boolean().default(true),
});

const CloudflareSchema = z.object({
  tunnel: CloudflareTunnelSchema.optional(),
});

// ─── SMTP (email sending) ─────────────────────────────────────────────────────

const SmtpSchema = z.object({
  /** SMTP host — e.g. smtp.gmail.com, smtp.office365.com */
  host: z.string(),
  port: z.number().default(587),
  secure: z.boolean().default(false), // true = port 465, false = STARTTLS
  user: z.string(),
  password: z.string(),
  /** From address — defaults to user if not set */
  from: z.string().optional(),
  /** Display name shown in From header */
  fromName: z.string().optional(),
});

// ─── User-defined agents ──────────────────────────────────────────────────────

const AgentDefinitionSchema = z.object({
  /** Unique identifier — used as tool name by the planner. snake_case, no spaces. */
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'Agent name must be snake_case'),
  /** One-line description shown to the planner when choosing tools */
  description: z.string(),
  /** Full system prompt for this agent */
  systemPrompt: z.string(),
  /**
   * Tools this agent can use.
   * Use "*" to allow all BUILTIN_TOOLS.
   * Or list specific tool names: ["web_search", "fetch_url", "semantic_search"]
   * Other registered skills (e.g. "verify_protocol_address") can also be listed.
   */
  tools: z.array(z.string()).default(['web_search', 'fetch_url', 'semantic_search']),
  maxIterations: z.number().default(8),
  temperature: z.number().default(0.3),
  maxTokens: z.number().default(2048),
  /** If true, the agent is available to the planner as a tool */
  enabled: z.boolean().default(true),
  /**
   * Channel refs that route directly to this agent (bypass planner).
   * Format: "<channel_type>:<chatId>"
   * Examples: "telegram:-1001234567890", "slack:C0123ABCD", "whatsapp:33612345678@s.whatsapp.net"
   */
  linkedChannels: z.array(z.string()).default([]),
  /**
   * Trigger conditions — when matched, agent runs automatically before the planner
   * and its output is injected into the planner context.
   * All conditions within one trigger object are ANDed.
   * Multiple trigger objects are ORed.
   */
  triggers: z
    .array(
      z.object({
        /** Keywords to match in the anonymized message text (case-insensitive, any match = true) */
        keywords: z.array(z.string()).default([]),
        /** Classification categories that activate this trigger */
        categories: z.array(z.string()).default([]),
        /** Only activate for messages from these channel types: "telegram", "slack", "whatsapp", "email" */
        channels: z.array(z.string()).default([]),
        /** Min importance score (0-10) from classifier */
        minImportance: z.number().default(0),
      }),
    )
    .default([]),
  /**
   * LLM provider key (must match a key in config.llm.providers).
   * If omitted, uses the global activeProvider.
   * Examples: "anthropic", "openai", "ollama", "mistral"
   */
  provider: z.string().optional(),
  /**
   * Model name for this agent.
   * If omitted, uses the provider's default/active model.
   * Examples: "claude-opus-4-6", "gpt-4o", "llama3:8b", "mistral-medium"
   */
  model: z.string().optional(),
  /**
   * Isolated workspace — memories stored by this agent are tagged agent:<name>
   * and semantic search is scoped to this namespace by default.
   * Set to false to share the global memory pool.
   */
  isolatedWorkspace: z.boolean().default(true),
});

// ─── Web app ──────────────────────────────────────────────────────────────────

const WebAppSchema = z.object({
  port: z.number().default(3000),
  webauthnRpId: z.string().default('localhost'),
  webauthnOrigin: z.string().default('http://localhost:3000'),
  tlsCert: z.string().optional(),
  tlsKey: z.string().optional(),
});

// ─── Embeddings ───────────────────────────────────────────────────────────────

const EmbeddingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().default('http://localhost:11434'),
    model: z.string().default('nomic-embed-text'),
    apiKey: z.string().optional(),
  })
  .default({});

// ─── Heartbeat ────────────────────────────────────────────────────────────────

const HeartbeatSchema = z.object({
  enabled: z.boolean().default(false),
  intervalMinutes: z.number().min(5).default(120),
  prompt: z.string().optional(),
});

// ─── Approval ─────────────────────────────────────────────────────────────────

const ApprovalSchema = z.object({
  defaultExpiryMs: z
    .number()
    .min(60_000)
    .max(86_400_000)
    .default(30 * 60 * 1000), // 1min–24h
  criticalExpiryMs: z
    .number()
    .min(60_000)
    .max(3_600_000)
    .default(10 * 60 * 1000), // 1min–1h
  doubleTapCritical: z.boolean().default(true),
});

// ─── Claude (legacy — gardé pour compat, préférer llm.*) ──────────────────────

const ClaudeSchema = z.object({
  model: z.string().default('claude-opus-4-6'),
  maxTokens: z.number().min(256).max(200_000).default(4096),
  maxIterations: z.number().min(1).max(50).default(12),
  classificationTemperature: z.number().min(0).max(2).default(0),
  planningTemperature: z.number().min(0).max(2).default(0.3),
  /**
   * Instructions personnalisées ajoutées à la fin du system prompt du planner et du heartbeat.
   * Utilisez ça pour des règles métier spécifiques à votre usage — whitelist, workflows, priorités.
   * Ces instructions ne sont PAS partagées avec le classifier ni avec les autres rôles.
   */
  customInstructions: z.string().optional(),
});

// ─── Wallet ───────────────────────────────────────────────────────────────────

const ChainConfigSchema = z.union([
  // EVM chain (has chainId)
  z.object({
    rpc: z.string(),
    chainId: z.number(),
    symbol: z.string().default('ETH'),
    explorer: z.string().optional(),
  }),
  // Solana / non-EVM (no chainId)
  z.object({
    rpc: z.string(),
    symbol: z.string().default('SOL'),
  }),
]);

const WalletSchema = z.object({
  /** Enable the bot hot wallet */
  enabled: z.boolean().default(false),
  /** Monitor incoming transactions to the bot wallet */
  monitor: z
    .object({
      enabled: z.boolean().default(false),
      pollIntervalSeconds: z.number().min(10).default(300),
      /** Also alert on native coin (ETH, MATIC, SOL…) balance increases */
      watchNative: z.boolean().default(true),
      /** ERC-20 / SPL tokens to watch for incoming transfers */
      watchTokens: z
        .array(
          z.object({
            address: z.string(),
            symbol: z.string(),
            decimals: z.number().default(18),
          }),
        )
        .default([]),
    })
    .default({}),
  /**
   * AES-256-GCM key derivation secret.
   * Generate: openssl rand -base64 32
   * Treat like a private key — never commit, never log.
   */
  encryptionSecret: z.string(),
  /** Chain configs. Key = chain name used in propose_tx tool (e.g. "ethereum", "base"). */
  chains: z.record(ChainConfigSchema).default({}),
  limits: z
    .object({
      /** Max value per tx in native token ("1.0" = 1 ETH). No limit if unset. */
      maxTxValueNative: z.string().optional(),
      /** Max cumulative daily spend in native token. No limit if unset. */
      dailyLimitNative: z.string().optional(),
      /** Require elevated YubiKey auth for every signing (default: true). */
      requireElevatedAuth: z.boolean().default(true),
      /**
       * Address whitelist — if non-empty, ONLY these addresses can receive funds.
       * EVM addresses are compared case-insensitively.
       * Solana addresses are compared exactly.
       * If empty or unset: no whitelist restriction.
       */
      whitelist: z.array(z.string()).default([]),
    })
    .default({}),
});

// ─── Secrets ──────────────────────────────────────────────────────────────────

const SecretsSchema = z.record(z.string()).default({});

// ─── Voice I/O ────────────────────────────────────────────────────────────────
// Transcription (Whisper) + TTS (OpenAI / ElevenLabs).
// Disabled by default — explicit opt-in required (voice.enabled: true).
// Audio bytes are NEVER persisted; transcripts flow through the normal pipeline.

const VoiceSchema = z
  .object({
    enabled: z.boolean().default(false),
    // Transcription
    whisperBackend: z.enum(['api', 'local']).default('local'),
    whisperEndpoint: z.string().default('https://api.openai.com/v1'),
    whisperApiKey: z.string().optional(),
    whisperModel: z.string().default('base'),
    // TTS
    ttsEnabled: z.boolean().default(false),
    ttsProvider: z.enum(['openai', 'elevenlabs', 'local']).default('local'),
    openAiTtsApiKey: z.string().optional(),
    openAiTtsModel: z.string().default('tts-1'),
    openAiTtsVoice: z.string().default('onyx'),
    elevenLabsApiKey: z.string().optional(),
    elevenLabsVoiceId: z.string().optional(),
    /** Local TTS voice name — macOS: `say -v ?` to list, Windows: system default */
    localTtsVoice: z.string().optional(),
    /** Language for TTS — auto-selects local voice + ElevenLabs language */
    ttsLanguage: z.string().default('fr'),
    /** Immersive Experience — unlocks display + audio effects */
    immersive: z.boolean().default(false),
    display: z
      .object({
        botName: z.string().default('Argos'),
        logoUrl: z.string().optional(),
        accentColor: z.string().default('#4f6eff'),
        port: z.number().default(3005),
        /** Show animated star field background */
        stars: z.boolean().default(false),
      })
      .default({}),
    /** Audio effects (applied on Argos Display output) */
    effects: z
      .object({
        /** Reverb wet mix 0-100 */
        reverb: z.number().min(0).max(100).default(0),
        /** Delay wet mix 0-100 */
        delay: z.number().min(0).max(100).default(0),
        /** Delay time in seconds */
        delayTime: z.number().min(0).max(2).default(0.3),
      })
      .default({}),
    /** Per-trigger voice output — each trigger can independently route to off/machine/channel/webspeak/both/all */
    ttsTriggers: z
      .object({
        always: z.enum(['off', 'machine', 'channel', 'webspeak', 'both', 'all']).default('off'),
        onVoiceMessage: z
          .enum(['off', 'machine', 'channel', 'webspeak', 'both', 'all'])
          .default('channel'),
        onTask: z.enum(['off', 'machine', 'channel', 'webspeak', 'both', 'all']).default('off'),
        onAlert: z.enum(['off', 'machine', 'channel', 'webspeak', 'both', 'all']).default('off'),
        onTodo: z.enum(['off', 'machine', 'channel', 'webspeak', 'both', 'all']).default('off'),
        onBriefing: z.enum(['off', 'machine', 'channel', 'webspeak', 'both', 'all']).default('off'),
      })
      .default({}),
  })
  .optional();

// ─── Knowledge graph ─────────────────────────────────────────────────────────

const KnowledgeGraphSchema = z
  .object({
    enabled: z.boolean().default(false),
    minImportance: z.number().default(5), // only extract for important messages
  })
  .optional();

// ─── Orchestration ────────────────────────────────────────────────────────────
// Controls multi-agent spawn_agent behaviour.
// The spawn_agent builtin tool is always available — this section lets you
// tune limits without touching code.

const OrchestrationSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxSubAgents: z.number().default(5),
    timeoutSeconds: z.number().default(90),
  })
  .optional();

// ─── Shell exec ───────────────────────────────────────────────────────────────

const ShellExecSchema = z
  .object({
    enabled: z.boolean().default(false),
    allowedCommands: z.array(z.string()).default([]),
    workingDir: z.string().optional(),
  })
  .optional();

// ─── Security ────────────────────────────────────────────────────────────────

const SecuritySchema = z
  .object({
    /**
     * Cloud mode — force YubiKey (FIDO2) for ALL risk levels, including low.
     * Enable this when Argos runs on a remote server (VPS, cloud).
     * In local mode (default), low-risk proposals can be approved via Telegram.
     * In cloud mode, Telegram approval is fully disabled — web app + YubiKey only.
     */
    cloudMode: z.boolean().default(false),
  })
  .default({});

// ─── Root config ──────────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  // Channels — listener (sources non fiables) + personal (owner-only)
  channels: ChannelsSchema,
  // Privacy — première classe, routing LLM par rôle
  privacy: PrivacySchema,
  // Triage — core, channel-agnostic
  triage: TriageSchema,
  todoExtraction: TodoExtractionSchema,
  briefing: BriefingSchema,
  // Heartbeat — proactivité générique
  heartbeat: HeartbeatSchema.default({}),
  // Knowledge — sources de l'espace de travail
  knowledge: KnowledgeSchema,
  // Addons — opaque configuration bag for personal addons in src/addons/.
  // Each addon reads its own subkey. Schema is intentionally permissive
  // (passthrough) so user addons can carry arbitrary config without forcing
  // a schema migration. Excluded from public Argos build.
  addons: z.record(z.string(), z.unknown()).default({}),
  // LLM providers
  llm: LlmSchema.default({}),
  // Web app
  webapp: WebAppSchema.default({}),
  // Secrets — injectés dans process.env au démarrage
  secrets: SecretsSchema,
  owner: OwnerSchema,
  claude: ClaudeSchema.default({}),
  memory: MemorySchema.default({}),
  anonymizer: AnonymizerSchema.default({}),
  approval: ApprovalSchema.default({}),
  notion: NotionSchema.optional(),
  linear: LinearSchema.optional(),
  calendar: CalendarSchema.optional(),
  wallet: WalletSchema.optional(),
  googleDrive: GoogleDriveSchema.optional(),
  cloudflare: CloudflareSchema.optional(),
  notifications: NotificationsSchema,
  agents: z.array(AgentDefinitionSchema).default([]),
  smtp: SmtpSchema.optional(),
  // MCP servers — tools externes disponibles au planner
  mcpServers: z.array(McpServerSchema).default([]),
  // Skills built-in
  skills: z.array(SkillConfigSchema).default([]),
  // Embeddings (local, pour vector search)
  embeddings: EmbeddingsSchema,
  // Shell exec — whitelisted commands, always requires approval
  shellExec: ShellExecSchema,
  // Orchestration — multi-agent spawn_agent config (disabled by default)
  orchestration: OrchestrationSchema,
  // Voice I/O — Whisper transcription + optional TTS reply (opt-in)
  voice: VoiceSchema,
  knowledgeGraph: KnowledgeGraphSchema,
  security: SecuritySchema,
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('debug'),
  dataDir: z.string().default('~/.argos'),
  readOnly: z.boolean().default(true),
  /**
   * Full autonomous mode — bypass approval gateway entirely.
   * ALL planner actions auto-execute (drafts sent, scripts run, messages sent, etc.)
   * No human gate. Use with extreme caution. Default: false.
   */
  autonomousMode: z.boolean().default(false),

  // ─── Backward compat ───────────────────────────────────────────────────────
  // Gardé temporairement pour éviter de casser les configs existantes.
  // À supprimer en v2.

  /** @deprecated utiliser channels.telegram.listener.monitoredChats */
  telegram: z
    .object({
      monitoredChats: z
        .array(
          z.object({
            chatId: z.union([z.number(), z.string()]).transform(String),
            name: z.string(),
            tags: z.array(z.string()).default([]),
            isGroup: z.boolean().default(false),
          }),
        )
        .optional(),
      ignoredChats: z.array(z.string()).optional(),
      approvalChatId: z.union([z.number(), z.string()]).transform(String).optional(),
      contextWindow: ContextWindowSchema.optional(),
      triage: z.unknown().optional(), // ignoré, utiliser root triage
    })
    .optional(),

  /** @deprecated utiliser knowledge.sources */
  context: z
    .object({
      urls: z.array(z.unknown()).default([]),
      github: z.array(z.unknown()).default([]),
      notion: z.array(z.unknown()).default([]),
    })
    .optional(),
});

// ─── Types exportés ───────────────────────────────────────────────────────────

export type Config = z.infer<typeof ConfigSchema>;
export type SecurityConfig = z.infer<typeof SecuritySchema>;
export type PrivacyConfig = z.infer<typeof PrivacySchema>;
export type PrivacyRole = z.infer<typeof PrivacyRoleSchema>;
export type TriageConfig = z.infer<typeof TriageSchema>;
export type TriageTeam = z.infer<typeof TriageTeamSchema>;
export type ChannelsConfig = z.infer<typeof ChannelsSchema>;
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;
export type KnowledgeConfig = z.infer<typeof KnowledgeSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
export type SkillConfig = z.infer<typeof SkillConfigSchema>;
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export type EmbeddingsConfig = z.infer<typeof EmbeddingsSchema>;
export type AnonymizerConfig = z.infer<typeof AnonymizerSchema>;
export type OrchestrationConfig = z.infer<typeof OrchestrationSchema>;

// Legacy — gardé pour compat avec le code existant
/** @deprecated utiliser ChannelsConfig */
export type MonitoredChat = { chatId: string; name: string; tags: string[]; isGroup: boolean };
/** @deprecated */
export type PartnerChannel = MonitoredChat;
export type OwnerConfig = z.infer<typeof OwnerSchema>;

// Compat — certains imports utilisent encore ces types de context/
/** @deprecated utiliser KnowledgeSource avec type='url' */
export type ContextUrl = { url: string; name: string; refreshDays: number };
/** @deprecated utiliser KnowledgeSource avec type='github' */
export type ContextGitHub = {
  owner: string;
  repo: string;
  paths: string[];
  name?: string;
  refreshDays: number;
};
/** @deprecated utiliser KnowledgeSource avec type='notion' */
export type ContextNotion = { pageId: string; name: string; type: string; refreshDays: number };
