import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigSchema, type Config } from './schema.js';
import { createLogger } from '../logger.js';

const log = createLogger('config');

function resolvePath(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function loadConfigFile(configPath: string): unknown {
  const resolved = resolvePath(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}\nRun: cp .env.example .env && edit ~/.argos/config.json`);
  }
  const raw = fs.readFileSync(resolved, 'utf-8');
  // Strip // comments but NOT inside strings (avoid breaking URLs like https://)
  const stripped = raw.replace(/("(?:[^"\\]|\\.)*")|\/\/.*$/gm, (match, str) => str ?? '');
  return JSON.parse(stripped);
}

function mergeEnv(config: Record<string, unknown>): Record<string, unknown> {
  // Allow environment variables to override config fields
  const tg = (config.telegram as Record<string, unknown>) ?? {};
  if (process.env.TELEGRAM_BOT_TOKEN) tg.botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_APPROVAL_CHAT_ID) tg.approvalChatId = process.env.TELEGRAM_APPROVAL_CHAT_ID;
  config.telegram = tg;

  const claude = (config.claude as Record<string, unknown>) ?? {};
  if (process.env.ANTHROPIC_API_KEY) {
    // stored separately, not in config object
  }
  config.claude = claude;

  if (process.env.DATA_DIR) config.dataDir = process.env.DATA_DIR;
  if (process.env.LOG_LEVEL) config.logLevel = process.env.LOG_LEVEL;

  if (process.env.NOTION_API_KEY && process.env.NOTION_AGENT_DATABASE_ID) {
    config.notion = {
      ...(config.notion as object ?? {}),
      apiKey: process.env.NOTION_API_KEY,
      agentDatabaseId: process.env.NOTION_AGENT_DATABASE_ID,
      ...(process.env.NOTION_OWNER_DATABASE_ID
        ? { ownerDatabaseId: process.env.NOTION_OWNER_DATABASE_ID, mode: 'both' }
        : {}),
    };
  }

  if (
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN
  ) {
    config.calendar = {
      ...(config.calendar as object ?? {}),
      credentials: {
        clientId: process.env.GOOGLE_CLIENT_ID,
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

  const raw = loadConfigFile(configPath);
  const merged = mergeEnv(raw as Record<string, unknown>);

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    log.error('Invalid config', result.error.format());
    throw new Error('Config validation failed. Check your ~/.argos/config.json');
  }

  _config = result.data;

  // Inject secrets into process.env (config is source of truth, env vars override)
  for (const [k, v] of Object.entries(_config.secrets)) {
    if (v && !process.env[k]) process.env[k] = v;
  }

  // Inject llm + webapp values into process.env for backward compat
  const activeProvider = _config.llm.providers[_config.llm.activeProvider];
  if (_config.llm.activeProvider && !process.env.LLM_PROVIDER_ID)
    process.env.LLM_PROVIDER_ID = _config.llm.activeProvider;
  if (activeProvider) {
    const provType = activeProvider.api === 'anthropic' ? 'anthropic' : 'compatible';
    if (!process.env.LLM_PROVIDER) process.env.LLM_PROVIDER = provType;
    if (!process.env.LLM_MODEL) process.env.LLM_MODEL = _config.llm.activeModel;
    if (activeProvider.baseUrl && !process.env.LLM_BASE_URL)
      process.env.LLM_BASE_URL = activeProvider.baseUrl;
    if (activeProvider.auth && !process.env.LLM_AUTH_MODE)
      process.env.LLM_AUTH_MODE = activeProvider.auth;
    // Inject the API key into the right env var for backward compat
    if (activeProvider.apiKey) {
      const envKeyMap: Record<string, string> = {
        anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY',
      };
      const envKey = envKeyMap[_config.llm.activeProvider] ?? 'LLM_API_KEY';
      if (!process.env[envKey]) process.env[envKey] = activeProvider.apiKey;
    }
  }
  if (_config.webapp.port && !process.env.APP_PORT)
    process.env.APP_PORT = String(_config.webapp.port);
  if (_config.webapp.webauthnRpId && !process.env.WEBAUTHN_RP_ID)
    process.env.WEBAUTHN_RP_ID = _config.webapp.webauthnRpId;
  if (_config.webapp.webauthnOrigin && !process.env.WEBAUTHN_ORIGIN)
    process.env.WEBAUTHN_ORIGIN = _config.webapp.webauthnOrigin;

  log.info('Config loaded', {
    owner: _config.owner.name,
    teams: _config.owner.teams,
    channels: _config.telegram.monitoredChats.length,
    llm: `${_config.llm.activeProvider}/${_config.llm.activeModel}`,
    readOnly: _config.readOnly,
  });

  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}

/** Patch the live config + persist to disk. Used for runtime mutations (e.g. /add-partner). */
export function patchConfig(patch: (cfg: Config) => void): void {
  if (!_config) throw new Error('Config not loaded');
  patch(_config);
  const configPath = resolvePath(process.env.CONFIG_PATH ?? '~/.argos/config.json');
  fs.writeFileSync(configPath, JSON.stringify(_config, null, 2), 'utf-8');
}

/** Add a chat to the monitored list at runtime and persist to config.json. */
export function addMonitoredChat(chatId: string, name: string, isGroup = false, tags: string[] = []): void {
  patchConfig(cfg => {
    if (!cfg.telegram.monitoredChats.some(c => c.chatId === chatId)) {
      cfg.telegram.monitoredChats.push({ chatId, name, tags, isGroup });
    }
  });
}

/** Suppress future discovery notifications for this chatId. Persisted to config. */
export function ignoreChat(chatId: string): void {
  patchConfig(cfg => {
    if (!cfg.telegram.ignoredChats.includes(chatId)) {
      cfg.telegram.ignoredChats.push(chatId);
    }
  });
}

export function isIgnoredChat(chatId: string): boolean {
  if (!_config) return false;
  return _config.telegram.ignoredChats.includes(chatId);
}

// Helper: resolve data directory
export function getDataDir(): string {
  const config = getConfig();
  return resolvePath(config.dataDir);
}

// Example config template — written on first run
export const CONFIG_TEMPLATE = {
  owner: {
    name: 'Emeric',
    telegramUserId: 0,
    teams: ['product', 'solution-engineer'],
    roles: ['solution-engineer'],
  },
  telegram: {
    approvalChatId: 'YOUR_CHAT_ID',
    monitoredChats: [
      {
        chatId: '-1001234567890',
        name: 'Partner Alpha',
        tags: ['#ops', '#deposit'],
        isGroup: true,
      },
    ],
    ignoredChats: [],
    contextWindow: {
      waitMs: 30000,
      maxMessages: 5,
      resetOnMessage: true,
    },
  },
  anonymizer: {
    mode: 'regex',
    knownPersons: [],
    knownAddresses: [],
    bucketAmounts: true,
  },
  memory: {
    defaultTtlDays: 7,
    archiveTtlDays: 365,
  },
  logLevel: 'debug',
  dataDir: '~/.argos',
  readOnly: true,
};
