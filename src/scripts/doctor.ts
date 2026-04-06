/**
 * Argos Doctor — system health check
 *
 * Run:  npm run doctor
 * Flags:
 *   --fix    Print actionable fix commands inline
 *   --llm    Test LLM connectivity (makes a real API call)
 *   --json   Machine-readable JSON output
 *   --all    Include all checks including optional integrations
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initSecretsStoreSync, getAllSecretsSync, getSecretsBackend } from '../secrets/store.js';

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  blue: '\x1b[34m',
};

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const W = Math.min(process.stdout.columns || 72, 90);

function rule(label = ''): string {
  if (!label) return c.gray + '─'.repeat(W) + c.reset;
  const side = Math.floor((W - stripAnsi(label).length - 2) / 2);
  return (
    c.gray + '─'.repeat(side) + c.reset + ' ' + label + ' ' + c.gray + '─'.repeat(side) + c.reset
  );
}

// ─── Result types ─────────────────────────────────────────────────────────────

type Severity = 'ok' | 'warn' | 'error' | 'skip';

interface CheckResult {
  name: string;
  status: Severity;
  message: string;
  fix?: string;
}

const results: CheckResult[] = [];

const pass = (name: string, message: string): void =>
  void results.push({ name, status: 'ok', message });
const warn = (name: string, message: string, fix?: string): void =>
  void results.push({ name, status: 'warn', message, fix });
const fail = (name: string, message: string, fix?: string): void =>
  void results.push({ name, status: 'error', message, fix });
const skip = (name: string, message: string): void =>
  void results.push({ name, status: 'skip', message });

function printResult(r: CheckResult, showFix: boolean): void {
  const icons: Record<Severity, string> = {
    ok: `${c.green}✓${c.reset}`,
    warn: `${c.yellow}⚠${c.reset}`,
    error: `${c.red}✗${c.reset}`,
    skip: `${c.gray}–${c.reset}`,
  };
  const colors: Record<Severity, string> = {
    ok: c.reset,
    warn: c.yellow,
    error: c.red,
    skip: c.gray,
  };
  console.log(
    `  ${icons[r.status]}  ${c.bold}${r.name}${c.reset}  ${colors[r.status]}${r.message}${c.reset}`,
  );
  if (showFix && r.fix) console.log(`     ${c.gray}→ ${r.fix}${c.reset}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function readConfigFile(): Record<string, unknown> | null {
  try {
    const p = resolvePath(process.env.CONFIG_PATH ?? '~/.argos/.config.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Resolve a config value: if it starts with $ treat it as a secrets store ref */
function resolveValue(val: unknown, secrets: Record<string, string>): string | undefined {
  if (typeof val !== 'string') return undefined;
  if (val.startsWith('$')) return secrets[val.slice(1)];
  return val || undefined;
}

// ─── Checks ───────────────────────────────────────────────────────────────────

function checkNode(): void {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 22) pass('Node.js', `v${process.versions.node}`);
  else
    fail('Node.js', `v${process.versions.node}  (required: ≥22)`, 'nvm install 22 && nvm use 22');
}

function checkDataDir(): void {
  const dir = resolvePath(process.env.DATA_DIR ?? '~/.argos');
  if (!fs.existsSync(dir)) {
    warn('Data directory', `${dir}  not created yet`, 'npm run setup');
    return;
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    pass('Data directory', dir);
  } catch {
    fail('Data directory', `${dir}  not writable`, `chmod u+w ${dir}`);
  }
}

function checkSecretsStore(secrets: Record<string, string>): void {
  const backend = getSecretsBackend();
  const count = Object.keys(secrets).length;
  const label =
    backend === 'keychain'
      ? `system keychain  ${c.gray}(macOS Keychain / GNOME Keyring)${c.reset}`
      : `file  ${c.gray}(~/.argos/.secrets.json)${c.reset}`;
  if (count === 0) {
    warn('Secrets store', `${label}  — 0 secrets found`, 'npm run setup  → step 1');
  } else {
    pass('Secrets store', `${label}  · ${count} secret${count > 1 ? 's' : ''} loaded`);
  }
}

