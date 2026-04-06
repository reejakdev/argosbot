/**
 * inject.ts — interactive pipeline REPL
 *
 * Simulates a real partner conversation directly in the pipeline:
 *   sanitize → anonymize → context window → classify → plan → (approval)
 *
 * Usage:
 *   npx tsx src/scripts/inject.ts
 *   npx tsx src/scripts/inject.ts --partner "Alice" --chat "1234567" --channel telegram
 *   npx tsx src/scripts/inject.ts --msg "Can you send me the contract address?"
 *   npx tsx src/scripts/inject.ts --flush   # force-close current window and run planner
 *
 * The window closes automatically after --window-ms (default: 5000ms) of inactivity,
 * triggering classify + plan exactly like the real pipeline.
 *
 * Notifications (draft replies, proposals) are printed to stdout instead of Telegram.
 */

import 'dotenv/config';
import readline from 'readline';
import { initDb, loadUlid } from '../db/index.js';
import { getDataDir, loadConfig } from '../config/index.js';
import { Anonymizer } from '../privacy/anonymizer.js';
import { ContextWindowManager } from '../ingestion/context-window.js';
import { buildPrivacyLlmConfig } from '../core/privacy.js';
import { ingestMessage, processWindow, setSendToApprovalChat } from '../core/pipeline.js';
import { buildRawMessage } from '../plugins/examples/raw-forwarder.js';
import { llmConfigFromConfig } from '../llm/index.js';
import { loadBuiltinSkills } from '../skills/registry.js';

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};

const PARTNER = getArg('--partner', 'TestPartner');
const CHAT_ID = getArg('--chat', 'inject-test-0001');
const CHANNEL = getArg('--channel', 'telegram') as 'telegram' | 'whatsapp' | 'email';
const WINDOW_MS = Number(getArg('--window-ms', '5000'));
const ONE_SHOT_MSG = getArg('--msg', '');
const FLUSH_NOW = args.includes('--flush');

// ─── Boot ──────────────────────────────────────────────────────────────────────

const config = loadConfig();
initDb(getDataDir());
await loadUlid();
await loadBuiltinSkills();

const llmConfig = llmConfigFromConfig(config, { maxTokens: config.claude.maxTokens });
const privacyConfig = buildPrivacyLlmConfig(config, { maxTokens: config.claude.maxTokens });
const anonymizer = new Anonymizer(config.anonymizer);

// Capture notifications → stdout
const notifications: string[] = [];
const notify = async (text: string) => {
  console.log('\n' + '─'.repeat(60));
  console.log('📲 NOTIFICATION:');
  console.log(text);
  console.log('─'.repeat(60));
  notifications.push(text);
};
setSendToApprovalChat(notify);

// Window manager with short timeout for interactive testing
const windowCfg = {
  ...config.channels.telegram.listener.contextWindow,
  inactivityMs: WINDOW_MS,
  maxMessages: config.channels.telegram.listener.contextWindow.maxMessages,
};

const windowManager = new ContextWindowManager(windowCfg, (window) =>
  processWindow(llmConfig, privacyConfig, config, anonymizer, window),
);

// ─── Inject helper ────────────────────────────────────────────────────────────

let msgCounter = 0;

async function inject(content: string) {
  msgCounter++;
  const msg = buildRawMessage({
    channel: CHANNEL,
    chatId: CHAT_ID,
    chatName: PARTNER,
    chatType: 'dm',
    senderId: 'inject-user-001',
    senderName: PARTNER,
    partnerName: PARTNER,
    content,
    timestamp: Date.now(),
  });

  console.log(
    `\n[${msgCounter}] → Injecting: "${content.slice(0, 120)}${content.length > 120 ? '…' : ''}"`,
  );

  await ingestMessage(msg, llmConfig, privacyConfig, config, anonymizer, windowManager);
  console.log(
    `    ✓ Ingested (id: ${msg.id.slice(-8)}) — window closes in ${WINDOW_MS / 1000}s of inactivity`,
  );
}

// ─── One-shot mode ─────────────────────────────────────────────────────────────

if (ONE_SHOT_MSG) {
  await inject(ONE_SHOT_MSG);
  console.log(`\nWaiting ${WINDOW_MS}ms for window to close…`);
  await new Promise((r) => setTimeout(r, WINDOW_MS + 2000));
  process.exit(0);
}

if (FLUSH_NOW) {
  console.log('Force-flushing all open windows…');
  await windowManager.flushAll();
  process.exit(0);
}

// ─── Interactive REPL ─────────────────────────────────────────────────────────

console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║           Argos Pipeline — Interactive REPL          ║');
console.log('╠══════════════════════════════════════════════════════╣');
console.log(`║  Partner : ${PARTNER.padEnd(41)}║`);
console.log(`║  ChatId  : ${CHAT_ID.padEnd(41)}║`);
console.log(`║  Channel : ${CHANNEL.padEnd(41)}║`);
console.log(`║  Window  : ${String(WINDOW_MS / 1000 + 's inactivity').padEnd(41)}║`);
console.log('╠══════════════════════════════════════════════════════╣');
console.log('║  Commands: /flush  /stats  /exit  /help              ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = () => rl.question(`${PARTNER}> `, handleLine);

async function handleLine(line: string) {
  const input = line.trim();
  if (!input) {
    prompt();
    return;
  }

  if (input === '/exit' || input === '/quit') {
    console.log('Flushing windows before exit…');
    await windowManager.flushAll();
    rl.close();
    process.exit(0);
  }

  if (input === '/flush') {
    console.log('Force-closing all open windows → running planner now…');
    await windowManager.flushAll();
    prompt();
    return;
  }

  if (input === '/stats') {
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    const tasks = (
      db
        .prepare(`SELECT COUNT(*) as c FROM tasks WHERE status IN ('open','in_progress')`)
        .get() as { c: number }
    ).c;
    const proposals = (
      db.prepare(`SELECT COUNT(*) as c FROM proposals WHERE status = 'proposed'`).get() as {
        c: number;
      }
    ).c;
    const memories = (
      db.prepare(`SELECT COUNT(*) as c FROM memories WHERE expires_at > ?`).get(Date.now()) as {
        c: number;
      }
    ).c;
    console.log(
      `\nStats — open tasks: ${tasks} | pending proposals: ${proposals} | active memories: ${memories}`,
    );
    prompt();
    return;
  }

  if (input === '/help') {
    console.log('\nCommands:');
    console.log('  /flush  — force close window and run classifier + planner immediately');
    console.log('  /stats  — show task/proposal/memory counts');
    console.log('  /exit   — flush + quit');
    console.log('  any text — injected as a message from the partner into the pipeline');
    console.log('');
    prompt();
    return;
  }

  await inject(input);
  prompt();
}

prompt();
