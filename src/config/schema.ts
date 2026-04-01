import { z } from 'zod';

// ─── Privacy ──────────────────────────────────────────────────────────────────
// Première classe dans le core — pas un plugin.
// Chaque rôle du pipeline peut être routé vers le LLM local (privacy) ou cloud (primary).

const PrivacyRoleSchema = z.enum(['privacy', 'primary']);

const PrivacySchema = z.object({
  /**
   * Provider local pour les rôles 'privacy' — ex: "ollama", "lmstudio"
   * Doit correspondre à une clé dans llm.providers.
   * Si absent, tous les rôles privacy tombent sur le primary.
   */
  provider: z.string().optional(),
  /** Modèle à utiliser pour le provider privacy (défaut: premier modèle du provider) */
  model:    z.string().optional(),
  /**
   * Routing par rôle — qui traite quoi.
   *   'privacy' = modèle local (zéro cloud egress pour le contenu)
   *   'primary' = modèle cloud (reçoit uniquement du contenu anonymisé)
   */
  roles: z.object({
    /**
     * Détection d'injection — envoie le contenu BRUT au LLM.
     * 'privacy' (local) = zero cloud egress (recommandé si LLM local disponible).
     * 'primary' (cloud) = plus fiable mais raw content part chez Anthropic.
     */
    sanitize:  PrivacyRoleSchema.default('privacy'),
    /** Classification du message — contenu partenaire, local par défaut */
    classify:  PrivacyRoleSchema.default('privacy'),
    /** Triage inbox — contenu partenaire, local par défaut */
    triage:    PrivacyRoleSchema.default('privacy'),
    /** Anonymisation LLM second pass — local obligatoire */
    llmAnon:   PrivacyRoleSchema.default('privacy'),
    /** Planning/raisonnement complexe — cloud, contenu anonymisé uniquement */
    plan:      PrivacyRoleSchema.default('primary'),
  }).default({}),
  /**
   * Persiste le contenu brut (pré-anonymisation) dans la colonne raw_content de memories.
   * Accessible uniquement via les fonctions de recherche avec includeRaw=true —
   * à utiliser exclusivement pour les LLM locaux (rôle 'privacy').
   * Désactivé par défaut — opt-in explicite requis.
   */
  storeRaw: z.boolean().default(false),
}).default({});

// ─── Triage ───────────────────────────────────────────────────────────────────
// Core — channel-agnostic. Opère sur RawMessage peu importe la source.

const TriageTeamSchema = z.object({
  name:        z.string(),
  handles:     z.array(z.string()).default([]),
  keywords:    z.array(z.string()).default([]),
  description: z.string().optional(),   // context hint for LLM routing
  isOwnTeam:   z.boolean().default(false), // true = internal team (not a partner)
});

const TriageSchema = z.object({
  enabled:           z.boolean().default(false),
  /** Handles qui te désignent toi — @username, prénom, etc. */
  myHandles:         z.array(z.string()).default([]),
  /** Teams à surveiller pour le routage team_task */
  watchedTeams:      z.array(TriageTeamSchema).default([]),
  /** Mots-clés déclenchant un tx_whitelist */
  whitelistKeywords: z.array(z.string()).default([
    'whitelist', 'add address', 'ajouter adresse', 'whitelist address',
    'can you add', 'pouvez-vous ajouter',
  ]),
  /** Si true : messages de l'équipe interne (isOwnTeam) ignorés sauf si @mention */
  ignoreOwnTeam:     z.boolean().default(true),
  /** Si true : triage uniquement si @mention explicite (pas de triage passif) */
  mentionOnly:       z.boolean().default(false),
  /** Database Notion cible pour les tâches créées (optionnel) */
  notionTodoDatabaseId: z.string().optional(),
}).default({});

// ─── Channels ─────────────────────────────────────────────────────────────────
// Séparation fondamentale : listener (sources non fiables) vs personal (owner-only).

const ContextWindowSchema = z.object({
  waitMs:         z.number().default(30_000),
  maxMessages:    z.number().default(5),
  resetOnMessage: z.boolean().default(true),
});

