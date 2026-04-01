import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigSchema, type Config } from './schema.js';
import { createLogger } from '../logger.js';

const log = createLogger('config');

function resolvePath(p: string): string {
  if (p.startsWith('~')) {
    // path.join (not path.resolve) so that the leading / in ~/.x is not treated as absolute
    const resolved = path.join(os.homedir(), p.slice(1));
    if (!resolved.startsWith(os.homedir())) {
      throw new Error(`Path traversal detected in config path: ${p}`);
    }
    return resolved;
  }
  return path.resolve(p);
}

function loadConfigFile(configPath: string): unknown {
  const resolved = resolvePath(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}\nRun: npm run setup`);
  }
  const raw      = fs.readFileSync(resolved, 'utf-8');
  // Strip // comments but NOT inside strings (avoid breaking URLs like https://)
  const stripped = raw.replace(/("(?:[^"\\]|\\.)*")|\/\/.*$/gm, (match, str) => str ?? '');
  return JSON.parse(stripped);
}

function mergeEnv(config: Record<string, unknown>): Record<string, unknown> {
  // ─── Channels ────────────────────────────────────────────────────────────
  const channels  = (config.channels as Record<string, unknown>) ?? {};
  const tgChannel = (channels.telegram as Record<string, unknown>) ?? {};
  const tgPersonal = (tgChannel.personal as Record<string, unknown>) ?? {};
  if (process.env.TELEGRAM_BOT_TOKEN)      tgPersonal.botToken      = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_APPROVAL_CHAT_ID) tgPersonal.approvalChatId = process.env.TELEGRAM_APPROVAL_CHAT_ID;
  tgChannel.personal  = tgPersonal;
  channels.telegram   = tgChannel;
  config.channels     = channels;

  // ─── LLM / misc ──────────────────────────────────────────────────────────
  if (process.env.DATA_DIR)  config.dataDir  = process.env.DATA_DIR;
  if (process.env.LOG_LEVEL) config.logLevel = process.env.LOG_LEVEL;

  // ─── Notion ───────────────────────────────────────────────────────────────
  if (process.env.NOTION_API_KEY && process.env.NOTION_AGENT_DATABASE_ID) {
    config.notion = {
      ...(config.notion as object ?? {}),
      apiKey:          process.env.NOTION_API_KEY,
      agentDatabaseId: process.env.NOTION_AGENT_DATABASE_ID,
      ...(process.env.NOTION_OWNER_DATABASE_ID
        ? { ownerDatabaseId: process.env.NOTION_OWNER_DATABASE_ID, mode: 'both' }
        : {}),
    };
  }

  // ─── Calendar ─────────────────────────────────────────────────────────────
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
    config.calendar = {
      ...(config.calendar as object ?? {}),
      credentials: {
        clientId:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      },
      calendarId: process.env.GOOGLE_CALENDAR_ID ?? 'primary',
    };
  }

  return config;
}

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const configPath = process.env.CONFIG_PATH ?? '~/.argos/config.json';
  log.info(`Loading config from ${configPath}`);

  const raw    = loadConfigFile(configPath);
  const merged = mergeEnv(raw as Record<string, unknown>);

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    log.error('Invalid config', result.error.format());
    throw new Error('Config validation failed. Check your ~/.argos/config.json');
  }

  _config = result.data;

  // Inject secrets into process.env
  for (const [k, v] of Object.entries(_config.secrets)) {
    if (v && !process.env[k]) process.env[k] = v;
  }

  // Inject LLM + webapp values into process.env for backward compat
  const activeProvider = _config.llm.providers[_config.llm.activeProvider];
  if (_config.llm.activeProvider && !process.env.LLM_PROVIDER_ID)
    process.env.LLM_PROVIDER_ID = _config.llm.activeProvider;
  if (activeProvider) {
    if (!process.env.LLM_PROVIDER) process.env.LLM_PROVIDER = activeProvider.api === 'anthropic' ? 'anthropic' : 'compatible';
    if (!process.env.LLM_MODEL)    process.env.LLM_MODEL    = _config.llm.activeModel;
    if (activeProvider.baseUrl && !process.env.LLM_BASE_URL)  process.env.LLM_BASE_URL  = activeProvider.baseUrl;
    if (activeProvider.auth   && !process.env.LLM_AUTH_MODE)  process.env.LLM_AUTH_MODE = activeProvider.auth;
    if (activeProvider.apiKey) {
      const envKey = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' }[_config.llm.activeProvider] ?? 'LLM_API_KEY';
      if (!process.env[envKey]) process.env[envKey] = activeProvider.apiKey;
    }
  }
  if (!process.env.APP_PORT)       process.env.APP_PORT       = String(_config.webapp.port);
  if (!process.env.WEBAUTHN_RP_ID) process.env.WEBAUTHN_RP_ID = _config.webapp.webauthnRpId;
  if (!process.env.WEBAUTHN_ORIGIN) process.env.WEBAUTHN_ORIGIN = _config.webapp.webauthnOrigin;

  const monitoredCount = _config.channels.telegram.listener.monitoredChats.length;
  log.info('Config loaded', {
    owner:         _config.owner.name,
    teams:         _config.owner.teams,
    monitoredChats: monitoredCount,
    llm:           `${_config.llm.activeProvider}/${_config.llm.activeModel}`,
    privacy:       _config.privacy.provider ?? 'none (all roles → primary)',
    triage:        _config.triage.enabled,
    readOnly:      _config.readOnly,
  });

  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}

export function getEmbeddingsConfig(): import('./schema.js').EmbeddingsConfig | null {
  if (!_config?.embeddings?.enabled) return null;
  return _config.embeddings;
}

/** Patch la config live + persiste sur disque. Utilisé pour les mutations runtime. */
export function patchConfig(patch: (cfg: Config) => void): void {
  if (!_config) throw new Error('Config not loaded');
  patch(_config);
  const configPath = resolvePath(process.env.CONFIG_PATH ?? '~/.argos/config.json');
  fs.writeFileSync(configPath, JSON.stringify(_config, null, 2), 'utf-8');
}

/** Ajoute un chat à la liste monitorée et persiste. */
export function addMonitoredChat(chatId: string, name: string, isGroup = false, tags: string[] = []): void {
  patchConfig(cfg => {
    const chats = cfg.channels.telegram.listener.monitoredChats;
    if (!chats.some(c => c.chatId === chatId)) {
      chats.push({ chatId, name, tags, isGroup });
    }
  });
}

/** Supprime les notifications de découverte pour ce chatId. Persiste. */
export function ignoreChat(chatId: string): void {
  patchConfig(cfg => {
    const ignored = cfg.channels.telegram.listener.ignoredChats;
    if (!ignored.includes(chatId)) ignored.push(chatId);
  });
}

export function isIgnoredChat(chatId: string): boolean {
  if (!_config) return false;
  return _config.channels.telegram.listener.ignoredChats.includes(chatId);
}

export function getDataDir(): string {
  return resolvePath(getConfig().dataDir);
}

// ─── Template config pour le setup wizard ─────────────────────────────────────

export const CONFIG_TEMPLATE = {
  channels: {
    telegram: {
      listener: {
        mode: 'mtproto',
        monitoredChats: [
          { chatId: '-1001234567890', name: 'Partner Alpha', tags: ['#ops'], isGroup: true },
        ],
        ignoredChats: [],
      },
      personal: {
        botToken:      'YOUR_BOT_TOKEN',
        allowedUsers:  ['YOUR_TELEGRAM_USER_ID'],
        approvalChatId: 'me',
      },
    },
  },
  privacy: {
    provider: 'local',   // ex: clé dans llm.providers pointant sur Ollama
    roles: {
      sanitize: 'privacy',  // contenu brut → local de préférence
      classify: 'privacy',
      triage:   'privacy',
      plan:     'primary',
    },
  },
  triage: {
    enabled:   true,
    myHandles: ['@yourhandle'],
  },
  heartbeat: {
    enabled:         false,
    intervalMinutes: 60,
  },
  knowledge: {
    sources:      [],
    indexLocally: true,
    refreshHours: 6,
  },
  owner: {
    name:           'Emeric',
    telegramUserId: 0,
    teams:          ['product', 'solution-engineer'],
    roles:          ['solution-engineer'],
  },
  anonymizer: {
    mode:          'regex',
    knownPersons:  [],
    bucketAmounts: true,
  },
  readOnly: true,
  dataDir:  '~/.argos',
  logLevel: 'debug',
};