function checkConfig(secrets: Record<string, string>): void {
  const configPath = resolvePath(process.env.CONFIG_PATH ?? '~/.argos/.config.json');
  if (!fs.existsSync(configPath)) {
    fail('Config', `${configPath}  not found`, 'npm run setup');
    return;
  }
  const cfg = readConfigFile();
  if (!cfg) {
    fail(
      'Config',
      `${configPath}  invalid JSON`,
      `node -e "JSON.parse(require('fs').readFileSync('${configPath}','utf8'))"`,
    );
    return;
  }

  // Owner block
  const owner = cfg.owner as Record<string, unknown> | undefined;
  if (!owner?.name) {
    warn('Config — owner', 'owner.name missing', 'npm run setup  → owner config');
  } else if (!owner?.telegramUserId || owner.telegramUserId === 0) {
    warn(
      'Config — owner.telegramUserId',
      'still 0 — update with your Telegram user ID',
      'Message @userinfobot on Telegram to get your user ID',
    );
  } else {
    pass('Config', `${configPath}  ${c.gray}(owner: ${owner.name})${c.reset}`);
  }

  // LLM block
  const llm = cfg.llm as Record<string, unknown> | undefined;
  if (!llm?.activeProvider) {
    fail('Config — LLM', 'llm.activeProvider not set', 'npm run setup  → step 1');
  } else {
    const providerId = String(llm.activeProvider);
    const model = llm.activeModel ? String(llm.activeModel) : undefined;
    const providers = (llm.providers ?? {}) as Record<string, Record<string, unknown>>;
    const provCfg = providers[providerId];

    // Providers that don't need an API key
    const noKeyNeeded = new Set(['ollama', 'lmstudio', 'custom', 'anthropic-oauth']);

    if (!provCfg) {
      warn(
        `Config — LLM provider (${providerId})`,
        'provider block not configured',
        'npm run setup  → step 1',
      );
    } else if (!noKeyNeeded.has(providerId)) {
      const apiKey = resolveValue(provCfg.apiKey, secrets);
      if (!apiKey) {
        fail(
          `Config — LLM API key (${providerId})`,
          'apiKey not set or secret not found in store',
          'npm run setup  → step 1',
        );
      } else {
        pass(
          'Config — LLM',
          `${providerId}  ${model ?? '(no model set)'}  ${c.gray}(key: ✓)${c.reset}`,
        );
      }
    } else {
      pass('Config — LLM', `${providerId}  ${model ?? '(no model set)'}`);
    }
  }
}

async function checkLlmConnectivity(): Promise<void> {
  try {
    const { llmConfigFromEnv, llmCall } = await import('../llm/index.js');
    const cfg = llmConfigFromEnv({ maxTokens: 8 });
    process.stdout.write(`  ${c.gray}  testing LLM connectivity…${c.reset}`);
    try {
      const res = await llmCall(cfg, [{ role: 'user', content: 'Reply "ok" only.' }]);
      process.stdout.write('\r\x1b[K');
      pass(
        'LLM connectivity',
        `${res.model}  ${c.gray}(${res.inputTokens}in / ${res.outputTokens}out)${c.reset}`,
      );
    } catch (e) {
      process.stdout.write('\r\x1b[K');
      fail(
        'LLM connectivity',
        `API call failed: ${(e as Error).message}`,
        'Check API key and network',
      );
    }
  } catch {
    warn('LLM connectivity', 'LLM module not loadable — run npm install');
  }
}

