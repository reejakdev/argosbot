/**
 * Argos Doctor — system health check
 *
 * Run:  npm run doctor
 * Flags:
 *   --fix    Print actionable fix commands inline
 *   --llm    Test LLM connectivity (makes a real API call)
 *   --json   Machine-readable JSON output
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  gray:   '\x1b[90m',
};

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const W = Math.min(process.stdout.columns || 72, 90);

function rule(label = ''): string {
  if (!label) return c.gray + '─'.repeat(W) + c.reset;
  const side = Math.floor((W - stripAnsi(label).length - 2) / 2);
  return c.gray + '─'.repeat(side) + c.reset + ' ' + label + ' ' + c.gray + '─'.repeat(side) + c.reset;
}

// ─── Result types ─────────────────────────────────────────────────────────────

type Severity = 'ok' | 'warn' | 'error' | 'skip';

interface CheckResult {
  name:    string;
  status:  Severity;
  message: string;
  fix?:    string;
}

const results: CheckResult[] = [];

const pass = (name: string, message: string): void =>
  void results.push({ name, status: 'ok',    message });
const warn = (name: string, message: string, fix?: string): void =>
  void results.push({ name, status: 'warn',  message, fix });
const fail = (name: string, message: string, fix?: string): void =>
  void results.push({ name, status: 'error', message, fix });
const skip = (name: string, message: string): void =>
  void results.push({ name, status: 'skip',  message });

function printResult(r: CheckResult, showFix: boolean): void {
  const icons: Record<Severity, string> = {
    ok:    `${c.green}✓${c.reset}`,
    warn:  `${c.yellow}⚠${c.reset}`,
    error: `${c.red}✗${c.reset}`,
    skip:  `${c.gray}–${c.reset}`,
  };
  const colors: Record<Severity, string> = {
    ok: c.reset, warn: c.yellow, error: c.red, skip: c.gray,
  };
  console.log(`  ${icons[r.status]}  ${c.bold}${r.name}${c.reset}  ${colors[r.status]}${r.message}${c.reset}`);
  if (showFix && r.fix) console.log(`     ${c.gray}→ ${r.fix}${c.reset}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function envSet(key: string): boolean {
  return !!(process.env[key]?.trim());
}

function readConfigFile(): Record<string, unknown> | null {
  try {
    const p = resolvePath(process.env.CONFIG_PATH ?? '~/.argos/config.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Checks ───────────────────────────────────────────────────────────────────

function checkNode(): void {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 22) pass('Node.js', `v${process.versions.node}`);
  else fail('Node.js', `v${process.versions.node}  (required: ≥22)`, 'nvm install 22 && nvm use 22');
}

function checkEnvFile(): void {
  const p = path.join(process.cwd(), '.env');
  if (fs.existsSync(p)) pass('.env', p);
  else fail('.env', 'not found', 'cp .env.example .env  then fill in your keys');
}

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY', 'anthropic-oauth': 'ANTHROPIC_AUTH_TOKEN',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY', mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY', together: 'TOGETHER_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY', cohere: 'COHERE_API_KEY',
};

function checkLlmConfig(): void {
  const providerId = process.env.LLM_PROVIDER_ID ?? 'anthropic';
  const model      = process.env.LLM_MODEL;

  if (!model) {
    fail('LLM model', 'LLM_MODEL not set', 'npm run setup  → step 1');
    return;
  }

  const envKey = PROVIDER_ENV_KEYS[providerId];
  if (envKey && !envSet(envKey)) {
    fail(`LLM API key  (${providerId})`, `${envKey} not set`, 'npm run setup  → step 1');
    return;
  }

  const baseUrl = process.env.LLM_BASE_URL;
  const detail  = baseUrl ? `${providerId}  ${c.gray}(${baseUrl})${c.reset}  ${model}` : `${providerId}  ${model}`;
  pass('LLM', detail);
}

async function checkLlmConnectivity(): Promise<void> {
  try {
    const { llmConfigFromEnv, llmCall } = await import('../llm/index.js');
    const cfg = llmConfigFromEnv({ maxTokens: 8 });
    process.stdout.write(`  ${c.gray}  testing connectivity…${c.reset}`);
    try {
      const res = await llmCall(cfg, [{ role: 'user', content: 'Reply "ok" only.' }]);
      process.stdout.write('\r\x1b[K');
      pass('LLM connectivity', `${res.model}  ${c.gray}(${res.inputTokens}in / ${res.outputTokens}out)${c.reset}`);
    } catch (e) {
      process.stdout.write('\r\x1b[K');
      fail('LLM connectivity', `API call failed: ${(e as Error).message}`, 'Check API key and internet connection');
    }
  } catch {
    warn('LLM connectivity', 'LLM module not loadable — run npm install');
  }
}

function checkTelegram(): void {
  if (!envSet('TELEGRAM_API_ID') || !envSet('TELEGRAM_API_HASH')) {
    fail('Telegram credentials', 'TELEGRAM_API_ID / TELEGRAM_API_HASH not set',
      'Get them at my.telegram.org → API development tools');
    return;
  }
  pass('Telegram credentials', `api_id=${process.env.TELEGRAM_API_ID}`);

  const sessionPath = path.join(resolvePath(process.env.DATA_DIR ?? '~/.argos'), 'telegram_session');
  if (fs.existsSync(sessionPath)) {
    const stat = fs.statSync(sessionPath);
    pass('Telegram session', `found  ${c.gray}(${Math.round(stat.size / 1024)}KB)${c.reset}`);
  } else {
    warn('Telegram session', 'not found — authenticate on first run', 'npm run setup  → step 4');
  }
}

function checkDataDir(): void {
  const dir = resolvePath(process.env.DATA_DIR ?? '~/.argos');
  if (!fs.existsSync(dir)) {
    warn('Data directory', `${dir}  not created yet`, 'npm run setup  → step 3');
    return;
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    pass('Data directory', dir);
  } catch {
    fail('Data directory', `${dir}  not writable`, `chmod u+w ${dir}`);
  }
}

async function checkDatabase(): Promise<void> {
  const dir    = resolvePath(process.env.DATA_DIR ?? '~/.argos');
  const dbPath = path.join(dir, 'argos.db');
  if (!fs.existsSync(dbPath)) {
    skip('Database', 'not created yet — will be initialized on first run');
    return;
  }
  try {
    const { default: Database } = await import('better-sqlite3');
    const db  = new Database(dbPath);
    const row = db.prepare("SELECT count(*) as n FROM sqlite_master WHERE type='table'").get() as { n: number };
    db.close();
    pass('Database', `${dbPath}  ${c.gray}(${row.n} tables)${c.reset}`);
  } catch (e) {
    fail('Database', `could not open: ${(e as Error).message}`);
  }
}

function checkWebApp(): void {
  const rpId   = process.env.WEBAUTHN_RP_ID;
  const origin = process.env.WEBAUTHN_ORIGIN;
  const port   = process.env.APP_PORT ?? '3000';
  if (!rpId || !origin) {
    warn('Web app', 'WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN not set', 'npm run setup  → step 2');
    return;
  }
  pass('Web app', `${origin}  ${c.gray}(port ${port}, rp: ${rpId})${c.reset}`);
}

function checkConfig(): void {
  const configPath = resolvePath(process.env.CONFIG_PATH ?? '~/.argos/config.json');
  if (!fs.existsSync(configPath)) {
    warn('Config', `${configPath}  not found`, 'npm run setup  → step 7');
    return;
  }
  const cfg = readConfigFile();
  if (!cfg) {
    fail('Config', `${configPath}  invalid JSON`, `node -e "JSON.parse(require('fs').readFileSync('${configPath}','utf8'))"`);
    return;
  }
  const missing = ['owner', 'telegram'].filter(k => !cfg[k]);
  if (missing.length) {
    fail('Config', `missing keys: ${missing.join(', ')}`, 'npm run setup  → step 7');
    return;
  }
  const owner = cfg.owner as Record<string, unknown>;
  if (!owner.telegramUserId || owner.telegramUserId === 0) {
    warn('Config — owner.telegramUserId', 'still 0 — update it with your Telegram user ID');
  }
  pass('Config', configPath);
}

async function checkOptionalIntegrations(): Promise<void> {
  // WhatsApp
  try {
    await import('@whiskeysockets/baileys');
    if (process.env.WHATSAPP_ENABLED === 'true') pass('WhatsApp', 'Baileys installed + enabled');
    else skip('WhatsApp', 'installed but not enabled  (set WHATSAPP_ENABLED=true)');
  } catch {
    skip('WhatsApp', 'not installed  (npm install @whiskeysockets/baileys)');
  }

  // Email
  if (envSet('EMAIL_IMAP_HOST') && envSet('EMAIL_IMAP_USER') && envSet('EMAIL_IMAP_PASSWORD')) {
    pass('Email IMAP', `${process.env.EMAIL_IMAP_USER}@${process.env.EMAIL_IMAP_HOST}`);
  } else if (envSet('EMAIL_IMAP_HOST') || envSet('EMAIL_IMAP_USER')) {
    warn('Email IMAP', 'partially configured — missing USER or PASSWORD', 'npm run setup  → step 1');
  } else {
    skip('Email IMAP', 'not configured');
  }

  // Linear
  if (envSet('LINEAR_API_KEY')) {
    pass('Linear', envSet('LINEAR_TEAM_ID') ? `team=${process.env.LINEAR_TEAM_ID}` : 'key set, LINEAR_TEAM_ID missing');
  } else {
    skip('Linear', 'not configured');
  }

  // Notion
  if (envSet('NOTION_API_KEY')) {
    const dbs = [process.env.NOTION_AGENT_DATABASE_ID, process.env.NOTION_OWNER_DATABASE_ID]
      .filter(Boolean).join(', ');
    pass('Notion', dbs || 'key set — no database IDs');
  } else {
    skip('Notion', 'not configured');
  }

  // Google Calendar
  if (envSet('GOOGLE_CLIENT_ID') && envSet('GOOGLE_REFRESH_TOKEN')) {
    pass('Google Calendar', 'configured');
  } else if (envSet('GOOGLE_CLIENT_ID')) {
    warn('Google Calendar', 'client_id set but GOOGLE_REFRESH_TOKEN missing', 'npx google-auth-helper');
  } else {
    skip('Google Calendar', 'not configured');
  }
}

async function checkYubiKey(): Promise<void> {
  const dir    = resolvePath(process.env.DATA_DIR ?? '~/.argos');
  const dbPath = path.join(dir, 'argos.db');
  if (!fs.existsSync(dbPath)) {
    skip('YubiKey / passkeys', 'database not initialized yet');
    return;
  }
  try {
    const { default: Database } = await import('better-sqlite3');
    const db  = new Database(dbPath);
    const row = db.prepare("SELECT count(*) as n FROM webauthn_credentials").get() as { n: number };
    db.close();
    if (row.n === 0) {
      warn('YubiKey / passkeys', 'no keys registered',
        `Open http://localhost:${process.env.APP_PORT ?? '3000'}/setup and tap your YubiKey`);
    } else {
      pass('YubiKey / passkeys', `${row.n} credential(s) registered`);
    }
  } catch {
    skip('YubiKey / passkeys', 'table not found — run Argos once to initialize DB');
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function printSummary(): void {
  const counts = { ok: 0, warn: 0, error: 0, skip: 0 };
  for (const r of results) counts[r.status]++;

  console.log();
  console.log(rule());
  const parts: string[] = [];
  if (counts.ok)    parts.push(`${c.green}${counts.ok} ok${c.reset}`);
  if (counts.warn)  parts.push(`${c.yellow}${counts.warn} warning${counts.warn > 1 ? 's' : ''}${c.reset}`);
  if (counts.error) parts.push(`${c.red}${counts.error} error${counts.error > 1 ? 's' : ''}${c.reset}`);
  if (counts.skip)  parts.push(`${c.gray}${counts.skip} skipped${c.reset}`);
  console.log(`\n  ${parts.join('  ·  ')}\n`);

  if (counts.error > 0) {
    console.log(`  ${c.red}${c.bold}Argos won't start correctly.${c.reset}  Fix errors above then re-run  ${c.cyan}npm run doctor${c.reset}\n`);
  } else if (counts.warn > 0) {
    console.log(`  ${c.yellow}Argos can start but some features are unavailable.${c.reset}\n`);
  } else {
    console.log(`  ${c.green}${c.bold}All systems go.${c.reset}  Run  ${c.cyan}npm run dev${c.reset}  to start.\n`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args       = process.argv.slice(2);
  const showFix    = args.includes('--fix');
  const testLlm    = args.includes('--llm');
  const jsonOutput = args.includes('--json');

  if (!jsonOutput) {
    console.log();
    console.log(rule(`${c.bold}${c.cyan}Argos Doctor${c.reset}`));
    console.log();
  }

  // Core
  checkNode();
  checkEnvFile();
  checkLlmConfig();
  if (testLlm) await checkLlmConnectivity();
  checkTelegram();
  checkDataDir();
  await checkDatabase();
  checkWebApp();
  checkConfig();

  // Optional integrations
  if (!jsonOutput) {
    console.log();
    console.log(rule('Optional integrations'));
    console.log();
  }
  await checkOptionalIntegrations();
  await checkYubiKey();

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log();
    console.log(rule('Results'));
    console.log();
    for (const r of results) printResult(r, showFix);
    printSummary();
  }

  process.exit(results.some(r => r.status === 'error') ? 1 : 0);
}

main().catch(e => { console.error('Doctor failed:', e); process.exit(1); });
