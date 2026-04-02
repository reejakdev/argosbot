/**
 * Argos — Interactive setup CLI
 *
 * Styled, step-by-step first-run wizard.
 * Collects API keys, authenticates channels, then lets Claude
 * configure itself by having a short conversation with the user.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { createInterface } from 'readline';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
  bgDark:  '\x1b[40m',
};

const W = process.stdout.columns || 72;


function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function box(lines: string[], width = W - 2): string {
  const inner = width - 2;
  const top    = `${c.gray}╔${'═'.repeat(inner)}╗${c.reset}`;
  const bottom = `${c.gray}╚${'═'.repeat(inner)}╝${c.reset}`;
  const rows = lines.map(l => {
    const visible = stripAnsi(l).length;
    const padding = Math.max(0, inner - 2 - visible);
    return `${c.gray}║${c.reset} ${l}${' '.repeat(padding)} ${c.gray}║${c.reset}`;
  });
  return [top, ...rows, bottom].join('\n');
}

function rule(label = '', char = '─'): string {
  if (!label) return c.gray + char.repeat(W) + c.reset;
  const side = Math.floor((W - stripAnsi(label).length - 2) / 2);
  return c.gray + char.repeat(side) + c.reset + ' ' + label + ' ' + c.gray + char.repeat(side) + c.reset;
}

function ok(msg: string)   { console.log(`  ${c.green}✓${c.reset}  ${msg}`); }
function fail(msg: string) { console.log(`  ${c.red}✗${c.reset}  ${msg}`); }
function skip(label: string, msg: string) { console.log(`  ${c.gray}–  ${label}:  ${msg}${c.reset}`); }
function info(msg: string) { console.log(`  ${c.cyan}›${c.reset}  ${msg}`); }
function warn(msg: string) { console.log(`  ${c.yellow}⚠${c.reset}  ${msg}`); }
function note(msg: string) { console.log(`     ${c.gray}${msg}${c.reset}`); }
function nl()              { console.log(); }

// ─── Spinner ──────────────────────────────────────────────────────────────────

function spinner(label: string): { stop: (ok?: boolean, msg?: string) => void } {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write(`\r  ${c.cyan}${frames[i++ % frames.length]}${c.reset}  ${label}  `);
  }, 80);
  return {
    stop(success = true, msg?: string) {
      clearInterval(t);
      const icon = success ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      process.stdout.write(`\r  ${icon}  ${msg ?? label}\n`);
    },
  };
}

// ─── Input helpers ────────────────────────────────────────────────────────────

let _rl: readline.Interface | null = null;
function getRl(): readline.Interface {
  if (!_rl) _rl = createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
function closeRl() { _rl?.close(); _rl = null; }

// ─── GoBack signal ────────────────────────────────────────────────────────────

class GoBack extends Error { constructor() { super('go_back'); this.name = 'GoBack'; } }

function ask(question: string, defaultVal?: string): Promise<string> {
  const hint = defaultVal ? ` ${c.gray}(${defaultVal})${c.reset}` : '';
  const prompt = `  ${c.cyan}?${c.reset}  ${question}${hint} ${c.cyan}›${c.reset} `;
  return new Promise(resolve => {
    getRl().question(prompt, ans => {
      const val = ans.trim() || defaultVal || '';
      resolve(val);
    });
  });
}

function askSecret(question: string): Promise<string> {
  return new Promise(resolve => {
    const prompt = `  ${c.cyan}?${c.reset}  ${question} ${c.cyan}›${c.reset} `;
    process.stdout.write(prompt);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    let val = '';
    process.stdin.on('data', function handler(ch: Buffer) {
      const char = ch.toString();
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(val);
      } else if (char === '\u0003') {
        process.exit(0);
      } else if (char === '\u007f') {
        if (val.length > 0) {
          val = val.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        val += char;
        process.stdout.write('•');
      }
    });
  });
}

// ─── Arrow-key selector ───────────────────────────────────────────────────────

interface SelectOption<T> {
  label: string;
  value: T;
  hint?: string;
}

async function select<T>(
  question: string,
  options: SelectOption<T>[],
  defaultIndex = 0,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let idx = Math.max(0, Math.min(defaultIndex, options.length - 1));
    const N = options.length;

    const render = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${N}A`);
      for (let i = 0; i < N; i++) {
        const active = i === idx;
        const cursor = active ? `${c.cyan}❯${c.reset}` : ' ';
        const label  = active
          ? `${c.bold}${c.white}${options[i].label}${c.reset}`
          : `${c.gray}${options[i].label}${c.reset}`;
        const hint   = options[i].hint ? `  ${c.dim}${options[i].hint}${c.reset}` : '';
        process.stdout.write(`\r\x1b[2K  ${cursor}  ${label}${hint}\n`);
      }
    };

    process.stdout.write(`\n  ${c.cyan}?${c.reset}  ${c.bold}${question}${c.reset}  ${c.gray}(Esc = back)${c.reset}\n\n`);
    render(true);

    _rl?.pause();
    process.stdin.setRawMode?.(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdout.write(`\x1b[${N}A`);
      for (let i = 0; i < N; i++) process.stdout.write(`\x1b[K\n`);
      process.stdout.write(`\x1b[${N}A`);
    };

    let escTimer: ReturnType<typeof setTimeout> | null = null;

    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === '\x1b[A') {                         // up arrow
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
        idx = (idx - 1 + N) % N;
        render(false);
      } else if (key === '\x1b[B') {                  // down arrow
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
        idx = (idx + 1) % N;
        render(false);
      } else if (key === '\x1b[C' || key === '\x1b[D') { // right/left arrow — ignore
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
      } else if (key === '\x1b') {                    // bare Esc — wait to see if arrow follows
        escTimer = setTimeout(() => {
          escTimer = null;
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener('data', onData);
          _rl?.resume();
          cleanup();
          warn('Back');
          reject(new GoBack());
        }, 50);
      } else if (key === '\r' || key === '\n') {       // enter
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        _rl?.resume();
        cleanup();
        ok(`${question}:  ${options[idx].label}`);
        resolve(options[idx].value);
      } else if (key === '\u0003') {
        process.exit(0);
      }
    };

    process.stdin.on('data', onData);
  });
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  return select(question, [
    { label: 'Yes', value: true },
    { label: 'No',  value: false },
  ], defaultYes ? 0 : 1);
}

// ─── Multi-select (space to toggle, enter to confirm) ────────────────────────

interface MultiSelectOption {
  label: string;
  value: string;
  hint?: string;
  checked?: boolean;
}

async function multiSelect(
  question: string,
  options: MultiSelectOption[],
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let idx = 0;
    const N = options.length;
    const checked = options.map(o => !!o.checked);

    const render = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${N}A`);
      for (let i = 0; i < N; i++) {
        const active = i === idx;
        const cursor = active ? `${c.cyan}❯${c.reset}` : ' ';
        const box    = checked[i] ? `${c.green}◼${c.reset}` : `${c.gray}◻${c.reset}`;
        const label  = active
          ? `${c.bold}${c.white}${options[i].label}${c.reset}`
          : `${c.gray}${options[i].label}${c.reset}`;
        const hint   = options[i].hint ? `  ${c.dim}${options[i].hint}${c.reset}` : '';
        process.stdout.write(`\r\x1b[2K  ${cursor} ${box}  ${label}${hint}\n`);
      }
    };

    process.stdout.write(`\n  ${c.cyan}?${c.reset}  ${c.bold}${question}${c.reset}  ${c.gray}(↑↓ move, Space toggle, Enter confirm, Esc back)${c.reset}\n\n`);
    render(true);

    _rl?.pause();
    process.stdin.setRawMode?.(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdout.write(`\x1b[${N}A`);
      for (let i = 0; i < N; i++) process.stdout.write(`\x1b[K\n`);
      process.stdout.write(`\x1b[${N}A`);
    };

    let escTimer: ReturnType<typeof setTimeout> | null = null;

    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === '\x1b[A') {
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
        idx = (idx - 1 + N) % N;
        render(false);
      } else if (key === '\x1b[B') {
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
        idx = (idx + 1) % N;
        render(false);
      } else if (key === '\x1b[C' || key === '\x1b[D') {
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
      } else if (key === '\x1b') {
        escTimer = setTimeout(() => {
          escTimer = null;
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener('data', onData);
          _rl?.resume();
          cleanup();
          warn('Back');
          reject(new GoBack());
        }, 50);
      } else if (key === ' ') {                        // space = toggle
        checked[idx] = !checked[idx];
        render(false);
      } else if (key === '\r' || key === '\n') {       // enter = confirm
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        _rl?.resume();
        cleanup();
        const selected = options.filter((_, i) => checked[i]);
        if (selected.length > 0) {
          ok(`${question}:  ${selected.map(s => s.label).join(', ')}`);
        } else {
          note(`${question}:  none selected`);
        }
        resolve(selected.map(s => s.value));
      } else if (key === '\u0003') {
        process.exit(0);
      }
    };

    process.stdin.on('data', onData);
  });
}

// ─── Paths ────────────────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

const DATA_DIR    = resolvePath(process.env.DATA_DIR    ?? '~/.argos');
const CONFIG_PATH = resolvePath(process.env.CONFIG_PATH ?? '~/.argos/config.json');

// ─── Config JSON read/write (everything lives in ~/.argos/config.json) ────────

function readConfig(): Record<string, unknown> {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw.replace(/\/\/.*$/gm, '')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Deep-get a nested config value: getPath(cfg, 'secrets.ANTHROPIC_API_KEY') */
function getPath(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Deep-set a nested config value: setPath(cfg, 'llm.activeModel', 'claude-sonnet-4-6') */
function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(): void {
  console.clear();
  nl();
  console.log(box([
    '',
    `${c.bold}${c.cyan}    🔭  A R G O S${c.reset}`,
    '',
    `${c.gray}    Local-first AI assistant for professionals${c.reset}`,
    '',
    `${c.dim}    Read by default · Sanitize before memory · Approve before action${c.reset}`,
    '',
  ]));
  nl();
}

// ─── Step header ──────────────────────────────────────────────────────────────

function stepHeader(n: number, total: number, title: string): void {
  nl();
  console.log(rule(`${c.bold}${c.cyan}Step ${n}/${total}${c.reset}  ${title}`));
  nl();
}

// ─── Tutorial boxes ───────────────────────────────────────────────────────────

function tutorial(title: string, lines: string[]): void {
  console.log(`  ${c.yellow}┌─ ${title}${c.reset}`);
  for (const l of lines) console.log(`  ${c.yellow}│${c.reset}  ${c.gray}${l}${c.reset}`);
  console.log(`  ${c.yellow}└─────────────────────────${c.reset}`);
  nl();
}

// ─── LLM provider catalog ─────────────────────────────────────────────────────

interface LlmProviderEntry {
  id:       string;
  label:    string;
  provider: 'anthropic' | 'openai' | 'compatible';
  envKey:   string;               // env var for the API key (empty = no key needed)
  baseUrl?: string;               // only for 'compatible'
  keyUrl?:  string;               // where to create the key
  models:   string[];             // suggested models (first = default)
  local?:   boolean;              // true → no API key required
}

const LLM_CATALOG: LlmProviderEntry[] = [
  {
    id: 'anthropic', label: 'Anthropic — API key  (console.anthropic.com)',
    provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY',
    keyUrl: 'console.anthropic.com',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
  {
    id: 'anthropic-oauth', label: 'Anthropic — OAuth  (Pro/Max subscription — browser login)',
    provider: 'anthropic', envKey: '',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
  {
    id: 'openai', label: 'OpenAI  (GPT-4o, o1, o3-mini…)',
    provider: 'openai', envKey: 'OPENAI_API_KEY',
    keyUrl: 'platform.openai.com/api-keys',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
  },
  {
    id: 'gemini', label: 'Google Gemini  (2.0 Flash, 1.5 Pro…)',
    provider: 'compatible', envKey: 'GEMINI_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'aistudio.google.com/app/apikey',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  },
  {
    id: 'mistral', label: 'Mistral AI  (Mistral Large / Small…)',
    provider: 'compatible', envKey: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'console.mistral.ai/api-keys',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
  },
  {
    id: 'groq', label: 'Groq  (Llama 3.3, Mixtral — fast inference)',
    provider: 'compatible', envKey: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'console.groq.com/keys',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  },
  {
    id: 'deepseek', label: 'DeepSeek  (V3, R1 reasoner)',
    provider: 'compatible', envKey: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'xai', label: 'xAI  (Grok 2)',
    provider: 'compatible', envKey: 'XAI_API_KEY',
    baseUrl: 'https://api.x.ai/v1',
    keyUrl: 'console.x.ai',
    models: ['grok-2-latest', 'grok-beta'],
  },
  {
    id: 'together', label: 'Together AI  (Llama, Mixtral, Qwen…)',
    provider: 'compatible', envKey: 'TOGETHER_API_KEY',
    baseUrl: 'https://api.together.xyz/v1',
    keyUrl: 'api.together.xyz/settings/api-keys',
    models: ['meta-llama/Llama-3-70b-chat-hf', 'mistralai/Mixtral-8x22B-Instruct-v0.1', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
  },
  {
    id: 'perplexity', label: 'Perplexity  (Sonar — web-grounded)',
    provider: 'compatible', envKey: 'PERPLEXITY_API_KEY',
    baseUrl: 'https://api.perplexity.ai',
    keyUrl: 'perplexity.ai/settings/api',
    models: ['llama-3.1-sonar-large-128k-online', 'llama-3.1-sonar-small-128k-online'],
  },
  {
    id: 'cohere', label: 'Cohere  (Command R+)',
    provider: 'compatible', envKey: 'COHERE_API_KEY',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    keyUrl: 'dashboard.cohere.com/api-keys',
    models: ['command-r-plus', 'command-r'],
  },
  {
    id: 'qwen', label: 'Alibaba Qwen  (qwen-max, qwen-plus, qwen-turbo)',
    provider: 'compatible', envKey: 'DASHSCOPE_API_KEY',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'dashscope.aliyuncs.com',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  },
  {
    id: 'ollama', label: 'Ollama  (local — Llama, Mistral, Qwen, DeepSeek…)',
    provider: 'compatible', envKey: '',
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.2', 'mistral', 'qwen2.5', 'deepseek-r1', 'phi4'],
    local: true,
  },
  {
    id: 'lmstudio', label: 'LM Studio  (local GUI — any GGUF model)',
    provider: 'compatible', envKey: '',
    baseUrl: 'http://localhost:1234/v1',
    models: [],
    local: true,
  },
  {
    id: 'custom', label: 'Custom  (any OpenAI-compatible endpoint)',
    provider: 'compatible', envKey: '',
    baseUrl: '',
    models: [],
  },
];

// ─── Step 1: API Keys ─────────────────────────────────────────────────────────

async function stepApiKeys(total: number, config: Record<string, unknown>): Promise<void> {
  stepHeader(1, total, 'API Keys & LLM provider');

  const llm = (config.llm ?? {}) as Record<string, unknown>;
  const providers = (llm.providers ?? {}) as Record<string, Record<string, unknown>>;
  const secrets = (config.secrets ?? {}) as Record<string, string>;

  // ── LLM provider ──────────────────────────────────────────────────────────

  const currentProviderId = (llm.activeProvider as string) ?? 'anthropic';
  const defaultProviderIdx = Math.max(0, LLM_CATALOG.findIndex(p => p.id === currentProviderId));

  const entry = await select(
    'LLM provider',
    LLM_CATALOG.map(p => ({
      label: p.label,
      value: p,
      hint:  p.local ? 'local' : undefined,
    })),
    defaultProviderIdx,
  );

  nl();

  // Build the provider definition for config
  const providerDef: Record<string, unknown> = {
    name:   entry.label.split('  ')[0].trim(),
    api:    entry.provider === 'anthropic' ? 'anthropic' : 'openai',
    auth:   entry.id === 'anthropic-oauth' ? 'bearer' : 'api-key',
    models: entry.models,
  };

  // Collect API key (if needed)
  let apiKey = '';
  if (entry.id === 'anthropic-oauth') {
    // ── OAuth PKCE flow ─────────────────────────────────────────────────
    const existingProvider = providers[entry.id] as Record<string, unknown> | undefined;
    const existingAccess  = existingProvider?.oauthAccess as string;
    const existingRefresh = existingProvider?.oauthRefresh as string;
    const existingExpires = existingProvider?.oauthExpires as number;

    if (existingAccess && existingRefresh && existingExpires && Date.now() < existingExpires) {
      ok('OAuth tokens still valid');
      apiKey = existingAccess;
    } else if (existingRefresh) {
      // Try to refresh
      const spin = spinner('Refreshing OAuth token…');
      try {
        const { refreshAnthropicToken } = await import('../auth/anthropic-oauth.js');
        const refreshed = await refreshAnthropicToken(existingRefresh);
        apiKey = refreshed.access;
        providerDef.oauthAccess  = refreshed.access;
        providerDef.oauthRefresh = refreshed.refresh;
        providerDef.oauthExpires = refreshed.expires;
        spin.stop(true, 'OAuth token refreshed');
      } catch (e) {
        spin.stop(false, `Refresh failed: ${(e as Error).message}`);
        info('Starting new OAuth login…');
        // Fall through to full login below
      }
    }

    if (!apiKey) {
      // Full OAuth login
      info('Opening browser for Anthropic OAuth login…');
      note('If the browser doesn\'t open, copy the URL from the terminal.');
      nl();

      const { loginAnthropic } = await import('../auth/anthropic-oauth.js');
      const { exec } = await import('child_process');

      const tokens = await loginAnthropic({
        openBrowser: (url) => {
          console.log(`  ${c.cyan}→${c.reset}  ${url}`);
          nl();
          // Open browser (macOS)
          exec(`open "${url}"`);
        },
        onProgress: (msg) => info(msg),
      });

      apiKey = tokens.access;
      providerDef.oauthAccess  = tokens.access;
      providerDef.oauthRefresh = tokens.refresh;
      providerDef.oauthExpires = tokens.expires;
      ok('OAuth login successful');
      note(`Token prefix: ${apiKey.slice(0, 15)}…  expires: ${new Date(tokens.expires).toLocaleString()}`);
    }

    providerDef.apiKey = apiKey;
  } else if (entry.envKey) {
    const existingKey = (providers[entry.id] as Record<string, unknown>)?.apiKey as string
      ?? secrets[entry.envKey];
    if (existingKey) {
      ok(`${entry.id} API key already set`);
      apiKey = existingKey;
    } else {
      if (entry.keyUrl) note(`Get your key at:  ${entry.keyUrl}`);
      apiKey = await askSecret(`${entry.id} API key`);
    }
    if (apiKey) providerDef.apiKey = apiKey;
  } else if (entry.local) {
    info(`No API key needed — make sure ${entry.id} is running locally.`);
    if (entry.id === 'ollama')   note('Start with:  ollama serve');
    if (entry.id === 'lmstudio') note('Start the local server in the LM Studio app.');
  }

  // Base URL
  if (entry.provider === 'compatible' && entry.id !== 'custom') {
    const existingUrl = (providers[entry.id] as Record<string, unknown>)?.baseUrl as string;
    providerDef.baseUrl = await ask('Base URL', existingUrl || entry.baseUrl || '');
  } else if (entry.id === 'custom') {
    providerDef.baseUrl = await ask('Base URL');
    if (!apiKey) {
      const customKey = await ask('API key (leave blank if not required)');
      if (customKey) providerDef.apiKey = customKey;
    }
  } else if (entry.baseUrl) {
    providerDef.baseUrl = entry.baseUrl;
  }

  // Model selection
  let selectedModel: string;
  if (entry.models.length > 0) {
    const currentModel = (llm.activeModel as string) || entry.models[0];
    const defaultModelIdx = Math.max(0, entry.models.indexOf(currentModel));
    const model = await select(
      'Model',
      [
        ...entry.models.map(m => ({ label: m, value: m })),
        { label: 'Custom (type below)', value: '__custom__' },
      ],
      defaultModelIdx,
    );
    selectedModel = model === '__custom__' ? await ask('Model name') : model;
    ok(`${providerDef.name} configured — model: ${selectedModel}`);
  } else {
    selectedModel = await ask('Model name');
    ok(`${entry.id} configured — model: ${selectedModel}`);
  }

  // ── Test LLM connectivity ──────────────────────────────────────────────
  {
    const spin = spinner('Testing LLM connectivity…');
    try {
      const testKey  = (providerDef.apiKey as string) ?? '';
      const testUrl  = (providerDef.baseUrl as string) ?? entry.baseUrl;
      const isOAuth  = providerDef.auth === 'bearer';

      if (providerDef.api === 'anthropic') {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        };
        if (isOAuth) {
          headers['Authorization'] = `Bearer ${testKey}`;
          headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14';
          headers['anthropic-dangerous-direct-browser-access'] = 'true';
          headers['user-agent'] = 'claude-cli/2.1.75';
          headers['x-app'] = 'cli';
        } else {
          headers['x-api-key'] = testKey;
        }
        // OAuth requires streaming + Claude Code system prompt
        const oauthBody = isOAuth ? {
          model: selectedModel,
          max_tokens: 128,
          stream: true,
          system: [{ type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.', cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply ok', cache_control: { type: 'ephemeral' } }] }],
        } : {
          model: selectedModel,
          max_tokens: 128,
          messages: [{ role: 'user', content: 'Reply ok' }],
        };
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers,
          body: JSON.stringify(oauthBody),
        });
        if (!res.ok) throw new Error(`${res.status} — ${(await res.text()).slice(0, 120)}`);
        spin.stop(true, `LLM connected — ${isOAuth ? 'OAuth token' : 'API key'} works`);
      } else {
        const url = (testUrl || 'https://api.openai.com/v1') + '/chat/completions';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (testKey) headers.Authorization = `Bearer ${testKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: selectedModel, messages: [{ role: 'user', content: 'Reply ok' }], max_tokens: 8 }),
        });
        if (!res.ok) throw new Error(`${res.status} — ${(await res.text()).slice(0, 120)}`);
        spin.stop(true, 'LLM connected — API key works');
      }
    } catch (e) {
      spin.stop(false, `LLM test failed: ${(e as Error).message}`);
      const retry = await confirm('Continue anyway?', true);
      if (!retry) { closeRl(); process.exit(1); }
    }
  }

  // Write to config
  setPath(config, `llm.activeProvider`, entry.id);
  setPath(config, `llm.activeModel`, selectedModel);
  setPath(config, `llm.providers.${entry.id}`, providerDef);

  nl();
  console.log(rule());
  nl();

  // ── Interaction channel (required — at least one) ───────────────────────

  nl();
  console.log(rule('Interaction channel'));
  nl();
  info('Argos needs at least one channel to communicate with you.');
  note('Monitoring plugins (Telegram listener, WhatsApp, Email) are configured separately.');
  nl();

  const channel = await select('How do you want to talk to Argos?', [
    { label: 'Telegram Bot',  value: 'telegram-bot', hint: 'approvals, commands, summaries via @BotFather bot' },
    { label: 'WhatsApp',      value: 'whatsapp',     hint: 'QR scan — talk to Argos via WhatsApp' },
    { label: 'Discord Bot',   value: 'discord-bot',  hint: 'same features, Discord server' },
    { label: 'Web app only',  value: 'web-only',     hint: 'no messaging — use the web dashboard + YubiKey' },
  ]);

  if (channel === 'telegram-bot') {
    tutorial('Create a Telegram Bot', [
      '1. Message @BotFather on Telegram',
      '2. /newbot → pick a name → copy the token',
      '3. Paste the token below',
    ]);
    const botToken = await askSecret('Bot token');
    setPath(config, 'secrets.TELEGRAM_BOT_TOKEN', botToken);

    // Auto-detect user ID by listening for /start on the bot
    nl();
    info('Now send /start to your bot on Telegram.');
    const spin = spinner('Waiting for /start from your Telegram…');

    let detectedChatId: string | null = null;
    const timeout = 120_000; // 2 min
    const start = Date.now();
    const pollUrl = `https://api.telegram.org/bot${botToken}/getUpdates?timeout=5&allowed_updates=["message"]`;

    // Clear old updates first
    try {
      const clearRes = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=-1`);
      await clearRes.json();
    } catch { /* ignore */ }

    while (!detectedChatId && Date.now() - start < timeout) {
      try {
        const res = await fetch(pollUrl, { signal: AbortSignal.timeout(10_000) });
        const data = await res.json() as {
          ok: boolean;
          result: Array<{
            update_id: number;
            message?: { from?: { id: number; first_name?: string }; text?: string };
          }>;
        };
        if (data.ok && data.result.length > 0) {
          for (const update of data.result) {
            if (update.message?.text === '/start' && update.message.from?.id) {
              detectedChatId = String(update.message.from.id);
              const name = update.message.from.first_name ?? '';
              // Acknowledge the offset so we don't re-read
              await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${update.update_id + 1}`);
              // Say hello back
              await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: detectedChatId,
                  text: `👋 Hey${name ? ` ${name}` : ''}! Argos is being set up. You'll receive approvals and summaries here.`,
                }),
              });
              break;
            }
          }
        }
      } catch { /* retry */ }
    }

    if (detectedChatId) {
      spin.stop(true, `Detected your Telegram ID: ${detectedChatId}`);
      setPath(config, 'telegram.approvalChatId', detectedChatId);
    } else {
      spin.stop(false, 'Timeout — no /start received');
      const manualId = await ask('Enter your Telegram user ID manually');
      if (manualId) setPath(config, 'telegram.approvalChatId', manualId);
    }
    ok('Telegram Bot configured');
  } else if (channel === 'whatsapp') {
    note('WhatsApp uses Baileys (WhatsApp Web protocol). No API key needed.');
    note('You\'ll scan a QR code in the terminal when Argos first starts.');
    setPath(config, 'secrets.WHATSAPP_ENABLED', 'true');
    ok('WhatsApp enabled — QR scan on first run');
  } else if (channel === 'discord-bot') {
    tutorial('Create a Discord Bot', [
      '1. Go to  discord.com/developers/applications',
      '2. New Application → Bot → copy the token',
      '3. Invite the bot to your server (OAuth2 → bot scope)',
      '4. Enable Message Content Intent in Bot settings',
    ]);
    setPath(config, 'secrets.DISCORD_BOT_TOKEN', await askSecret('Discord bot token'));
    const channelId = await ask('Discord channel ID for approvals');
    if (channelId) setPath(config, 'discord.approvalChannelId', channelId);
    ok('Discord Bot configured');
  } else {
    ok('Web app only — configure web access in the next step');
  }

  setPath(config, 'channel', channel);

  // ── Telegram MTProto listener (optional) ──────────────────────────────────

  nl();
  console.log(rule('Telegram listener (optional)'));
  nl();
  info('The Telegram listener reads your personal chats via MTProto (gramjs).');
  info('Required to monitor partner channels. Needs api_id + api_hash from my.telegram.org.');
  nl();

  const existingSecrets = (config.secrets ?? {}) as Record<string, string>;
  const alreadyConfigured = existingSecrets.TELEGRAM_API_ID && existingSecrets.TELEGRAM_API_HASH;

  if (alreadyConfigured) {
    ok(`Telegram MTProto already configured  (api_id=${existingSecrets.TELEGRAM_API_ID})`);
    const reconfigure = await confirm('Reconfigure?', false);
    if (!reconfigure) {
      // Intermediate save — secrets are written immediately for safety
      writeConfig(config);
      return;
    }
  }

  const enableListener = await confirm('Enable Telegram MTProto listener?', !alreadyConfigured);

  if (enableListener) {
    tutorial('Get your Telegram API credentials', [
      '1. Go to  https://my.telegram.org',
      '2. Log in with your Telegram phone number',
      '3. Click  "API development tools"',
      '4. Create an app if you haven\'t yet',
      '5. Copy  api_id  (number) and  api_hash  (string)',
    ]);

    const apiId   = await ask('Telegram api_id', existingSecrets.TELEGRAM_API_ID ?? '');
    const apiHash = await askSecret('Telegram api_hash');

    if (apiId && apiHash) {
      setPath(config, 'secrets.TELEGRAM_API_ID',   apiId);
      setPath(config, 'secrets.TELEGRAM_API_HASH',  apiHash);
      setPath(config, 'channel', channel === 'telegram-bot' ? 'telegram-bot' : channel);
      // Initialise listener mode — required for the MTProto client to start
      setPath(config, 'channels.telegram.listener.mode', 'mtproto');
      if (!getPath(config, 'channels.telegram.listener.monitoredChats')) {
        setPath(config, 'channels.telegram.listener.monitoredChats', []);
      }
      if (!getPath(config, 'channels.telegram.listener.ignoredChats')) {
        setPath(config, 'channels.telegram.listener.ignoredChats', []);
      }
      ok('Telegram MTProto credentials saved — you\'ll authenticate in step 4');
    } else {
      warn('api_id or api_hash missing — skipping MTProto config');
    }
  }

  // ── Slack listener (optional) ─────────────────────────────────────────────

  nl();
  console.log(rule('Slack listener (optional)'));
  nl();
  info('Uses YOUR personal Slack account (user token xoxp-), not a bot.');
  info('Argos will see all your DMs and channels — no bot invite needed.');
  nl();

  const existingSlackToken = existingSecrets.SLACK_USER_TOKEN;
  const slackAlreadyConfigured = !!existingSlackToken;

  if (slackAlreadyConfigured) {
    ok('Slack user token already configured');
    const reconfigureSlack = await confirm('Reconfigure?', false);
    if (!reconfigureSlack) {
      writeConfig(config);
      return;
    }
  }

  const enableSlack = await confirm('Enable Slack listener?', false);

  if (enableSlack) {
    tutorial('Get your Slack user token', [
      '1. Go to  https://api.slack.com/apps  → Create New App → From scratch',
      '2. OAuth & Permissions → User Token Scopes, add:',
      '     channels:history  channels:read  groups:history  groups:read',
      '     im:history  im:read  mpim:history  mpim:read  users:read',
      '3. Install to Workspace',
      '4. Copy the  User OAuth Token  (starts with xoxp-)',
    ]);

    const slackToken = await askSecret('Slack user token (xoxp-...)');

    if (slackToken) {
      setPath(config, 'secrets.SLACK_USER_TOKEN', slackToken);
      setPath(config, 'channels.slack.enabled', true);

      const pollInterval = await ask('Poll interval in seconds (default: 60)', '60');
      const pollSec = parseInt(pollInterval, 10);
      if (!isNaN(pollSec) && pollSec >= 10) {
        setPath(config, 'channels.slack.pollIntervalSeconds', pollSec);
      }

      const limitChannels = await confirm('Limit to specific Slack channels? (default: all joined channels + DMs)', false);
      if (limitChannels) {
        info('Enter channel IDs one by one (find them in the channel URL or right-click → Copy Link).');
        const monitoredChannels: Array<{ channelId: string; name: string }> = [];
        let addMore = true;
        while (addMore) {
          const channelId = await ask('Channel ID (e.g. C0123ABCDEF)');
          const channelName = await ask('Channel name (for display)');
          if (channelId && channelName) {
            monitoredChannels.push({ channelId, name: channelName });
          }
          addMore = await confirm('Add another channel?', false);
        }
        if (monitoredChannels.length > 0) {
          setPath(config, 'channels.slack.monitoredChannels', monitoredChannels);
        }
      }

      const monitorDMs = await confirm('Monitor Slack DMs?', true);
      setPath(config, 'channels.slack.monitorDMs', monitorDMs);

      ok('Slack user token saved — polling starts on next boot');
    } else {
      warn('No token provided — skipping Slack config');
    }
  }

  // ── Slack personal bot ────────────────────────────────────────────────────────
  nl();
  console.log(rule(`${c.bold}${c.cyan}Slack personal bot${c.reset}  (owner notifications + commands)`));
  nl();
  info('Separate from the listener — lets you receive proposals and type /approve, /reject, etc. in Slack.');

  const existingSlackBotToken = existingSecrets.SLACK_BOT_TOKEN;
  const slackBotAlreadyConfigured = !!existingSlackBotToken;

  if (slackBotAlreadyConfigured) {
    ok('Slack bot token already configured');
  }

  const enableSlackBot = await confirm(
    slackBotAlreadyConfigured ? 'Reconfigure Slack bot?' : 'Set up Slack personal bot?',
    !slackBotAlreadyConfigured,
  );

  if (enableSlackBot) {
    tutorial('Create a Slack bot for Argos', [
      '1. Go to  https://api.slack.com/apps  → Create New App → From scratch',
      '2. OAuth & Permissions → Bot Token Scopes, add:',
      '     chat:write  channels:history  im:history  im:write',
      '     groups:history  channels:read  im:read  users:read',
      '3. Install to workspace → copy Bot User OAuth Token (xoxb-...)',
      '4. Create or pick a private channel → /invite @<your-bot-name>',
      '5. Right-click the channel → Copy link → last part is the channel ID (Cxxxxxxxxx)',
    ]);

    const slackBotToken = await askSecret('Slack bot token (xoxb-...)');

    if (slackBotToken) {
      setPath(config, 'secrets.SLACK_BOT_TOKEN', slackBotToken);

      const channelId = await ask('Approval channel ID (Cxxxxxxxxx or Dxxxxxxxxx for DM)');
      if (channelId.trim()) {
        setPath(config, 'channels.slack.personal.approvalChannelId', channelId.trim());
        setPath(config, 'channels.slack.personal.botToken', slackBotToken);
      }

      const ownerUserIds = await ask('Your Slack user ID(s) (Uxxxxxxxxx, comma-separated — leave blank to skip auth check)', '');
      if (ownerUserIds.trim()) {
        const ids = ownerUserIds.split(',').map(s => s.trim()).filter(Boolean);
        setPath(config, 'channels.slack.personal.allowedUserIds', ids);
      }

      ok('Slack bot configured — start Argos and type /help in the channel to test');
    } else {
      warn('No token provided — skipping Slack bot config');
    }
  }

  // Intermediate save — secrets are written immediately for safety
  writeConfig(config);
}