function checkApprovalChannel(
  cfg: Record<string, unknown> | null,
  secrets: Record<string, string>,
): void {
  if (!cfg) {
    skip('Approval channel', 'config not loaded');
    return;
  }

  const channel = cfg.channel as string | undefined;
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;

  if (channel === 'telegram-bot') {
    const botToken =
      resolveValue(
        secrets['TELEGRAM_BOT_TOKEN']
          ? '$TELEGRAM_BOT_TOKEN'
          : (cfg.secrets as Record<string, unknown> | undefined)?.TELEGRAM_BOT_TOKEN,
        secrets,
      ) ?? secrets['TELEGRAM_BOT_TOKEN'];
    if (botToken) pass('Approval channel', `Telegram Bot  ${c.gray}(token: ✓)${c.reset}`);
    else
      fail(
        'Approval channel',
        'Telegram Bot configured but TELEGRAM_BOT_TOKEN not found in secrets store',
        'npm run setup  → step 1',
      );
  } else if (channel === 'slack') {
    const slackBot = (channels.slack as Record<string, unknown> | undefined)?.personal as
      | Record<string, unknown>
      | undefined;
    const botToken = resolveValue(slackBot?.botToken, secrets) ?? secrets['SLACK_BOT_TOKEN'];
    if (botToken) pass('Approval channel', `Slack Bot  ${c.gray}(token: ✓)${c.reset}`);
    else
      fail(
        'Approval channel',
        'Slack Bot configured but token not found in secrets store',
        'npm run setup  → step 1',
      );
  } else if (channel === 'discord') {
    const dcToken = secrets['DISCORD_BOT_TOKEN'];
    if (dcToken) pass('Approval channel', `Discord Bot  ${c.gray}(token: ✓)${c.reset}`);
    else
      fail(
        'Approval channel',
        'Discord configured but DISCORD_BOT_TOKEN not found in secrets store',
        'npm run setup  → step 1',
      );
  } else if (!channel) {
    warn('Approval channel', 'no approval channel set', 'npm run setup  → step 1');
  } else {
    pass('Approval channel', `${channel}`);
  }
}

function checkTelegramListener(
  cfg: Record<string, unknown> | null,
  secrets: Record<string, string>,
): void {
  if (!cfg) {
    skip('Telegram listener', 'config not loaded');
    return;
  }
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const tg = (channels.telegram as Record<string, unknown> | undefined)?.listener as
    | Record<string, unknown>
    | undefined;

  if (!tg?.mode) {
    skip('Telegram MTProto listener', 'not configured  (optional)');
    return;
  }

  const apiId =
    secrets['TELEGRAM_API_ID'] ??
    resolveValue((cfg.secrets as Record<string, unknown> | undefined)?.TELEGRAM_API_ID, secrets);
  const apiHash =
    secrets['TELEGRAM_API_HASH'] ??
    resolveValue((cfg.secrets as Record<string, unknown> | undefined)?.TELEGRAM_API_HASH, secrets);

  if (!apiId || !apiHash) {
    fail(
      'Telegram MTProto listener',
      'TELEGRAM_API_ID / TELEGRAM_API_HASH missing from secrets store',
      'npm run setup  → Telegram listener step',
    );
    return;
  }
  pass('Telegram MTProto listener', `api_id=${apiId}  ${c.gray}mode: ${tg.mode}${c.reset}`);

  const sessionPath = path.join(
    resolvePath(process.env.DATA_DIR ?? '~/.argos'),
    'telegram_session',
  );
  if (fs.existsSync(sessionPath)) {
    const stat = fs.statSync(sessionPath);
    pass('Telegram session', `found  ${c.gray}(${Math.round(stat.size / 1024)}KB)${c.reset}`);
  } else {
    warn('Telegram session', 'not authenticated yet', 'npm run setup  → Telegram auth step');
  }
}