// Telegram listener — peut être un user token MTProto (v1) ou un bot company (v2)
const TelegramListenerSchema = z.object({
  /**
   * 'mtproto' = user token (ton propre compte Telegram, v1 solo)
   * 'bot'     = company bot (invité dans les channels partenaires, v2 entreprise)
   */
  mode:          z.enum(['mtproto', 'bot']).default('mtproto'),
  /** Token du bot si mode='bot' */
  botToken:      z.string().optional(),
  /** Chats à monitorer */
  monitoredChats: z.array(z.object({
    chatId:  z.union([z.number(), z.string()]).transform(String),
    name:    z.string(),
    tags:    z.array(z.string()).default([]),
    isGroup: z.boolean().default(false),
  })).default([]),
  /** Chats ignorés (supprime les notifications de découverte) */
  ignoredChats:  z.array(z.string()).default([]),
  /** Paramètres de la fenêtre de contexte */
  contextWindow: ContextWindowSchema.default({}),
}).default({});

// Telegram personal — toujours un bot, accessible uniquement par le owner
const TelegramPersonalSchema = z.object({
  /** Token du bot Telegram personal */
  botToken:      z.string().optional(),
  /** Telegram user IDs autorisés (doit contenir uniquement le owner) */
  allowedUsers:  z.array(z.union([z.number(), z.string()]).transform(String)).default([]),
  /** Chat où envoyer les notifications et proposals (défaut: Saved Messages) */
  approvalChatId: z.union([z.number(), z.string()]).transform(String).default('me'),
}).default({});

const TelegramChannelSchema = z.object({
  listener: TelegramListenerSchema,
  personal: TelegramPersonalSchema,
}).default({});

const ChannelsSchema = z.object({
  telegram: TelegramChannelSchema,
  // slack, discord, whatsapp, gmail — à venir
}).default({});

// ─── Owner ────────────────────────────────────────────────────────────────────

const OwnerSchema = z.object({
  name:           z.string(),
  telegramUserId: z.number().optional(),
  teams:          z.array(z.string()).default([]),
  roles:          z.array(z.string()).default([]),
});

// ─── LLM providers ────────────────────────────────────────────────────────────

const ModelProviderSchema = z.object({
  name:    z.string().optional(),
  api:     z.enum(['anthropic', 'openai']).default('openai'),
  auth:    z.enum(['api-key', 'bearer']).default('api-key'),
  apiKey:  z.string().optional(),
  baseUrl: z.string().optional(),
  models:  z.array(z.string()).default([]),
});

const LlmSchema = z.object({
  activeProvider:  z.string().default('anthropic'),
  activeModel:     z.string().default('claude-opus-4-6'),
  thinking: z.object({
    planner:   z.boolean().default(false),
    chat:      z.boolean().default(false),
    heartbeat: z.boolean().default(false),
  }).default({}),
  askOwner:        z.boolean().default(true),
  fallbackProvider: z.string().optional(),
  fallbackModel:    z.string().optional(),
  providers: z.record(z.string(), ModelProviderSchema).default({
    anthropic: {
      name:   'Anthropic',
      api:    'anthropic',
      auth:   'api-key',
      models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    },
  }),
});

// ─── Memory ───────────────────────────────────────────────────────────────────

const MemorySchema = z.object({
  defaultTtlDays:       z.number().default(7),
  archiveTtlDays:       z.number().default(365),
  purgeIntervalHours:   z.number().default(24),
  autoArchiveThreshold: z.number().default(8),
});

// ─── Anonymizer ───────────────────────────────────────────────────────────────

const AnonymizerSchema = z.object({
  mode:            z.enum(['regex', 'none']).default('regex'),
  knownPersons:    z.array(z.string()).default([]),
  // knownAddresses removed — crypto addresses are pseudonymous and no longer anonymized.
  bucketAmounts:   z.boolean().default(true),
  customPatterns:  z.array(z.object({
    pattern:     z.string(),
    replacement: z.string(),
  })).default([]),
});

// ─── Knowledge ────────────────────────────────────────────────────────────────

const KnowledgeSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type:         z.literal('notion'),
    name:         z.string(),
    pageId:       z.string(),
    sourceType:   z.enum(['page', 'database', 'workspace']).default('page'),
    refreshHours: z.number().default(24),
  }),
  z.object({
    type:         z.literal('github'),
    name:         z.string().optional(),
    owner:        z.string(),
    repo:         z.string(),
    paths:        z.array(z.string()).default(['README.md']),
    refreshHours: z.number().default(168),  // 7 jours
  }),
  z.object({
    type:         z.literal('url'),
    name:         z.string(),
    url:          z.string(),
    refreshHours: z.number().default(168),
  }),
  z.object({
    type:         z.literal('linear'),
    name:         z.string(),
    teamId:       z.string(),
    refreshHours: z.number().default(6),
  }),
  z.object({
    type:         z.literal('google-drive'),
    name:         z.string(),
    folderId:     z.string(),
    refreshHours: z.number().default(24),
  }),
  z.object({
    type:         z.literal('file'),
    name:         z.string(),
    filePath:     z.string(),
    refreshHours: z.number().default(168),
  }),
]);

const KnowledgeSchema = z.object({
  sources:      z.array(KnowledgeSourceSchema).default([]),
  /**
   * true  (défaut) → embeddings locaux (Ollama nomic-embed-text), zéro cloud
   * false → embeddings OpenAI/Anthropic (opt-in explicite, user assume)
   */
  indexLocally: z.boolean().default(true),
  /** Fréquence de refresh global en heures (override par source) */
  refreshHours: z.number().default(6),
}).default({});

// ─── MCP servers ──────────────────────────────────────────────────────────────

const McpServerSchema = z.object({
  name:               z.string(),
  type:               z.enum(['url', 'stdio']),
  url:                z.string().optional(),
  command:            z.string().optional(),
  args:               z.array(z.string()).default([]),
  env:                z.record(z.string()).default({}),
  authorizationToken: z.string().optional(),
  description:        z.string().optional(),
  enabled:            z.boolean().default(true),
});

// ─── Skills ───────────────────────────────────────────────────────────────────

const SkillConfigSchema = z.object({
  name:    z.string(),
  enabled: z.boolean().default(true),
  config:  z.record(z.unknown()).default({}),
});

// ─── Notion ───────────────────────────────────────────────────────────────────

const NotionSchema = z.object({
  apiKey:          z.string(),
  agentDatabaseId: z.string(),
  ownerDatabaseId: z.string().optional(),
  mode:            z.enum(['agent', 'owner', 'both']).default('agent'),
});

// ─── Calendar ─────────────────────────────────────────────────────────────────

const CalendarSchema = z.object({
  credentials: z.object({
    clientId:     z.string(),
    clientSecret: z.string(),
    refreshToken: z.string(),
  }),
  calendarId: z.string().default('primary'),
});

// ─── Web app ──────────────────────────────────────────────────────────────────

const WebAppSchema = z.object({
  port:           z.number().default(3000),
  webauthnRpId:   z.string().default('localhost'),
  webauthnOrigin: z.string().default('http://localhost:3000'),
  tlsCert:        z.string().optional(),
  tlsKey:         z.string().optional(),
});

// ─── Embeddings ───────────────────────────────────────────────────────────────

const EmbeddingsSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default('http://localhost:11434'),
  model:   z.string().default('nomic-embed-text'),
  apiKey:  z.string().optional(),
}).default({});

// ─── Heartbeat ────────────────────────────────────────────────────────────────

const HeartbeatSchema = z.object({
  enabled:         z.boolean().default(false),
  intervalMinutes: z.number().min(5).default(60),
  prompt:          z.string().optional(),
});

// ─── Approval ─────────────────────────────────────────────────────────────────

const ApprovalSchema = z.object({
  defaultExpiryMs:   z.number().default(30 * 60 * 1000),
  criticalExpiryMs:  z.number().default(10 * 60 * 1000),
  doubleTapCritical: z.boolean().default(true),
});

// ─── Claude (legacy — gardé pour compat, préférer llm.*) ──────────────────────

const ClaudeSchema = z.object({
  model:                     z.string().default('claude-opus-4-6'),
  maxTokens:                 z.number().default(4096),
  classificationTemperature: z.number().default(0),
  planningTemperature:       z.number().default(0.3),
});

// ─── Secrets ──────────────────────────────────────────────────────────────────

const SecretsSchema = z.record(z.string()).default({});

