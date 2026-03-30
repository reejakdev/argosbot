import { z } from 'zod';

const MonitoredChatSchema = z.object({
  chatId: z.union([z.number(), z.string()]).transform(String),
  name:   z.string(),
  tags:   z.array(z.string()).default([]),
  isGroup: z.boolean().default(false),
});

const ContextWindowSchema = z.object({
  // How long to wait (ms) for follow-up messages before processing
  waitMs: z.number().default(30_000),
  // Maximum messages to batch in a single context window
  maxMessages: z.number().default(5),
  // Reset the timer on each new message in the window
  resetOnMessage: z.boolean().default(true),
});

const TelegramSchema = z.object({
  // MTProto credentials go in env vars (TELEGRAM_API_ID, TELEGRAM_API_HASH)
  // Chats to monitor — each entry maps a chatId to a display name
  monitoredChats: z.array(MonitoredChatSchema).default([]),
  // Chats permanently ignored by the discovery system
  ignoredChats: z.array(z.string()).default([]),
  // Where approval proposals are sent — defaults to 'me' (Saved Messages)
  approvalChatId: z.union([z.number(), z.string()]).transform(String).default('me'),
  contextWindow: ContextWindowSchema.default({}),
});

const OwnerSchema = z.object({
  name: z.string(),
  // Your Telegram user ID — used to filter "is this addressed to me"
  telegramUserId: z.number().optional(),
  // Your team memberships, used for task routing
  // e.g. ['product', 'solution-engineer']
  teams: z.array(z.string()).default([]),
  // Your specific roles
  roles: z.array(z.string()).default([]),
});

const ClaudeSchema = z.object({
  model: z.string().default('claude-opus-4-6'),
  maxTokens: z.number().default(4096),
  // Temperature for classification (lower = more deterministic)
  classificationTemperature: z.number().default(0),
  // Temperature for planning (slightly higher for creativity)
  planningTemperature: z.number().default(0.3),
});

const MemorySchema = z.object({
  defaultTtlDays: z.number().default(7),
  archiveTtlDays: z.number().default(365),
  // How often (hours) to run the TTL purge cron
  purgeIntervalHours: z.number().default(24),
  // Min importance score (0–10) to auto-archive instead of expire
  autoArchiveThreshold: z.number().default(8),
});

const AnonymizerSchema = z.object({
  // 'regex' = fast local anonymization, 'none' = skip (not recommended)
  mode: z.enum(['regex', 'none']).default('regex'),
  // Known personal names to always replace (populated from config)
  knownPersons: z.array(z.string()).default([]),
  // Known blockchain addresses to always replace
  knownAddresses: z.array(z.string()).default([]),
  // Replace exact amounts with buckets (<10k / 10k-100k / >100k)
  bucketAmounts: z.boolean().default(true),
  // Custom regex patterns to redact  { pattern: string, replacement: string }
  customPatterns: z.array(z.object({
    pattern: z.string(),
    replacement: z.string(),
  })).default([]),
});

// ─── MCP servers ─────────────────────────────────────────────────────────────

const McpServerSchema = z.object({
  name:               z.string(),
  // 'url'   = remote SSE server (passed directly to Anthropic API)
  // 'stdio' = local subprocess (Argos manages lifecycle)
  type:               z.enum(['url', 'stdio']),
  // For type='url': the MCP server SSE endpoint
  url:                z.string().optional(),
  // For type='stdio': command + args to launch the server
  command:            z.string().optional(),
  args:               z.array(z.string()).default([]),
  env:                z.record(z.string()).default({}),
  // Optional Bearer token for 'url' servers
  authorizationToken: z.string().optional(),
  // Human description shown in setup
  description:        z.string().optional(),
  enabled:            z.boolean().default(true),
});

// ─── Skills ───────────────────────────────────────────────────────────────────

const SkillConfigSchema = z.object({
  // Built-in skill name — must match registry key
  name:    z.string(),
  enabled: z.boolean().default(true),
  // Per-skill config (API keys, options, etc.)
  config:  z.record(z.unknown()).default({}),
});

// ─── Context sources ──────────────────────────────────────────────────────────

const ContextUrlSchema = z.object({
  url:         z.string(),
  name:        z.string(),                    // human label, used as memory tag
  refreshDays: z.number().default(7),         // how often to re-fetch
});

const ContextGitHubSchema = z.object({
  owner:       z.string(),                    // github.com/owner
  repo:        z.string(),                    // /repo
  // paths to fetch (default: README.md + top-level .md files)
  paths:       z.array(z.string()).default(['README.md']),
  name:        z.string().optional(),         // defaults to owner/repo
  refreshDays: z.number().default(7),
});

const ContextNotionSchema = z.object({
  pageId:      z.string(),                    // Notion page or database ID
  name:        z.string(),
  type:        z.enum(['page', 'database', 'workspace']).default('page'),
  refreshDays: z.number().default(1),         // Notion content changes often
});

const ContextSourcesSchema = z.object({
  urls:      z.array(ContextUrlSchema).default([]),
  github:    z.array(ContextGitHubSchema).default([]),
  notion:    z.array(ContextNotionSchema).default([]),
}).default({});