async function checkDatabase(): Promise<void> {
  const dir = resolvePath(process.env.DATA_DIR ?? '~/.argos');
  const dbPath = path.join(dir, 'argos.db');
  if (!fs.existsSync(dbPath)) {
    skip('Database', 'not created yet — will be initialized on first run');
    return;
  }
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const tables = db
      .prepare("SELECT count(*) as n FROM sqlite_master WHERE type='table'")
      .get() as { n: number };
    const props = db
      .prepare(
        "SELECT count(*) as n FROM proposals WHERE status IN ('proposed','awaiting_approval')",
      )
      .get() as { n: number };
    const tasks = db
      .prepare("SELECT count(*) as n FROM tasks WHERE status IN ('open','in_progress')")
      .get() as { n: number };
    db.close();
    pass(
      'Database',
      `${c.gray}${tables.n} tables  ·  ${props.n} pending proposals  ·  ${tasks.n} open tasks${c.reset}`,
    );
  } catch (e) {
    fail('Database', `could not open: ${(e as Error).message}`);
  }
}

function checkWebApp(cfg: Record<string, unknown> | null): void {
  if (!cfg) {
    skip('Web app', 'config not loaded');
    return;
  }
  const webapp = (cfg.webapp ?? {}) as Record<string, unknown>;
  const rpId = webapp.webauthnRpId as string | undefined;
  const origin = webapp.webauthnOrigin as string | undefined;
  const port = (webapp.port as number | undefined) ?? 3000;

  if (!rpId || !origin) {
    warn(
      'Web app',
      'webapp.webauthnRpId / webauthnOrigin not set',
      'npm run setup  → step 2 (web app access)',
    );
    return;
  }
  pass('Web app', `${origin}  ${c.gray}(port ${port}, rp: ${rpId})${c.reset}`);
}

async function checkYubiKey(): Promise<void> {
  const dir = resolvePath(process.env.DATA_DIR ?? '~/.argos');
  const dbPath = path.join(dir, 'argos.db');
  if (!fs.existsSync(dbPath)) {
    skip('YubiKey / passkeys', 'database not initialized yet');
    return;
  }
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT count(*) as n FROM webauthn_credentials').get() as { n: number };
    db.close();
    if (row.n === 0) {
      warn(
        'YubiKey / passkeys',
        'no keys registered',
        `Open http://localhost:3000/setup and tap your YubiKey`,
      );
    } else {
      pass('YubiKey / passkeys', `${row.n} credential(s) registered`);
    }
  } catch {
    skip('YubiKey / passkeys', 'table not found — run Argos once to initialize DB');
  }
}

async function checkAuditChain(): Promise<void> {
  const dir = resolvePath(process.env.DATA_DIR ?? '~/.argos');
  const dbPath = path.join(dir, 'argos.db');
  if (!fs.existsSync(dbPath)) {
    skip('Audit chain', 'database not initialized yet');
    return;
  }
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const total = (db.prepare('SELECT count(*) as n FROM audit_log').get() as { n: number }).n;
    if (total === 0) {
      skip('Audit chain', 'no entries yet');
      db.close();
      return;
    }
    const hashed = (
      db.prepare('SELECT count(*) as n FROM audit_log WHERE entry_hash IS NOT NULL').get() as {
        n: number;
      }
    ).n;
    db.close();
    if (hashed === total) {
      pass('Audit chain', `${total} entries  ${c.gray}(all hashed — tamper-evident)${c.reset}`);
    } else if (hashed === 0) {
      warn(
        'Audit chain',
        `${total} entries without hash  ${c.gray}(hash chain not yet active — upgrade DB)${c.reset}`,
      );
    } else {
      pass(
        'Audit chain',
        `${total} entries  ${c.gray}(${hashed} hashed, ${total - hashed} legacy)${c.reset}`,
      );
    }
  } catch {
    skip('Audit chain', 'could not check — run  npm run verify-audit  for full chain validation');
  }
}