// ─── Step 2: Web app access ───────────────────────────────────────────────────

function detectLanIp(): string | null {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

// ─── mkcert helpers ───────────────────────────────────────────────────────────

async function hasMkcert(): Promise<boolean> {
  const { execSync } = await import('child_process');
  try { execSync('mkcert -version', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function installMkcert(): Promise<boolean> {
  const { execSync } = await import('child_process');
  const spin = spinner('Installing mkcert via Homebrew…');
  try {
    execSync('brew install mkcert', { stdio: 'pipe' });
    spin.stop(true, 'mkcert installed');
    return true;
  } catch {
    spin.stop(false, 'brew install mkcert failed');
    warn('Install manually:  brew install mkcert');
    return false;
  }
}

async function installMkcertCa(): Promise<void> {
  const { execSync } = await import('child_process');
  info('Installing mkcert CA in system trust store (requires sudo password)…');
  note('macOS will ask for your password — this is a one-time step.');
  try {
    execSync('mkcert -install', { stdio: 'inherit' });
    ok('CA installed — your browser will trust certs generated by mkcert');
  } catch {
    warn('CA install failed — browser may show a security warning, but HTTPS will still work for WebAuthn');
  }
}

async function generateCert(hosts: string[], certDir: string): Promise<{ cert: string; key: string } | null> {
  const { execSync } = await import('child_process');
  fs.mkdirSync(certDir, { recursive: true });
  const certFile = path.join(certDir, 'cert.pem');
  const keyFile  = path.join(certDir, 'key.pem');
  const args     = hosts.join(' ');
  const spin     = spinner(`Generating TLS cert for ${hosts[0]}…`);
  try {
    execSync(
      `mkcert -cert-file "${certFile}" -key-file "${keyFile}" ${args}`,
      { stdio: 'pipe' },
    );
    spin.stop(true, `Cert generated → ${certDir}`);
    return { cert: certFile, key: keyFile };
  } catch (e) {
    spin.stop(false, 'mkcert generation failed');
    warn(String(e));
    return null;
  }
}

// ─── Step 2: Web app access ───────────────────────────────────────────────────

async function stepWebApp(total: number, config: Record<string, unknown>): Promise<void> {
  stepHeader(2, total, 'Web app access');

  const webapp = (config.webapp ?? {}) as Record<string, unknown>;

  if (webapp.webauthnRpId && webapp.webauthnOrigin && webapp.tlsCert) {
    ok(`Web app already configured  (${webapp.webauthnOrigin})`);
    return;
  }

  console.log(box([
    '',
    `  ${c.cyan}The web app runs at  http://localhost:3000${c.reset}`,
    `  ${c.gray}From your phone (same WiFi), you need a LAN IP + HTTPS.${c.reset}`,
    `  ${c.gray}WebAuthn (YubiKey) requires HTTPS for any non-localhost origin.${c.reset}`,
    '',
  ], W - 4));
  nl();

  const port = await ask('Web app port', String(webapp.port ?? '3000'));

  const mode = await select('Access mode', [
    { label: 'Localhost only',     value: '1', hint: 'YubiKey on this machine — no phone access' },
    { label: 'LAN  (mkcert TLS)',  value: '2', hint: 'Phone on same WiFi — auto cert generation' },
    { label: 'Tailscale  (HTTPS)', value: '3', hint: 'Any device via Tailscale — auto cert generation' },
  ]);

  const webappCfg: Record<string, unknown> = { port: parseInt(port, 10) };

  if (mode === '1') {
    webappCfg.webauthnRpId   = 'localhost';
    webappCfg.webauthnOrigin = `http://localhost:${port}`;
    ok(`Localhost mode — YubiKey works on this machine only`);
    note(`Phone access won't work. Re-run setup and pick LAN or Tailscale to change.`);

  } else if (mode === '2') {
    const detectedIp = detectLanIp();
    const ip = await ask('Your Mac LAN IP', detectedIp ?? '');
    if (!ip) {
      warn('No IP entered — falling back to localhost');
      webappCfg.webauthnRpId   = 'localhost';
      webappCfg.webauthnOrigin = `http://localhost:${port}`;
    } else {
      webappCfg.webauthnRpId   = ip;
      webappCfg.webauthnOrigin = `https://${ip}:${port}`;

      // Auto-generate cert with mkcert
      let mkcertOk = await hasMkcert();
      if (!mkcertOk) {
        info('mkcert not found — installing via Homebrew…');
        mkcertOk = await installMkcert();
      }
      if (mkcertOk) {
        await installMkcertCa();
        const certDir = path.join(DATA_DIR, 'tls');
        const cert = await generateCert([ip, 'localhost', '127.0.0.1'], certDir);
        if (cert) {
          webappCfg.tlsCert = cert.cert;
          webappCfg.tlsKey  = cert.key;
          ok(`LAN HTTPS ready — open  https://${ip}:${port}  from your phone`);
        } else {
          warn('Cert generation failed — Argos will start in HTTP mode');
          note(`Manual fix:  mkcert -cert-file ~/.argos/tls/cert.pem -key-file ~/.argos/tls/key.pem ${ip} localhost`);
        }
      } else {
        warn('mkcert unavailable — Argos will start in HTTP mode (WebAuthn may not work)');
      }
    }

  } else if (mode === '3') {
    const hostname = await ask('Tailscale hostname (e.g. mypc.tailXXXX.ts.net)');
    if (!hostname) {
      warn('No hostname entered — falling back to localhost');
      webappCfg.webauthnRpId   = 'localhost';
      webappCfg.webauthnOrigin = `http://localhost:${port}`;
    } else {
      webappCfg.webauthnRpId   = hostname;
      webappCfg.webauthnOrigin = `https://${hostname}:${port}`;

      // Auto-generate cert with mkcert
      let mkcertOk = await hasMkcert();
      if (!mkcertOk) {
        info('mkcert not found — installing via Homebrew…');
        mkcertOk = await installMkcert();
      }
      if (mkcertOk) {
        await installMkcertCa();
        const tailIp  = detectLanIp();
        const certDir = path.join(DATA_DIR, 'tls');
        const hosts   = [hostname, ...(tailIp ? [tailIp] : []), 'localhost', '127.0.0.1'];
        const cert    = await generateCert(hosts, certDir);
        if (cert) {
          webappCfg.tlsCert = cert.cert;
          webappCfg.tlsKey  = cert.key;
          ok(`Tailscale HTTPS ready — open  https://${hostname}:${port}`);
        } else {
          warn('Cert generation failed — Argos will start in HTTP mode');
          note(`Manual fix:  mkcert -cert-file ~/.argos/tls/cert.pem -key-file ~/.argos/tls/key.pem ${hostname} localhost`);
        }
      } else {
        warn('mkcert unavailable — Argos will start in HTTP mode (WebAuthn may not work)');
      }
    }
  }

  config.webapp = webappCfg;
  writeConfig(config);
  nl();
}

// ─── Step 3: Create data directory ───────────────────────────────────────────

function stepDataDir(total: number): void {
  stepHeader(3, total, 'Data directory');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  ok(`Data directory ready at  ${c.cyan}${DATA_DIR}${c.reset}`);
  note('All data stays local — SQLite database, session files, config.');
  nl();
}

// ─── Step 4: Telegram auth ────────────────────────────────────────────────────

async function stepTelegramAuth(total: number, config: Record<string, unknown>): Promise<void> {
  const secrets = (config.secrets ?? {}) as Record<string, string>;

  // Skip entirely if Telegram MTProto was not configured
  if (!secrets.TELEGRAM_API_ID || !secrets.TELEGRAM_API_HASH) {
    skip('Telegram authentication', 'MTProto not configured — skipping');
    return;
  }

  stepHeader(4, total, 'Telegram authentication');

  // Inject into process.env for the Telegram client
  process.env.TELEGRAM_API_ID   = secrets.TELEGRAM_API_ID;
  process.env.TELEGRAM_API_HASH = secrets.TELEGRAM_API_HASH;

  const sessionFile = path.join(DATA_DIR, 'telegram_session');

  if (fs.existsSync(sessionFile)) {
    ok('Telegram session already exists');
    note('To re-authenticate, delete  ~/.argos/telegram_session  and re-run setup.');
    return;
  }

  info('Authenticating with Telegram MTProto…');
  info('You\'ll receive an OTP in the Telegram app on your phone.');
  nl();

  try {
    const { TelegramClient }  = await import('telegram');
    const { StringSession }   = await import('telegram/sessions/index.js');

    const client = new TelegramClient(
      new StringSession(''),
      parseInt(process.env.TELEGRAM_API_ID!, 10),
      process.env.TELEGRAM_API_HASH!,
      { connectionRetries: 3 },
    );

    await client.start({
      phoneNumber: async () => ask('Phone number (with country code, e.g. +33612345678)'),
      password:    async () => ask('2FA password', '(press Enter if none)'),
      phoneCode:   async () => ask('OTP code from Telegram'),
      onError:     (e) => { fail(`Auth error: ${e}`); },
    });

    const session = client.session.save() as unknown as string;
    fs.writeFileSync(sessionFile, session, { mode: 0o600 });
    await client.disconnect();

    ok(`Telegram authenticated`);
    note(`Session saved to  ${sessionFile}  (owner-only read)`);

  } catch (e) {
    fail(`Telegram auth failed: ${e}`);
    note('You can re-run  npm run setup  to try again.');
  }
}

// ─── Step 5: AI self-configuration conversation ───────────────────────────────

async function stepAiConfiguration(total: number): Promise<object> {
  stepHeader(5, total, 'Configure Argos with AI');

  console.log(box([
    '',
    `  ${c.cyan}Argos will now ask you a few questions to configure itself.${c.reset}`,
    `  ${c.gray}Your answers shape how it classifies tasks, routes to your team,${c.reset}`,
    `  ${c.gray}and understands your role in the organization.${c.reset}`,
    '',
  ], W - 4));
  nl();

  if (!process.env.ANTHROPIC_API_KEY) {
    warn('Anthropic API key missing — using default config instead.');
    return buildDefaultConfig();
  }

  // Short conversation to gather config
  const questions: Array<{ key: string; q: string; hint: string }> = [
    {
      key: 'name',
      q:   'What\'s your name?',
      hint: 'e.g. Emeric',
    },
    {
      key: 'role',
      q:   'What\'s your role and team?',
      hint: 'e.g. Solution Engineer on the product team',
    },
    {
      key: 'partners',
      q:   'Name your main partner channels (comma-separated if multiple)',
      hint: 'e.g. Partner Alpha, Clearpool, Maple Finance  —  or press Enter to add later',
    },
    {
      key: 'language',
      q:   'What language should Argos communicate in?',
      hint: 'e.g. French, English, both',
    },
    {
      key: 'style',
      q:   'How should Argos summarize for you?',
      hint: 'e.g. concise, detailed, bullet points, with risk flags highlighted',
    },
  ];

  const answers: Record<string, string> = {};

  for (const { key, q, hint } of questions) {
    note(hint);
    answers[key] = await ask(q);
    nl();
  }

  // Call Claude to produce a structured config
  const spin = spinner('Argos is processing your answers…');

  try {
    const { llmCall } = await import('../llm/index.js');

    const llmConfig = {
      provider: 'anthropic' as const,
      model:    'claude-haiku-4-5-20251001',  // fast for setup
      apiKey:   process.env.ANTHROPIC_API_KEY!,
      maxTokens: 1024,
    };

    const prompt = `You are configuring Argos, a local-first AI assistant for operations.
Based on the user's answers, produce a JSON config object.

User answers:
Name: ${answers.name}
Role: ${answers.role}
Partners: ${answers.partners}
Language: ${answers.language}
Summary style: ${answers.style}

Produce ONLY a valid JSON object with this exact structure:
{
  "owner": {
    "name": "<name>",
    "telegramUserId": 0,
    "teams": ["<inferred team names>"],
    "roles": ["<inferred role>"],
    "language": "<primary language code: fr | en | both>"
  },
  "telegram": {
    "approvalChatId": "me",
    "monitoredChats": [],
    "contextWindow": { "waitMs": 30000, "maxMessages": 5, "resetOnMessage": true }
  },
  "anonymizer": { "mode": "regex", "knownPersons": [], "bucketAmounts": true },
  "memory": { "defaultTtlDays": 7, "archiveTtlDays": 365 },
  "logLevel": "info",
  "dataDir": "~/.argos",
  "readOnly": true,
  "summaryStyle": "<style preference>",
  "language": "<fr | en | both>"
}

Infer teams from the role description. Common teams: product, engineering, ops, finance, solution-engineer, business-development, legal.
Output ONLY the JSON, no explanation.`;

    const { extractJson } = await import('../llm/index.js');
    const response = await llmCall(llmConfig, [{ role: 'user', content: prompt }]);
    const config = extractJson(response.content);

    spin.stop(true, 'Configuration generated by Argos');
    return config ?? buildDefaultConfig(answers);

  } catch {
    spin.stop(false, 'AI config failed — using defaults');
    return buildDefaultConfig(answers);
  }
}

function buildDefaultConfig(answers?: Record<string, string>): object {
  return {
    owner: {
      name: answers?.name || 'Argos Owner',
      telegramUserId: 0,
      teams: ['product'],
      roles: ['solution-engineer'],
      language: 'en',
    },
    telegram: {
      approvalChatId: 'me',
      monitoredChats: [],
      contextWindow: { waitMs: 30000, maxMessages: 5, resetOnMessage: true },
    },
    anonymizer: { mode: 'regex', knownPersons: [], bucketAmounts: true },
    memory: { defaultTtlDays: 7, archiveTtlDays: 365 },
    logLevel: 'info',
    dataDir: '~/.argos',
    readOnly: true,
  };
}

// ─── Step 5: Write config ─────────────────────────────────────────────────────

// ─── Step 4b: Context sources ─────────────────────────────────────────────────

async function stepContextSources(config: Record<string, unknown>): Promise<void> {
  nl();
  console.log(rule('Context sources  (optional)'));
  nl();
  info('Context sources give Argos persistent knowledge about your environment.');
  note('Examples: protocol docs, partner READMEs, your Notion workspace');
  nl();

  // Load existing sources — never erase what's already configured
  const existingContext = (config.context ?? {}) as {
    urls?: Array<{ url: string; name: string; refreshDays: number }>;
    github?: Array<{ owner: string; repo: string; paths: string[]; name: string; refreshDays: number }>;
    notion?: Array<{ pageId: string; name: string; type: string; refreshDays: number }>;
  };

  const context: {
    urls: Array<{ url: string; name: string; refreshDays: number }>;
    github: Array<{ owner: string; repo: string; paths: string[]; name: string; refreshDays: number }>;
    notion: Array<{ pageId: string; name: string; type: string; refreshDays: number }>;
  } = {
    urls:   existingContext.urls   ?? [],
    github: existingContext.github ?? [],
    notion: existingContext.notion ?? [],
  };

  const existingTotal = context.urls.length + context.github.length + context.notion.length;
  if (existingTotal > 0) {
    ok(`${existingTotal} existing source(s) kept:`);
    context.urls.forEach(s   => note(`  URL    — ${s.name} (${s.url})`));
    context.github.forEach(s => note(`  GitHub — ${s.name}`));
    context.notion.forEach(s => note(`  Notion — ${s.name}`));
    nl();
  }

  // URLs
  const addUrls = await confirm('Add documentation URLs?', false);
  if (addUrls) {
    let more = true;
    while (more) {
      const url  = await ask('  URL (e.g. https://docs.aave.com/developers)');
      const name = await ask('  Label for this source', url.split('/')[2] ?? 'doc');
      if (url) context.urls.push({ url, name, refreshDays: 7 });
      more = await confirm('  Add another URL?', false);
    }
  }

  // GitHub repos
  const addGithub = await confirm('Add public GitHub repos as context?', false);
  if (addGithub) {
    let more = true;
    while (more) {
      const raw = await ask('  owner/repo (e.g. aave/aave-v3-core)');
      if (raw.includes('/')) {
        const [owner, repo] = raw.split('/');
        const paths = (await ask('  Files to fetch (comma-separated)', 'README.md'))
          .split(',').map(p => p.trim()).filter(Boolean);
        context.github.push({ owner, repo, paths, name: raw, refreshDays: 7 });
      }
      more = await confirm('  Add another repo?', false);
    }
  }

  // Notion pages
  const addNotion = await confirm('Add Notion pages/databases as context?', false);
  if (addNotion) {
    const secrets = (config.secrets ?? {}) as Record<string, string>;
    if (!secrets.NOTION_API_KEY) {
      tutorial('Notion integration setup', [
        '1. Go to  notion.so/my-integrations',
        '2. "New integration" → Internal → name it (e.g. "Argos")',
        '3. Copy the Internal Integration Token  (starts with ntn_... or secret_...)',
        '4. In Notion, open the page/database you want to share:',
        '   ⋯ (top-right) → Connections → Add "Argos"',
        '',
        'Without step 4, the API key works but sees nothing.',
      ]);
      const notionKey = await askSecret('Notion integration token  (ntn_... or secret_...)');
      if (notionKey) setPath(config, 'secrets.NOTION_API_KEY', notionKey);
    }

    const notionMode = await select('Notion access mode', [
      { label: 'Full workspace',       value: 'workspace', hint: 'Argos searches everything the integration can see' },
      { label: 'Specific pages only',  value: 'specific',  hint: 'Pick individual pages/databases by ID' },
    ]);

    if (notionMode === 'workspace') {
      context.notion.push({ pageId: '*', name: 'Full workspace', type: 'workspace' as 'page', refreshDays: 1 });
      note('Make sure you shared the pages you want with your Argos integration in Notion.');
      note('⋯ (top-right) → Connections → Add your integration on each top-level page.');
      ok('Notion full workspace search enabled');
    } else {
      tutorial('Finding a Notion page or database ID', [
        'Open the page in Notion → copy the URL:',
        '  notion.so/<workspace>/<PAGE_ID>?v=...',
        '  The ID is the 32-char hex string before the ?',
      ]);

      let more = true;
      while (more) {
        const pageId = await ask('  Notion page or database ID');
        const name   = await ask('  Label for this source');
        const type   = await select('  Type', [
          { label: 'Page',     value: 'page'     as const },
          { label: 'Database', value: 'database' as const },
        ]);
        if (pageId) context.notion.push({ pageId, name, type, refreshDays: 1 });
        more = await confirm('  Add another?', false);
      }
    }
  }

  // Google Drive
  const addDrive = await confirm('Add Google Drive folders/files as context?', false);
  if (addDrive) {
    tutorial('Google Drive — service account setup', [
      '1. Go to console.cloud.google.com → IAM & Admin → Service Accounts',
      '2. Create a service account (any name, no roles needed)',
      '3. Keys tab → Add Key → JSON → download the file',
      '4. Copy the service account email (looks like xxx@yyy.iam.gserviceaccount.com)',
      '5. In Google Drive, right-click the folder/file → Share → paste the email (Viewer)',
      '',
      'Argos will only read files — the service account has no write access.',
    ]);

    const keyPath = (await ask('  Path to service account JSON key file')).trim();
    if (keyPath) {
      setPath(config, 'googleDrive.serviceAccountKeyPath', keyPath);
      ok(`Service account key: ${keyPath}`);

      const knowledge = (config.knowledge ?? { sources: [] }) as { sources: unknown[] };
      if (!config.knowledge) config.knowledge = knowledge;

      let more = true;
      while (more) {
        const sourceType = await select('  What to add', [
          { label: 'Folder  (fetch all files inside)', value: 'folder' },
          { label: 'File    (specific file by ID)',     value: 'file'   },
        ]);

        const name = (await ask('  Label for this source')).trim() || 'Drive';

        if (sourceType === 'folder') {
          tutorial('Finding a folder ID', [
            'Open the folder in Google Drive → look at the URL:',
            '  drive.google.com/drive/folders/<FOLDER_ID>',
          ]);
          const folderId = (await ask('  Folder ID')).trim();
          if (folderId) {
            (knowledge.sources as Array<Record<string, unknown>>).push({
              type: 'google-drive', name, folderId, fileIds: [], refreshHours: 24,
            });
            ok(`Drive folder added: ${name}`);
          }
        } else {
          tutorial('Finding a file ID', [
            'Open the file in Google Drive → look at the URL:',
            '  docs.google.com/document/d/<FILE_ID>/edit',
            '  drive.google.com/file/d/<FILE_ID>/view',
          ]);
          const fileId = (await ask('  File ID')).trim();
          if (fileId) {
            (knowledge.sources as Array<Record<string, unknown>>).push({
              type: 'google-drive', name, fileIds: [fileId], refreshHours: 24,
            });
            ok(`Drive file added: ${name}`);
          }
        }

        more = await confirm('  Add another Drive source?', false);
      }
    } else {
      warn('No key path provided — Google Drive skipped.');
    }
  }

  const total = context.urls.length + context.github.length + context.notion.length;
  if (total > 0) {
    config.context = context;
    ok(`${total} context source(s) configured`);
  } else {
    note('No context sources — add them later in ~/.argos/config.json → "context" key');
  }
}

// ─── Step 4c: MCP servers ─────────────────────────────────────────────────────

import { MCP_CATALOG, fetchNewMcpServers } from '../mcp/index.js';
import type { McpCategory } from '../mcp/index.js';

const CATEGORY_LABELS: Record<McpCategory, string> = {
  search:        '🔍 Search & Web',
  productivity:  '📋 Productivity',
  dev:           '💻 Dev Tools',
  database:      '🗄️  Databases',
  browser:       '🌐 Browser',
  storage:       '📁 Storage',
  communication: '💬 Communication',
  finance:       '💳 Finance',
  infra:         '☁️  Infrastructure',
  ai:            '🤖 AI & Reasoning',
  other:         '🔧 Other',
};

async function stepMcpServers(config: Record<string, unknown>): Promise<void> {
  nl();
  console.log(rule('MCP Servers  (optional)'));
  nl();
  info('MCP servers extend Argos with external tools — GitHub, Slack, databases, browsers…');
  note('Nothing is enabled by default. You pick what you need.');
  nl();

  const enableAny = await confirm('Configure MCP servers now?', false);
  if (!enableAny) {
    note('Skip — add servers later in config.json → "mcpServers" key');
    note('Full catalog: https://registry.modelcontextprotocol.io');
    return;
  }

  // Load existing servers — preserve them across re-runs
  const existingMcpServers = (config.mcpServers as Array<Record<string, unknown>> | undefined) ?? [];
  const existingMcpNames   = new Set(existingMcpServers.map(s => s.name as string));

  if (existingMcpServers.length > 0) {
    ok(`${existingMcpServers.length} existing server(s) kept:`);
    existingMcpServers.forEach(s => note(`  • ${s.name as string}`));
    nl();
  }

  // Build multi-select options grouped by category
  const mcpOptions: MultiSelectOption[] = [];
  for (const s of MCP_CATALOG) {
    const badge = s.official ? '[official]' : '[community]';
    const envHint = s.envVars?.length ? `  (needs: ${s.envVars.join(', ')})` : '';
    mcpOptions.push({
      label: `${CATEGORY_LABELS[s.category] ?? s.category}  ${badge} ${s.name} — ${s.description}${envHint}`,
      value: s.name,
      checked: existingMcpNames.has(s.name),   // pre-check already-configured servers
      hint: s.installNote,
    });
  }

  const selectedNames = await multiSelect('Select MCP servers  (Space = toggle)', mcpOptions);

  // Start with custom servers (not in catalog) — always preserved
  const servers: Array<Record<string, unknown>> = existingMcpServers.filter(
    s => !MCP_CATALOG.some(c => c.name === s.name as string),
  );

  // Configure each selected server
  for (const name of selectedNames) {
    const s = MCP_CATALOG.find(e => e.name === name)!;

    // Reuse existing config if already set
    const existing = existingMcpServers.find(e => e.name === name);
    if (existing) {
      servers.push(existing);
      ok(`${name} — kept existing config`);
      continue;
    }

    nl();
    info(`Configuring ${c.cyan}${s.name}${c.reset}…`);

    const entry: Record<string, unknown> = {
      name:        s.name,
      type:        s.type,
      description: s.description,
      enabled:     true,
    };

    if (s.type === 'stdio') {
      entry.command = s.command ?? 'npx';
      entry.args    = s.args ?? ['-y', s.package ?? s.name];
      entry.env     = {};
    } else {
      const defaultUrl = s.url ?? '';
      const inputUrl   = await ask(`    URL`, defaultUrl);
      entry.url = inputUrl || defaultUrl;
    }

    // Collect required env vars
    if (s.envVars?.length) {
      const env: Record<string, string> = (entry.env as Record<string, string>) ?? {};
      for (const key of s.envVars) {
        const secrets = (config.secrets ?? {}) as Record<string, string>;
        // Map aliases: NOTION_TOKEN can come from NOTION_API_KEY
        const aliases: Record<string, string> = { NOTION_TOKEN: 'NOTION_API_KEY' };
        const fromEnv = process.env[key] ?? secrets[key] ?? (aliases[key] ? secrets[aliases[key]] : undefined);
        if (fromEnv) {
          env[key] = fromEnv;
          ok(`${key} — already in your config, no need to enter it again`);
        } else {
          const val = await ask(`      ${key} (leave blank to skip)`);
          if (val) env[key] = val;
        }
      }
      entry.env = env;

      if (s.type === 'url') {
        note('      If the API key above is enough, leave this blank.');
        const tok = await ask(`      Extra Authorization header (leave blank — usually not needed)`);
        if (tok) entry.authorizationToken = tok;
      }
    }

    servers.push(entry);
    ok(`${s.name} added`);
  }

  // Check for new servers in the official registry not in catalog
  nl();
  const spin = spinner('Checking official MCP registry for new servers…');
  const newServers = await fetchNewMcpServers();
  spin.stop(true, `Registry checked — ${newServers.length} server(s) not in catalog`);

  if (newServers.length > 0) {
    nl();
    info(`${newServers.length} server(s) in the official registry not yet in the built-in catalog:`);
    for (const s of newServers.slice(0, 10)) {
      note(`  • ${s.name}${s.description ? ' — ' + s.description : ''}`);
    }
    if (newServers.length > 10) note(`  … and ${newServers.length - 10} more at registry.modelcontextprotocol.io`);
    nl();
    const addCustomFromRegistry = await confirm('Add one of these from the registry?', false);
    if (addCustomFromRegistry) {
      const name = await ask('  Server name (from list above)');
      const matched = newServers.find(s => s.name === name || s.id === name);
      const type = await select('  Type', [
        { label: 'stdio  (local process)', value: 'stdio' as const },
        { label: 'url   (SSE endpoint)',   value: 'url'   as const },
      ]);
      const entry: Record<string, unknown> = {
        name:    matched?.name ?? name,
        type,
        enabled: true,
      };
      if (type === 'stdio') {
        entry.command = 'npx';
        entry.args    = ['-y', matched?.package ?? name];
      } else {
        entry.url = matched?.url ?? await ask('  SSE URL');
        const tok = await ask('  Authorization token (leave blank if none)');
        if (tok) entry.authorizationToken = tok;
      }
      servers.push(entry);
      ok(`${name} added from registry`);
    }
  }

  // Custom server
  nl();
  const addCustom = await confirm('Add a custom MCP server (not in catalog)?', false);
  if (addCustom) {
    const name = await ask('  Name (unique id)');
    const type = await select('  Type', [
      { label: 'stdio  (local process)', value: 'stdio' as const },
      { label: 'url   (SSE endpoint)',   value: 'url'   as const },
    ]);
    const desc = await ask('  Description');
    const entry: Record<string, unknown> = { name, type, description: desc, enabled: true };
    if (type === 'stdio') {
      entry.command = await ask('  Command', 'npx');
      const argsRaw = await ask('  Args (space-separated, e.g. -y @org/package)');
      entry.args    = argsRaw ? argsRaw.split(' ').filter(Boolean) : [];
      entry.env     = {};
    } else {
      entry.url = await ask('  SSE endpoint URL');
      const tok = await ask('  Authorization token (leave blank if none)');
      if (tok) entry.authorizationToken = tok;
    }
    servers.push(entry);
    ok(`Custom MCP "${name}" added`);
  }

  config.mcpServers = servers;
  if (servers.length > 0) {
    ok(`${servers.length} MCP server(s) configured`);
    nl();
    note('stdio servers need supergateway to bridge to Anthropic API:  npm i -g supergateway');
  }
}

// ─── Step 4d: Skills ──────────────────────────────────────────────────────────

const SKILLS_CATALOG_DISPLAY = [
  {
    name: 'web_search',
    description: 'Search the web (DuckDuckGo free / Brave API)',
    note: 'No key needed for DuckDuckGo. Set engine: "brave" + apiKey for Brave.',
  },
  {
    name: 'crypto_price',
    description: 'Get token prices from CoinGecko (free, no key)',
    note: 'Works out of the box.',
  },
  {
    name: 'fetch_url',
    description: 'Fetch and read any public URL',
    note: 'Works out of the box.',
  },
  {
    name: 'notion_search',
    description: 'Search your Notion workspace (requires NOTION_API_KEY)',
    note: 'Uses your existing Notion integration.',
  },
  {
    name: 'memory_search',
    description: 'Explicitly search Argos memory (FTS)',
    note: 'Always available once Argos is running.',
  },
  {
    name: 'verify_protocol_address',
    description: 'Verify a partner address against official protocol docs (APPROVE / MANUAL REVIEW / REJECT)',
    note: 'Requires web_search or fetch_url. Ask Argos to verify any address — it scrapes the docs and returns a score.',
  },
];

async function stepSkills(config: Record<string, unknown>): Promise<void> {
  nl();
  console.log(rule('Built-in Skills  (optional)'));
  nl();
  info('Skills are internal tools Claude can call during planning.');
  note('Unlike MCP servers, skills run inside Argos — no external process needed.');
  nl();

  const existingSkills     = (config.skills as Array<Record<string, unknown>> | undefined) ?? [];
  const existingSkillNames = new Set(existingSkills.map(s => s.name as string));

  if (existingSkills.length > 0) {
    ok(`${existingSkills.length} existing skill(s) kept:`);
    existingSkills.forEach(s => note(`  • ${s.name as string}`));
    nl();
  }

  const selectedSkills = await multiSelect(
    'Select skills  (Space = toggle)',
    SKILLS_CATALOG_DISPLAY.map(s => ({
      label: `${s.name} — ${s.description}`,
      value: s.name,
      checked: existingSkillNames.has(s.name),  // pre-check already-enabled skills
      hint:  s.note,
    })),
  );

  if (selectedSkills.length === 0 && existingSkills.length === 0) {
    note('No skills — add them later in config.json → "skills" key');
    return;
  }

  // Start with existing skills not in the catalog display (custom/external)
  const skills: Array<Record<string, unknown>> = existingSkills.filter(
    s => !SKILLS_CATALOG_DISPLAY.some(c => c.name === s.name as string),
  );

  for (const name of selectedSkills) {
    // Reuse existing skill config if already configured
    const existing = existingSkills.find(s => s.name === name);
    if (existing) {
      skills.push(existing);
      ok(`${name} — kept existing config`);
      continue;
    }

    const skillEntry: Record<string, unknown> = { name, enabled: true, config: {} };

    if (name === 'web_search') {
      const engine = await select('  Search engine for web_search', [
        { label: 'DuckDuckGo  (free, no key)', value: 'duckduckgo' },
        { label: 'Brave  (better results, needs API key)', value: 'brave' },
      ]);
      if (engine === 'brave') {
        const apiKey = process.env.BRAVE_API_KEY || await ask('  BRAVE_API_KEY');
        skillEntry.config = { engine: 'brave', apiKey };
      } else {
        skillEntry.config = { engine: 'duckduckgo' };
      }
    }

    skills.push(skillEntry);
    ok(`${name} enabled`);
  }

  config.skills = skills;
  ok(`${skills.length} skill(s) enabled`);
}

// ─── Cloudflare Tunnel ────────────────────────────────────────────────────────

async function stepVoice(config: Record<string, unknown>): Promise<void> {
  console.log('\n' + rule(`${c.magenta}🎙 Voice I/O${c.reset}`));
  nl();

  tutorial('What voice I/O enables', [
    'You send a voice note on Telegram → Argos transcribes it (Whisper) and processes it',
    'as if you had typed it — same pipeline, same approvals, same privacy model.',
    '',
    'With TTS enabled: Argos replies with a voice note (ElevenLabs or OpenAI TTS).',
    'Full voice workflow — send a voice note, get one back.',
    '',
    'Privacy: audio bytes are NEVER stored. Only the anonymized transcript flows through the pipeline.',
  ]);
  nl();

  const enable = await confirm('Enable voice messages (Whisper transcription)?', false);
  if (!enable) {
    skip('Voice I/O', 'skipped');
    return;
  }

  config.voice = config.voice ?? {};
  const voice = config.voice as Record<string, unknown>;
  voice.enabled = true;

  // ── Whisper ─────────────────────────────────────────────────────────────────
  nl();
  console.log(rule('Whisper — speech-to-text'));
  nl();
  info('Whisper is used to transcribe incoming voice messages.');
  info('Default: OpenAI Whisper API (whisper-1). Compatible with any OpenAI-compatible endpoint.');
  note('You can use a self-hosted Whisper server (e.g. faster-whisper) for full local transcription.');
  nl();

  const useCustomWhisper = await confirm('Use a custom Whisper endpoint (self-hosted / Groq / etc.)?', false);
  if (useCustomWhisper) {
    note('Example: http://localhost:8080/v1');
    const endpoint = await ask('Whisper endpoint URL');
    voice.whisperEndpoint = endpoint.trim() || 'https://api.openai.com/v1';
    ok(`Whisper endpoint: ${voice.whisperEndpoint}`);
  } else {
    voice.whisperEndpoint = 'https://api.openai.com/v1';
  }

  const whisperKeyHint = useCustomWhisper ? '(leave blank if no auth required)' : '(sk-...)';
  const whisperKey = await askSecret(`Whisper API key ${whisperKeyHint}`);
  if (whisperKey.trim()) {
    voice.whisperApiKey = whisperKey.trim();
    ok('Whisper API key saved.');
  } else if (!useCustomWhisper) {
    warn('No Whisper API key — transcription will fail unless you set WHISPER_API_KEY in .env');
  } else {
    note('No API key — assuming endpoint requires no auth.');
  }

  const whisperModel = await ask('Whisper model (default: whisper-1)', 'whisper-1');
  voice.whisperModel = whisperModel.trim() || 'whisper-1';

  nl();
  ok(`Whisper configured → ${voice.whisperEndpoint} (model: ${voice.whisperModel})`);

  // ── TTS ─────────────────────────────────────────────────────────────────────
  nl();
  console.log(rule('TTS — text-to-voice replies  (optional)'));
  nl();
  info('When enabled, Argos will reply with a voice note instead of plain text.');
  note('Providers:');
  note('  • ElevenLabs — highest quality, cloneable voice, requires API key + Voice ID');
  note('  • OpenAI TTS — good quality, simpler setup, uses your existing OpenAI key');
  nl();

  const ttsEnable = await confirm('Enable TTS voice replies?', false);
  if (!ttsEnable) {
    voice.ttsEnabled = false;
    skip('TTS', 'disabled — Argos will reply with text only');
    return;
  }

  voice.ttsEnabled = true;

  const provider = await select('TTS provider', [
    { label: 'ElevenLabs  (best quality, clone your voice)', value: 'elevenlabs' },
    { label: 'OpenAI TTS  (simpler, uses existing OpenAI key)', value: 'openai' },
  ]);
  voice.ttsProvider = provider;

  if (provider === 'elevenlabs') {
    nl();
    info('ElevenLabs setup:');
    note('  1. Create account at https://elevenlabs.io');
    note('  2. Go to Profile → API Key');
    note('  3. Copy your Voice ID from the Voices library');
    nl();

    const elKey = await askSecret('ElevenLabs API key (sk_...)');
    if (elKey.trim()) {
      voice.elevenLabsApiKey = elKey.trim();
      ok('ElevenLabs API key saved.');
    } else {
      warn('No API key — TTS will fail. Set ELEVENLABS_API_KEY in .env');
    }

    note('Find your Voice ID in the ElevenLabs Voices library (e.g. EXAVITQu4vr4xnSDxMaL for Adam)');
    const voiceId = await ask('ElevenLabs Voice ID');
    voice.elevenLabsVoiceId = voiceId.trim();
    ok(`Voice ID: ${voiceId.trim()}`);

  } else {
    // OpenAI TTS
    nl();
    info('OpenAI TTS setup:');
    note('  Uses the same API key as your LLM provider if you\'re on OpenAI.');
    nl();

    const oaiKey = await askSecret('OpenAI TTS API key (leave blank to reuse your main OpenAI key)');
    if (oaiKey.trim()) {
      voice.openAiTtsApiKey = oaiKey.trim();
      ok('OpenAI TTS API key saved.');
    } else {
      note('Will reuse the main OpenAI API key at runtime.');
    }

    const ttsVoice = await select('Voice', [
      { label: 'onyx  (deep, professional — default)', value: 'onyx' },
      { label: 'alloy  (neutral)', value: 'alloy' },
      { label: 'echo  (smooth)', value: 'echo' },
      { label: 'fable  (warm)', value: 'fable' },
      { label: 'nova  (bright)', value: 'nova' },
      { label: 'shimmer  (clear)', value: 'shimmer' },
    ]);
    voice.openAiTtsVoice = ttsVoice;

    const ttsModel = await select('Model', [
      { label: 'tts-1  (faster, lower latency)', value: 'tts-1' },
      { label: 'tts-1-hd  (higher quality)', value: 'tts-1-hd' },
    ]);
    voice.openAiTtsModel = ttsModel;

    ok(`OpenAI TTS configured → ${ttsModel} / ${ttsVoice}`);
  }

  nl();
  ok('Voice I/O fully configured — send a voice note to Argos and get one back.');
}

async function stepCloudflare(config: Record<string, unknown>): Promise<void> {
  console.log('\n' + rule(`${c.cyan}☁ Cloudflare Tunnel${c.reset}`));
  nl();
  info('Cloudflare Tunnel exposes your approval web app without opening any ports.');
  info('Access it securely from your phone or anywhere — no VPN needed.');
  nl();
  note('What you get:');
  note('  • Public HTTPS URL for the approval web app (e.g. argos.yourdomain.com)');
  note('  • No public IP, no open port — only an outbound cloudflared process');
  note('  • Free on Cloudflare\'s free tier (you need a domain on Cloudflare)');
  nl();

  const enable = await confirm('Set up Cloudflare Tunnel?');
  if (!enable) {
    skip('Cloudflare', 'skipped — web app accessible on localhost only');
    return;
  }

  nl();
  info('Step 1: Go to https://one.dash.cloudflare.com → Networks → Tunnels');
  info('Step 2: Create a tunnel, name it "argos"');
  info('Step 3: Add a public hostname pointing to http://localhost:3000');
  info('Step 4: Copy the tunnel token shown in "Install connector"');
  nl();

  note('Token starts with eyJhIjoiM...');
  const token = await askSecret('Paste your tunnel token');

  note('Example: argos.yourdomain.com');
  const hostname = await ask('Public hostname for the web app');

  const port = Number((config.webapp as Record<string, unknown>)?.port ?? 3000);

  config.cloudflare = {
    tunnel: { token, hostname, localPort: port, enabled: true },
  };

  // Write a ready-to-run startup script to ~/.argos/start-tunnel.sh
  try {
    const dataDir = (config.dataDir as string | undefined) ?? '~/.argos';
    const resolvedDir = dataDir.startsWith('~')
      ? path.join(os.homedir(), dataDir.slice(1))
      : dataDir;
    fs.mkdirSync(resolvedDir, { recursive: true });

    const scriptPath = path.join(resolvedDir, 'start-tunnel.sh');
    const script = [
      '#!/bin/sh',
      '# Argos — Cloudflare Tunnel startup script',
      '# Run this in a separate terminal (or add it to your process manager)',
      '#',
      `# Your web app will be available at: https://${hostname}`,
      '#',
      `exec cloudflared tunnel run --token "${token}"`,
    ].join('\n');
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });

    ok(`Startup script written: ${scriptPath}`);
  } catch {
    warn('Could not write startup script — run cloudflared manually');
  }

  nl();
  ok(`Tunnel configured → https://${hostname}`);
  nl();
  info('To start the tunnel, run:');
  note(`  cloudflared tunnel run --token "${token.slice(0, 12)}…"`);
  info('Or use the generated script:');
  note(`  ~/.argos/start-tunnel.sh`);
  nl();
  info('To install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
}

async function stepWriteConfig(config: object, total: number): Promise<void> {
  stepHeader(6, total, 'Permissions & write config');
  const cfg = config as Record<string, unknown>;

  const mode = await select('Action mode', [
    { label: 'Active',    value: false, hint: 'Argos can execute actions (send messages, create tickets…) — after your approval' },
    { label: 'Read-only', value: true,  hint: 'Argos only observes and drafts — never executes anything' },
  ], 0);
  cfg.readOnly = mode;

  if (!mode) {
    note('Every action still requires your approval (YubiKey tap or /approve).');
    note('Nothing happens without your explicit OK — active mode just enables execution after approval.');
  } else {
    note('Argos will classify and draft, but never send or execute. Good for testing.');
  }

  nl();
  writeConfig(cfg);
  ok(`Config written to  ${c.cyan}${CONFIG_PATH}${c.reset}  ${c.gray}(chmod 600)${c.reset}`);
  note('All secrets, LLM providers, and settings are in this single file.');
}

// ─── Step: User-defined agents ───────────────────────────────────────────────

const BUILTIN_TOOL_NAMES = [
  'web_search', 'fetch_url', 'memory_search', 'memory_store',
  'semantic_search', 'current_time', 'api_call', 'list_proposals',
  'create_proposal', 'list_knowledge', 'read_file',
];

async function stepAgents(config: Record<string, unknown>): Promise<void> {
  console.log(rule('Multi-agent mode  (optional)'));
  nl();

  tutorial('What are user-defined agents?', [
    'Agents are specialized sub-agents you program with a custom role and toolset.',
    '',
    'Each agent:',
    '  • Has its own system prompt (persona, rules, domain)',
    '  • Can use a subset of Argos tools (web_search, fetch_url, semantic_search…)',
    '  • Is available to the planner as a callable tool',
    '  • Can be linked to a chat channel — messages from that channel go directly to it',
    '',
    'Example: a "deal_analyzer" agent linked to your DeFi Telegram group.',
    'Every message in that group gets analyzed by the agent automatically.',
    '',
    'You can also call agents from the web app (/api/agents/:name/run).',
  ]);

  const existing = (config.agents as Array<Record<string, unknown>> | undefined) ?? [];
  if (existing.length > 0) {
    ok(`${existing.length} existing agent(s):`);
    existing.forEach(a => note(`  • ${a.name as string} — ${a.description as string}`));
    nl();
  }

  const addAgent = await confirm('Add a user-defined agent?', false);
  if (!addAgent) {
    note('Skip — add agents later in config.json → "agents" array.');
    return;
  }

  const agents: Array<Record<string, unknown>> = [...existing];

  let more = true;
  while (more) {
    nl();
    console.log(rule('New agent'));

    const name = (await ask('Agent name  (snake_case, e.g. deal_analyzer)')).trim()
      .toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
      warn('Invalid name — must be snake_case starting with a letter. Skipped.');
      more = await confirm('Add another agent?', false);
      continue;
    }

    const description = (await ask('One-line description (shown to the planner)')).trim();

    note('System prompt — define the agent\'s role, rules, and behavior.');
    note('End with an empty line.');
    const lines: string[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const line = await ask('');
      if (line === '') break;
      lines.push(line);
    }
    const systemPrompt = lines.join('\n').trim();
    if (!systemPrompt) { warn('Empty system prompt — agent skipped.'); more = await confirm('Add another agent?', false); continue; }

    const selectedTools = await multiSelect(
      'Tools this agent can use  (Space = toggle)',
      [
        { label: '* — all builtin tools',        value: '*',              checked: false },
        { label: 'web_search — search the web',  value: 'web_search',     checked: true  },
        { label: 'fetch_url — read any URL',     value: 'fetch_url',      checked: true  },
        { label: 'semantic_search — memory',     value: 'semantic_search', checked: true },
        { label: 'memory_store — save memories', value: 'memory_store',   checked: false },
        { label: 'current_time',                 value: 'current_time',   checked: false },
        { label: 'api_call — HTTP requests',     value: 'api_call',       checked: false },
        ...BUILTIN_TOOL_NAMES.filter(t => !['web_search','fetch_url','semantic_search','memory_store','current_time','api_call','*'].includes(t))
          .map(t => ({ label: t, value: t, checked: false })),
      ],
    );
    const tools = selectedTools.includes('*') ? ['*'] : selectedTools;

    // Optional: linked channels
    nl();
    const linkChannel = await confirm('Link this agent to a communication channel?', false);
    const linkedChannels: string[] = [];
    if (linkChannel) {
      note('Format: <channel_type>:<chatId>');
      note('Examples:');
      note('  telegram:-1001234567890   (group chat ID)');
      note('  slack:C0123ABCD           (channel ID)');
      note('  whatsapp:33612345678@s.whatsapp.net');
      let moreChannels = true;
      while (moreChannels) {
        const ref = (await ask('  Channel ref')).trim();
        if (ref) linkedChannels.push(ref);
        moreChannels = await confirm('  Add another channel?', false);
      }
    }

    // Optional: model override
    nl();
    const overrideModel = await confirm('Use a different LLM for this agent?', false);
    let agentProvider: string | undefined;
    let agentModel:    string | undefined;
    if (overrideModel) {
      note('Provider must match a key in config.llm.providers (e.g. "anthropic", "openai", "ollama").');
      agentProvider = (await ask('  Provider key')).trim() || undefined;
      agentModel    = (await ask('  Model name  (e.g. gpt-4o, llama3:8b)')).trim() || undefined;
      if (agentProvider && agentModel) ok(`Agent will use: ${agentProvider}/${agentModel}`);
    }

    // Optional: triggers
    nl();
    const addTriggers = await confirm('Auto-trigger this agent on matching messages?', false);
    const triggers: Array<Record<string, unknown>> = [];
    if (addTriggers) {
      tutorial('Triggers — when to run this agent automatically', [
        'Before the planner runs, Argos checks if any agent trigger matches.',
        'If yes, it runs the agent and injects the result into the planner context.',
        '',
        'Example: keywords ["whitelist","add address"] → runs on every whitelist request.',
        'You can combine keywords + categories + channels in one trigger (all must match).',
        'Multiple triggers are OR\'d — any one matching is enough.',
      ]);

      let moreTriggers = true;
      while (moreTriggers) {
        nl();
        const kwRaw = (await ask('  Keywords (comma-separated, leave empty to skip)')).trim();
        const keywords = kwRaw ? kwRaw.split(',').map(k => k.trim()).filter(Boolean) : [];

        const catRaw = (await ask('  Categories (comma-separated: tx_request,client_request,task… leave empty)')).trim();
        const categories = catRaw ? catRaw.split(',').map(k => k.trim()).filter(Boolean) : [];

        const chRaw = (await ask('  Channels (comma-separated: telegram,slack,whatsapp,email… leave empty)')).trim();
        const channels = chRaw ? chRaw.split(',').map(k => k.trim()).filter(Boolean) : [];

        if (keywords.length || categories.length || channels.length) {
          triggers.push({ keywords, categories, channels, minImportance: 0 });
          ok(`Trigger added${keywords.length ? ` — keywords: ${keywords.join(', ')}` : ''}${categories.length ? ` — categories: ${categories.join(', ')}` : ''}`);
        } else {
          warn('Empty trigger — skipped.');
        }

        moreTriggers = await confirm('  Add another trigger?', false);
      }
    }

    // Isolated workspace (default true)
    nl();
    const isolated = await confirm('Isolated workspace (private memory namespace)?', true);

    agents.push({
      name, description, systemPrompt, tools,
      linkedChannels,
      triggers,
      provider:          agentProvider,
      model:             agentModel,
      isolatedWorkspace: isolated,
      maxIterations: 8,
      temperature:   0.3,
      maxTokens:     2048,
      enabled:       true,
    });
    ok(`Agent "${name}" added`);

    more = await confirm('Add another agent?', false);
  }

  if (agents.length > 0) {
    config.agents = agents;
    ok(`${agents.length} agent(s) configured`);
  }
}

// ─── Step: Notifications + custom instructions ───────────────────────────────

async function stepNotifications(config: Record<string, unknown>): Promise<void> {
  console.log(rule('Notifications & custom instructions  (optional)'));
  nl();

  // ── Notification channel ─────────────────────────────────────────────────────
  const channels = config.channels as Record<string, unknown> | undefined;
  const hasTgBot     = !!(channels?.telegram as Record<string, unknown>)?.['personal']?.['botToken' as keyof object]
                    || !!(config.secrets as Record<string, unknown>)?.TELEGRAM_BOT_TOKEN;
  const hasTgMtproto = !!(process.env.TELEGRAM_API_ID);
  const hasSlack     = !!(channels?.slack as Record<string, unknown>)?.['personal']?.['botToken' as keyof object]
                    || !!(config.secrets as Record<string, unknown>)?.SLACK_BOT_TOKEN;
  const hasWhatsApp  = !!(config.secrets as Record<string, unknown>)?.WHATSAPP_ENABLED;

  const available: Array<{ label: string; value: string }> = [
    { label: 'Auto-detect  (telegram_bot > telegram > slack > whatsapp)', value: 'auto' },
  ];
  if (hasTgBot)     available.push({ label: 'Telegram bot  (personal bot)', value: 'telegram_bot' });
  if (hasTgMtproto) available.push({ label: 'Telegram MTProto  (your account, Saved Messages)', value: 'telegram' });
  if (hasSlack)     available.push({ label: 'Slack bot  (DM or private channel)', value: 'slack' });
  if (hasWhatsApp)  available.push({ label: 'WhatsApp', value: 'whatsapp' });

  info('Push notifications (proposals, alerts, heartbeat) go to a single channel.');
  note('Conversational replies always use the channel you messaged from — this setting only affects push notifs.');
  nl();

  const preferred = await select('Preferred notification channel', available, 0);

  if (preferred !== 'auto') {
    (config.notifications as Record<string, unknown> | undefined ?? (config.notifications = {}));
    (config.notifications as Record<string, unknown>).preferredChannel = preferred;
    ok(`Notifications → ${preferred}`);

    // WhatsApp needs a JID
    if (preferred === 'whatsapp') {
      nl();
      const jid = (await ask('WhatsApp JID for notifications  (e.g. 33612345678@s.whatsapp.net)')).trim();
      if (jid) {
        if (!config.channels) config.channels = {};
        const ch = config.channels as Record<string, unknown>;
        if (!ch.whatsapp) ch.whatsapp = {};
        (ch.whatsapp as Record<string, unknown>).approvalJid = jid;
        ok(`WhatsApp approval JID set: ${jid}`);
      }
    }
  } else {
    note('Auto-detect — Argos will pick the first available channel at boot.');
  }

  // ── Custom instructions ───────────────────────────────────────────────────────
  nl();
  console.log(rule('Custom planner instructions  (optional)'));
  nl();
  info('Add domain-specific rules for the planner + heartbeat.');
  note('Example: "When a partner asks to whitelist an address, call verify_protocol_address first."');
  note('These are YOUR rules — not shared with other Argos users.');
  nl();

  const existing = ((config.claude as Record<string, unknown> | undefined)?.customInstructions as string | undefined) ?? '';
  if (existing) {
    note(`Current instructions:\n${c.gray}${existing.slice(0, 200)}${existing.length > 200 ? '…' : ''}${c.reset}`);
    nl();
  }

  const addInstructions = await confirm('Add custom instructions?', false);
  if (addInstructions) {
    note('Enter your instructions (single line or multiline — end with an empty line):');
    const lines: string[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const line = await ask('');
      if (line === '') break;
      lines.push(line);
    }
    if (lines.length > 0) {
      if (!config.claude) config.claude = {};
      (config.claude as Record<string, unknown>).customInstructions = lines.join('\n');
      ok('Custom instructions saved.');
    }
  }
}

// ─── Step 7: YubiKey reminder + summary ──────────────────────────────────────

// ─── Step: Hot wallet (optional) ─────────────────────────────────────────────

async function stepWallet(config: Record<string, unknown>): Promise<void> {
  console.log(rule('Hot wallet  (optional)'));
  nl();

  tutorial('What the bot wallet enables', [
    'Argos generates its OWN private key — separate from any of your wallets.',
    'You send it funds + gas. It can then sign & broadcast on-chain actions.',
    '',
    'What it unlocks (all require your explicit YubiKey approval):',
    '  • Send ETH / SOL / native tokens to any address',
    '  • Execute contract calls (swaps, approvals, staking…)',
    '  • Run automated on-chain tasks via cron jobs',
    '',
    'Security model:',
    '  • Bot key is AES-256-GCM encrypted  →  ~/.argos/wallet.enc  (chmod 600)',
    '  • Never stored in the DB, never logged, never sent to any LLM',
    '  • Every signing event recorded in the immutable audit log',
    '  • Per-tx + daily spend limits enforced before any broadcast',
    '  • readOnly=true in config → dry-run only, nothing ever broadcasts',
    '',
    'You will need to fund the generated address before use.',
  ]);

  const enable = await confirm('Enable the bot hot wallet?', false);
  if (!enable) {
    skip('wallet', 'skipped');
    return;
  }

  nl();
  const evmEnabled    = await confirm('Enable EVM chains (Ethereum, Base, Arbitrum…)?', true);
  const solanaEnabled = await confirm('Enable Solana?', false);

  if (!evmEnabled && !solanaEnabled) {
    warn('No chains selected — wallet not configured.');
    return;
  }

  // ── Encryption secret ───────────────────────────────────────────────────────
  nl();
  const { randomBytes } = await import('crypto');
  const defaultSecret = randomBytes(32).toString('base64');
  info(`Auto-generated encryption secret: ${c.cyan}${defaultSecret.slice(0, 16)}…${c.reset}`);
  note('Press Enter to use it, or type your own (min 32 chars).');
  note(`${c.yellow}⚠ Back it up — losing it means losing access to the encrypted key.${c.reset}`);
  const secretInput = (await ask('Encryption secret', defaultSecret)).trim();
  const encryptionSecret = secretInput.length >= 32 ? secretInput : defaultSecret;

  const chains: Record<string, unknown> = {};

  // ── EVM chains ──────────────────────────────────────────────────────────────
  if (evmEnabled) {
    nl();
    info('Common chain IDs: 1=Ethereum  8453=Base  42161=Arbitrum  137=Polygon  10=Optimism');
    info('Free public RPCs: chainlist.org  — or use Alchemy/Infura for reliability.');
    nl();
    let addChain = true;
    while (addChain) {
      const name    = (await ask('Chain name (e.g. "base", "ethereum")')).trim();
      const rpc     = (await ask('RPC URL')).trim();
      const rawId   = (await ask('Chain ID')).trim();
      const chainId = parseInt(rawId, 10);
      const symbol  = (await ask('Native token symbol', 'ETH')).trim() || 'ETH';
      const explorer = (await ask('Block explorer URL (optional — Enter to skip)', '')).trim();
      if (name && rpc && !isNaN(chainId)) {
        chains[name] = { rpc, chainId, symbol, ...(explorer ? { explorer } : {}) };
        ok(`${name} (chainId ${chainId}, ${symbol}) added`);
      } else {
        warn('Skipped — name, RPC and chain ID are all required.');
      }
      addChain = await confirm('Add another EVM chain?', false);
    }
  }

  // ── Solana ──────────────────────────────────────────────────────────────────
  if (solanaEnabled) {
    nl();
    const solRpc = (await ask('Solana RPC URL', 'https://api.mainnet-beta.solana.com')).trim();
    chains['solana'] = { rpc: solRpc, symbol: 'SOL' };
    ok('Solana added');
  }

  // ── Spend limits ────────────────────────────────────────────────────────────
  nl();
  info('Spend limits are per chain (native token). Protects against runaway automation.');
  const maxTx    = (await ask('Max value per transaction', '1.0')).trim() || '1.0';
  const dailyMax = (await ask('Max daily spend', '10.0')).trim() || '10.0';

  // ── Address whitelist ────────────────────────────────────────────────────────
  nl();
  info('Address whitelist — only these addresses can receive funds from the bot.');
  note('Leave empty to allow any address (less safe). You can add more later in config.json.');
  nl();

  const whitelist: string[] = [];
  let addAddress = await confirm('Add a whitelisted address?', false);
  while (addAddress) {
    const addr = (await ask('Address (0x… or Solana pubkey)')).trim();
    if (addr) {
      whitelist.push(addr);
      ok(`Whitelisted: ${addr}`);
    }
    addAddress = await confirm('Add another?', false);
  }

  if (whitelist.length === 0) {
    warn('No whitelist set — any address can receive funds. Add addresses to wallet.limits.whitelist in config to restrict.');
  } else {
    ok(`${whitelist.length} address(es) whitelisted`);
  }

  config['wallet'] = {
    enabled: true,
    encryptionSecret,
    chains,
    limits: {
      maxTxValueNative: maxTx,
      dailyLimitNative: dailyMax,
      requireElevatedAuth: true,
      whitelist,
    },
  };

  nl();
  ok('Hot wallet configured');
  note(`Wallet address shown on first start — fund it with gas before signing.`);
  note(`Private key → ${c.cyan}~/.argos/wallet.enc${c.reset}  (AES-256-GCM, chmod 600)`);
  nl();
}

function stepSummary(total: number): void {
  stepHeader(7, total, 'You\'re ready');

  const port = process.env.APP_PORT ?? '3000';

  console.log(box([
    '',
    `  ${c.bold}${c.green}Argos is configured.${c.reset}`,
    '',
    `  ${c.cyan}Start:${c.reset}`,
    `     ${c.bold}npm run dev${c.reset}`,
    '',
    `  ${c.cyan}Register your YubiKey:${c.reset}`,
    `     Open  ${c.bold}http://localhost:${port}/setup${c.reset}`,
    `     Tap your YubiKey when prompted`,
    '',
    `  ${c.cyan}Telegram commands${c.reset}  (in your Saved Messages):`,
    `     /status   /tasks   /proposals   /memory   /help`,
    '',
    `  ${c.gray}Data:    ~/.argos/argos.db${c.reset}`,
    `  ${c.gray}Config:  ${CONFIG_PATH}${c.reset}`,
    `  ${c.gray}Docs:    CLAUDE.md${c.reset}`,
    '',
  ]));

  nl();
  console.log(`  ${c.gray}─────────────────────────────────────────────────────────${c.reset}`);
  console.log(`  ${c.gray}Argos Panoptes — hundred eyes, never sleeps, acts on orders only.${c.reset}`);
  nl();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// ─── Step runner with GoBack navigation ───────────────────────────────────────

interface WizardStep {
  name: string;
  run: (total: number, config: Record<string, unknown>) => Promise<void>;
}

async function runWizard(steps: WizardStep[], config: Record<string, unknown>): Promise<void> {
  const TOTAL = steps.length;
  let i = 0;

  while (i < TOTAL) {
    try {
      await steps[i].run(TOTAL, config);
      i++;
    } catch (e) {
      if (e instanceof GoBack) {
        if (i > 0) {
          i--;
          nl();
          info(`Back to: ${steps[i].name}`);
          nl();
        } else {
          warn('Already at the first step');
        }
      } else {
        throw e;
      }
    }
  }
}

async function main(): Promise<void> {
  printBanner();

  const STEP_NAMES = [
    'LLM provider & API keys',
    'Web app access',
    'Data directory',
    'Telegram auth',
    'AI self-configuration',
    'Context, MCP & skills',
    'Write config',
  ];

  info('This wizard will:');
  STEP_NAMES.forEach((name, i) => note(`${i + 1}.  ${name}`));
  note('');
  note(`${c.gray}Press Esc at any prompt to go back to the previous step.${c.reset}`);
  nl();

  // Load existing config or start fresh
  const config = readConfig();

  // If config already has data, offer to resume or restart
  const hasExistingConfig = !!(config.llm || config.webapp || config.secrets);
  let startStep = 0;

  if (hasExistingConfig) {
    info('Existing configuration detected.');
    const resumeChoice = await select('What do you want to do?', [
      { label: 'Continue where you left off', value: 'resume' },
      { label: 'Start from a specific step',  value: 'pick' },
      { label: 'Start from scratch',          value: 'restart' },
    ]);

    if (resumeChoice === 'restart') {
      // Clear config but keep a backup
      const backup = { ...config };
      for (const k of Object.keys(config)) delete config[k];
      config._backup = backup;
      ok('Config cleared — starting fresh');
    } else if (resumeChoice === 'pick') {
      const step = await select('Jump to step:', STEP_NAMES.map((name, i) => ({
        label: `${i + 1}. ${name}`,
        value: i,
      })));
      startStep = step;
    } else {
      // Resume — find first incomplete step
      if (config.llm) startStep = 1;
      if (config.webapp) startStep = 2;
      if (config.owner) startStep = 5;
      ok(`Resuming from step ${startStep + 1}: ${STEP_NAMES[startStep]}`);
    }
  } else {
    const goAhead = await confirm('Ready to start?');
    if (!goAhead) {
      nl();
      info('Setup cancelled. Run  npm run setup  whenever you\'re ready.');
      process.exit(0);
    }
  }

  const steps: WizardStep[] = [
    { name: STEP_NAMES[0], run: (total, cfg) => stepApiKeys(total, cfg) },
    { name: STEP_NAMES[1], run: (total, cfg) => stepWebApp(total, cfg) },
    { name: STEP_NAMES[2], run: (total) => { stepDataDir(total); return Promise.resolve(); } },
    { name: STEP_NAMES[3], run: (total, cfg) => stepTelegramAuth(total, cfg) },
    { name: STEP_NAMES[4], run: async (total, cfg) => {
      const aiConfig = await stepAiConfiguration(total) as Record<string, unknown>;
      for (const [k, v] of Object.entries(aiConfig)) {
        if (!['llm', 'webapp', 'secrets', 'channel'].includes(k)) cfg[k] = v;
      }
    }},
    { name: STEP_NAMES[5], run: async (total, cfg) => {
      await stepContextSources(cfg);
      await stepMcpServers(cfg);
      await stepSkills(cfg);
      await stepWallet(cfg);
      await stepAgents(cfg);
      await stepNotifications(cfg);
      await stepVoice(cfg);
      await stepCloudflare(cfg);
    }},
    { name: STEP_NAMES[6], run: async (total, cfg) => {
      await stepWriteConfig(cfg, total);
      stepSummary(total);
    }},
  ];

  try {
    await runWizard(steps.slice(startStep), config);
  } catch (e) {
    nl();
    fail(`Setup failed: ${e}`);
    note('Fix the error above and re-run  npm run setup');
    process.exit(1);
  } finally {
    closeRl();
  }
}

main();