const NotionSchema = z.object({
  apiKey: z.string(),
  // Agent workspace database (tasks, notes, tx reviews)
  agentDatabaseId: z.string(),
  // Owner's personal workspace database (todos, personal notes)
  // When set, Argos can create/update items in YOUR workspace directly
  ownerDatabaseId: z.string().optional(),
  // 'agent'  = only write to agent workspace (default, safest)
  // 'owner'  = only write to owner workspace
  // 'both'   = can write to both
  mode: z.enum(['agent', 'owner', 'both']).default('agent'),
});

const CalendarSchema = z.object({
  credentials: z.object({
    clientId: z.string(),
    clientSecret: z.string(),
    refreshToken: z.string(),
  }),
  calendarId: z.string().default('primary'),
});

// ─── LLM model providers (multi-provider like OpenClaw) ──────────────────────

const ModelProviderSchema = z.object({
  /** Display name */
  name:     z.string().optional(),
  /** API type: anthropic (native SDK) | openai-compatible (OpenAI chat completions) */
  api:      z.enum(['anthropic', 'openai']).default('openai'),
  /** Auth method: api-key → x-api-key/Authorization key header, bearer → Authorization: Bearer (OAuth) */
  auth:     z.enum(['api-key', 'bearer']).default('api-key'),
  /** API key or OAuth token (stored here, not in .env) */
  apiKey:   z.string().optional(),
  /** Base URL for the API (required for non-default endpoints) */
  baseUrl:  z.string().optional(),
  /** Available models from this provider */
  models:   z.array(z.string()).default([]),
});

const LlmSchema = z.object({
  /** Active provider key — must match a key in `providers` */
  activeProvider: z.string().default('anthropic'),
  /** Active model from the active provider */
  activeModel:    z.string().default('claude-opus-4-6'),
  /** Fallback provider key — used when activeProvider fails (500, rate-limit, timeout) */
  fallbackProvider: z.string().optional(),
  /** Fallback model — defaults to first model in the fallback provider */
  fallbackModel:    z.string().optional(),
  /** Provider definitions — key is a unique slug */
  providers:      z.record(z.string(), ModelProviderSchema).default({
    anthropic: {
      name: 'Anthropic',
      api: 'anthropic',
      auth: 'api-key',
      models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    },
  }),
});

// ─── Web app ──────────────────────────────────────────────────────────────────

const WebAppSchema = z.object({
  port:           z.number().default(3000),
  webauthnRpId:   z.string().default('localhost'),
  webauthnOrigin: z.string().default('http://localhost:3000'),
  tlsCert:        z.string().optional(),
  tlsKey:         z.string().optional(),
});

// ─── Secrets (flat key-value — injected into process.env at startup) ──────────

const SecretsSchema = z.record(z.string()).default({});

const HeartbeatSchema = z.object({
  // Enable proactive heartbeat
  enabled:         z.boolean().default(false),
  // How often to pulse (minutes) — min 5, default 60
  intervalMinutes: z.number().min(5).default(60),
  // Custom instructions injected into every heartbeat prompt
  // e.g. "Focus on open tx_request tasks older than 24h"
  prompt:          z.string().optional(),
});

const ApprovalSchema = z.object({
  // Default TTL for approval requests (ms)
  defaultExpiryMs: z.number().default(30 * 60 * 1000),       // 30min
  // TTL for high-risk actions
  criticalExpiryMs: z.number().default(10 * 60 * 1000),      // 10min
  // Require double confirmation for high-risk actions
  doubleTapCritical: z.boolean().default(true),
});

export const ConfigSchema = z.object({
  // LLM provider config
  llm: LlmSchema.default({}),
  // Web app (port, WebAuthn, TLS)
  webapp: WebAppSchema.default({}),
  // Secrets — API keys, tokens. Injected into process.env at startup.
  // Stored in ~/.argos/config.json (chmod 600) — never in project .env.
  secrets: SecretsSchema,
  owner: OwnerSchema,
  telegram: TelegramSchema,
  claude: ClaudeSchema.default({}),
  memory: MemorySchema.default({}),
  anonymizer: AnonymizerSchema.default({}),
  approval: ApprovalSchema.default({}),
  notion: NotionSchema.optional(),
  calendar: CalendarSchema.optional(),
  // Persistent context sources — loaded at startup, used by planner
  context: ContextSourcesSchema,
  // MCP servers — tools made available to Claude in the planner
  mcpServers: z.array(McpServerSchema).default([]),
  // Built-in skills to enable
  skills: z.array(SkillConfigSchema).default([]),
  // Proactive heartbeat — Argos wakes up and checks if anything needs doing
  heartbeat: HeartbeatSchema.default({}),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('debug'),
  // Local data directory (DB, logs)
  dataDir: z.string().default('~/.argos'),
  // Read-only mode: workers never execute writes (draft only)
  readOnly: z.boolean().default(true),
});

export type Config = z.infer<typeof ConfigSchema>;
export type MonitoredChat = z.infer<typeof MonitoredChatSchema>;
/** @deprecated use MonitoredChat */
export type PartnerChannel = MonitoredChat;
export type OwnerConfig = z.infer<typeof OwnerSchema>;
export type AnonymizerConfig = z.infer<typeof AnonymizerSchema>;
export type ContextSources = z.infer<typeof ContextSourcesSchema>;
export type ContextUrl = z.infer<typeof ContextUrlSchema>;
export type ContextGitHub = z.infer<typeof ContextGitHubSchema>;
export type ContextNotion = z.infer<typeof ContextNotionSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
export type SkillConfig = z.infer<typeof SkillConfigSchema>;