async function checkOptionalIntegrations(
  cfg: Record<string, unknown> | null,
  secrets: Record<string, string>,
): Promise<void> {
  // Slack listener
  const channels = (cfg?.channels ?? {}) as Record<string, unknown>;
  const slackCfg = (channels.slack ?? {}) as Record<string, unknown>;
  const slackEnabled = slackCfg.enabled === true;
  const slackToken = secrets['SLACK_USER_TOKEN'];
  if (slackEnabled && slackToken)
    pass('Slack listener', `user token ✓  ${c.gray}(xoxp-...)${c.reset}`);
  else if (slackEnabled && !slackToken)
    fail(
      'Slack listener',
      'enabled but SLACK_USER_TOKEN missing',
      'npm run setup  → Slack listener',
    );
  else skip('Slack listener', 'not enabled');

  // Discord
  const discordToken = secrets['DISCORD_BOT_TOKEN'];
  if (discordToken) pass('Discord', `bot token ✓`);
  else skip('Discord', 'not configured');

  // Email
  const emailCfg = (channels.email ?? {}) as Record<string, unknown>;
  const emailHost =
    ((emailCfg.imap as Record<string, unknown> | undefined)?.host as string | undefined) ??
    secrets['EMAIL_IMAP_HOST'];
  const emailUser =
    ((emailCfg.imap as Record<string, unknown> | undefined)?.user as string | undefined) ??
    secrets['EMAIL_IMAP_USER'];
  const emailPass = secrets['EMAIL_IMAP_PASSWORD'];
  if (emailHost && emailUser && emailPass) pass('Email IMAP', `${emailUser}@${emailHost}`);
  else if (emailHost || emailUser)
    warn(
      'Email IMAP',
      'partially configured — missing user or password',
      'npm run setup  → email step',
    );
  else skip('Email IMAP', 'not configured');

  // WhatsApp
  try {
    await import('@whiskeysockets/baileys');
    const waEnabled =
      (channels.whatsapp as Record<string, unknown> | undefined)?.enabled === true ||
      secrets['WHATSAPP_ENABLED'] === 'true';
    if (waEnabled) pass('WhatsApp', 'Baileys installed + enabled');
    else skip('WhatsApp', 'installed but not enabled');
  } catch {
    skip('WhatsApp', 'not installed  (npm install @whiskeysockets/baileys)');
  }

  // Notion
  const notionKey = secrets['NOTION_API_KEY'];
  if (notionKey) {
    const agentDb = secrets['NOTION_AGENT_DATABASE_ID'];
    const ownerDb = secrets['NOTION_OWNER_DATABASE_ID'];
    const dbs = [agentDb, ownerDb].filter(Boolean).join(', ');
    pass('Notion', dbs ? `databases: ${dbs}` : 'key ✓  (no database IDs set)');
  } else skip('Notion', 'not configured');

  // Google Calendar
  const gcalId = secrets['GOOGLE_CLIENT_ID'];
  const gcalRefresh = secrets['GOOGLE_REFRESH_TOKEN'];
  if (gcalId && gcalRefresh) pass('Google Calendar', `client_id ✓  refresh_token ✓`);
  else if (gcalId)
    warn(
      'Google Calendar',
      'client_id set but GOOGLE_REFRESH_TOKEN missing',
      'Run OAuth flow to get refresh token',
    );
  else skip('Google Calendar', 'not configured');

  // Linear
  const linearKey = secrets['LINEAR_API_KEY'];
  const linearTeam = secrets['LINEAR_TEAM_ID'];
  if (linearKey)
    pass('Linear', linearTeam ? `team=${linearTeam}` : 'key ✓  (LINEAR_TEAM_ID not set)');
  else skip('Linear', 'not configured');

  // Signal
  const signalCfg = (channels.signal ?? {}) as Record<string, unknown>;
  if (signalCfg.enabled) {
    const { execSync } = await import('child_process');
    const bin = String(signalCfg.signalCliBin ?? 'signal-cli');
    try {
      execSync(`which ${bin} 2>/dev/null || ${bin} --version 2>/dev/null`, { timeout: 3000 });
      pass('signal-cli', `binary found: ${bin}`);
    } catch {
      warn('signal-cli', `binary not found: ${bin}`, 'brew install signal-cli');
    }
  } else {
    skip('Signal', 'not enabled');
  }

  // LanceDB / embeddings
  const embedCfg = (cfg?.embeddings ?? {}) as Record<string, unknown>;
  if (embedCfg.enabled === true) {
    const embedUrl = (embedCfg.baseUrl as string | undefined) ?? 'http://localhost:11434';
    const embedModel = embedCfg.model as string | undefined;
    pass('Embeddings / LanceDB', `${embedUrl}  model: ${embedModel ?? '(not set)'}`);
  } else {
    skip('Embeddings / LanceDB', 'not enabled  (vector search disabled)');
  }

  // cloudMode
  const security = (cfg?.security ?? {}) as Record<string, unknown>;
  if (security.cloudMode === true) {
    pass('Security — cloudMode', 'ON  (YubiKey required for ALL approvals)');
  } else {
    skip('Security — cloudMode', 'OFF  (YubiKey only for medium/high risk)');
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function printSummary(): void {
  const counts = { ok: 0, warn: 0, error: 0, skip: 0 };
  for (const r of results) counts[r.status]++;

  console.log();
  console.log(rule());
  const parts: string[] = [];
  if (counts.ok) parts.push(`${c.green}${counts.ok} ok${c.reset}`);
  if (counts.warn)
    parts.push(`${c.yellow}${counts.warn} warning${counts.warn > 1 ? 's' : ''}${c.reset}`);
  if (counts.error)
    parts.push(`${c.red}${counts.error} error${counts.error > 1 ? 's' : ''}${c.reset}`);
  if (counts.skip) parts.push(`${c.gray}${counts.skip} skipped${c.reset}`);
  console.log(`\n  ${parts.join('  ·  ')}\n`);

  if (counts.error > 0) {
    console.log(
      `  ${c.red}${c.bold}Argos won't start correctly.${c.reset}  Fix errors above then re-run  ${c.cyan}npm run doctor${c.reset}\n`,
    );
  } else if (counts.warn > 0) {
    console.log(
      `  ${c.yellow}Argos can start but some features are unavailable.${c.reset}  Run  ${c.cyan}npm run doctor --fix${c.reset}  for actionable steps.\n`,
    );
  } else {
    console.log(
      `  ${c.green}${c.bold}All systems go.${c.reset}  Run  ${c.cyan}npm run dev${c.reset}  to start Argos.\n`,
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const showFix = args.includes('--fix');
  const testLlm = args.includes('--llm');
  const jsonOutput = args.includes('--json');
  const showAll = args.includes('--all');

  // Initialize secrets store (sync — reads from ~/.argos/.secrets)
  const dataDir = resolvePath(process.env.DATA_DIR ?? '~/.argos');
  initSecretsStoreSync(dataDir);
  const secrets = getAllSecretsSync();

  const cfg = readConfigFile();

  if (!jsonOutput) {
    console.log();
    console.log(rule(`${c.bold}${c.cyan}Argos Doctor${c.reset}`));
    console.log();
  }

  // ── Core checks ──────────────────────────────────────────────────────────
  checkNode();
  checkDataDir();
  checkSecretsStore(secrets);
  checkConfig(secrets);
  if (testLlm) await checkLlmConnectivity();
  checkApprovalChannel(cfg, secrets);
  checkTelegramListener(cfg, secrets);
  await checkDatabase();
  checkWebApp(cfg);
  await checkYubiKey();
  await checkAuditChain();

  // ── Optional integrations ─────────────────────────────────────────────────
  if (showAll) {
    if (!jsonOutput) {
      console.log();
      console.log(rule('Optional integrations'));
      console.log();
    }
    await checkOptionalIntegrations(cfg, secrets);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log();
    console.log(rule('Results'));
    console.log();
    for (const r of results) printResult(r, showFix);
    printSummary();
  }

  process.exit(results.some((r) => r.status === 'error') ? 1 : 0);
}

main().catch((e) => {
  console.error('Doctor failed:', e);
  process.exit(1);
});