// ─── Root config ──────────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  // Channels — listener (sources non fiables) + personal (owner-only)
  channels:   ChannelsSchema,
  // Privacy — première classe, routing LLM par rôle
  privacy:    PrivacySchema,
  // Triage — core, channel-agnostic
  triage:     TriageSchema,
  // Heartbeat — proactivité générique
  heartbeat:  HeartbeatSchema.default({}),
  // Knowledge — sources internes de l'entreprise
  knowledge:  KnowledgeSchema,
  // LLM providers
  llm:        LlmSchema.default({}),
  // Web app
  webapp:     WebAppSchema.default({}),
  // Secrets — injectés dans process.env au démarrage
  secrets:    SecretsSchema,
  owner:      OwnerSchema,
  claude:     ClaudeSchema.default({}),
  memory:     MemorySchema.default({}),
  anonymizer: AnonymizerSchema.default({}),
  approval:   ApprovalSchema.default({}),
  notion:     NotionSchema.optional(),
  calendar:   CalendarSchema.optional(),
  // MCP servers — tools externes disponibles au planner
  mcpServers: z.array(McpServerSchema).default([]),
  // Skills built-in
  skills:     z.array(SkillConfigSchema).default([]),
  // Embeddings (local, pour vector search)
  embeddings: EmbeddingsSchema,
  logLevel:   z.enum(['debug', 'info', 'warn', 'error']).default('debug'),
  dataDir:    z.string().default('~/.argos'),
  readOnly:   z.boolean().default(true),

  // ─── Backward compat ───────────────────────────────────────────────────────
  // Gardé temporairement pour éviter de casser les configs existantes.
  // À supprimer en v2.

  /** @deprecated utiliser channels.telegram.listener.monitoredChats */
  telegram: z.object({
    monitoredChats: z.array(z.object({
      chatId:  z.union([z.number(), z.string()]).transform(String),
      name:    z.string(),
      tags:    z.array(z.string()).default([]),
      isGroup: z.boolean().default(false),
    })).optional(),
    ignoredChats:   z.array(z.string()).optional(),
    approvalChatId: z.union([z.number(), z.string()]).transform(String).optional(),
    contextWindow:  ContextWindowSchema.optional(),
    triage:         z.unknown().optional(),   // ignoré, utiliser root triage
  }).optional(),

  /** @deprecated utiliser knowledge.sources */
  context: z.object({
    urls:   z.array(z.unknown()).default([]),
    github: z.array(z.unknown()).default([]),
    notion: z.array(z.unknown()).default([]),
  }).optional(),
});

// ─── Types exportés ───────────────────────────────────────────────────────────

export type Config          = z.infer<typeof ConfigSchema>;
export type PrivacyConfig   = z.infer<typeof PrivacySchema>;
export type PrivacyRole     = z.infer<typeof PrivacyRoleSchema>;
export type TriageConfig    = z.infer<typeof TriageSchema>;
export type TriageTeam      = z.infer<typeof TriageTeamSchema>;
export type ChannelsConfig  = z.infer<typeof ChannelsSchema>;
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;
export type KnowledgeConfig = z.infer<typeof KnowledgeSchema>;
export type McpServer       = z.infer<typeof McpServerSchema>;
export type SkillConfig     = z.infer<typeof SkillConfigSchema>;
export type EmbeddingsConfig = z.infer<typeof EmbeddingsSchema>;
export type AnonymizerConfig = z.infer<typeof AnonymizerSchema>;

// Legacy — gardé pour compat avec le code existant
/** @deprecated utiliser ChannelsConfig */
export type MonitoredChat   = { chatId: string; name: string; tags: string[]; isGroup: boolean };
/** @deprecated */
export type PartnerChannel  = MonitoredChat;
export type OwnerConfig     = z.infer<typeof OwnerSchema>;

// Compat — certains imports utilisent encore ces types de context/
/** @deprecated utiliser KnowledgeSource avec type='url' */
export type ContextUrl    = { url: string; name: string; refreshDays: number };
/** @deprecated utiliser KnowledgeSource avec type='github' */
export type ContextGitHub = { owner: string; repo: string; paths: string[]; name?: string; refreshDays: number };
/** @deprecated utiliser KnowledgeSource avec type='notion' */
export type ContextNotion = { pageId: string; name: string; type: string; refreshDays: number };
