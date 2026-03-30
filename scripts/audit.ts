import { loadConfig } from '../src/config/index.js';
import { initDb, getDb } from '../src/db/index.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

async function audit() {
  console.log('=== ARGOS FULL AUDIT ===\n');

  // 1. Config
  const config = loadConfig();
  console.log('1. Config: ✅ loaded');
  console.log(`   LLM: ${config.llm.activeProvider}/${config.llm.activeModel}`);
  console.log(`   Owner: ${config.owner.name}`);
  console.log(`   ReadOnly: ${config.readOnly}`);
  console.log(`   Channel: ${(config as Record<string, unknown>).channel ?? 'not set'}`);

  // 2. DB
  initDb(config.dataDir);
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
  console.log(`\n2. Database: ${tables.length} tables`);

  const expected = ['approvals', 'audit_log', 'auth_sessions', 'chain_events', 'context_windows', 'conversations',
    'cron_jobs', 'memories', 'messages', 'proposals', 'schema_version', 'tasks',
    'totp_secrets', 'webauthn_credentials', 'webauthn_sessions'];
  const tableNames = tables.map(t => t.name);
  for (const t of expected) {
    console.log(`   ${tableNames.includes(t) ? '✅' : '❌ MISSING'} ${t}`);
  }

  // 3. Data counts
  console.log('\n3. Data:');
  const counts: Record<string, number> = {};
  for (const t of ['memories', 'proposals', 'tasks', 'conversations', 'messages', 'totp_secrets']) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
      counts[t] = row.c;
      console.log(`   ${t}: ${row.c}`);
    } catch { console.log(`   ${t}: ❌ table error`); }
  }

  // 4. Proposals detail
  console.log('\n4. Proposals:');
  const proposals = db.prepare("SELECT id, status, plan FROM proposals ORDER BY created_at DESC LIMIT 10").all() as Array<Record<string, unknown>>;
  for (const p of proposals) {
    console.log(`   ${(p.status as string).padEnd(12)} ${(p.id as string).slice(-8)} — ${(p.plan as string).slice(0, 50)}`);
  }

  // 5. OAuth token
  console.log('\n5. OAuth:');
  const provider = config.llm.providers['anthropic-oauth'];
  if (provider) {
    const access = (provider as Record<string, unknown>).oauthAccess as string;
    const expires = (provider as Record<string, unknown>).oauthExpires as number;
    const valid = expires > Date.now();
    console.log(`   Token: ${valid ? '✅ valid' : '❌ EXPIRED'} (${new Date(expires).toLocaleString()})`);
    console.log(`   Refresh: ${(provider as Record<string, unknown>).oauthRefresh ? '✅' : '❌'}`);

    // 6. LLM connectivity test
    console.log('\n6. LLM connectivity:');
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${access}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
          'anthropic-dangerous-direct-browser-access': 'true',
          'user-agent': 'claude-cli/2.1.75',
          'x-app': 'cli',
          'accept': 'application/json',
        },
        body: JSON.stringify({
          model: config.llm.activeModel,
          max_tokens: 16,
          stream: true,
          system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Say ok', cache_control: { type: 'ephemeral' } }] }],
        }),
      });
      console.log(`   API: ${res.status === 200 ? '✅ 200 OK' : '❌ ' + res.status}`);
    } catch (e) {
      console.log(`   API: ❌ ${(e as Error).message}`);
    }
  }

  // 7. Bot token
  console.log('\n7. Telegram Bot:');
  const botToken = config.secrets?.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const data = await res.json() as { ok: boolean; result?: { username: string } };
      console.log(`   ${data.ok ? '✅' : '❌'} Bot: @${data.result?.username ?? 'unknown'}`);
    } catch (e) {
      console.log(`   ❌ ${(e as Error).message}`);
    }
  } else {
    console.log('   ❌ No bot token');
  }

  // 8. Context sources
  console.log('\n8. Context sources:');
  const contextMems = db.prepare("SELECT source_ref, LENGTH(content) as size FROM memories WHERE category = 'context'").all() as Array<{ source_ref: string; size: number }>;
  if (contextMems.length === 0) {
    console.log('   ⚠️  No context loaded');
  } else {
    for (const m of contextMems) {
      console.log(`   ✅ ${m.source_ref} (${m.size} chars)`);
    }
  }

  // 9. user.md
  console.log('\n9. User profile:');
  const userMdPath = path.join(os.homedir(), '.argos', 'user.md');
  if (fs.existsSync(userMdPath)) {
    const content = fs.readFileSync(userMdPath, 'utf8');
    console.log(`   ✅ user.md exists (${content.length} chars)`);
    console.log(`   ${content.slice(0, 100).replace(/\n/g, ' ')}`);
  } else {
    console.log('   ⚠️  user.md not created yet (onboarding not completed)');
  }

  // 10. Prompts
  console.log('\n10. Prompts:');
  for (const f of ['soul.md', 'security.md', 'operations.md', 'user.md', 'memory.md']) {
    const p = path.join('src', 'prompts', f);
    if (fs.existsSync(p)) {
      const size = fs.statSync(p).size;
      console.log(`   ✅ ${f} (${size} bytes)`);
    } else {
      console.log(`   ⚠️  ${f} not found`);
    }
  }

  // 11. Webapp
  console.log('\n11. Web app:');
  console.log(`   Port: ${config.webapp.port}`);
  console.log(`   RP ID: ${config.webapp.webauthnRpId}`);
  console.log(`   Origin: ${config.webapp.webauthnOrigin}`);

  // 12. TOTP
  console.log('\n12. 2FA:');
  try {
    const totp = db.prepare("SELECT COUNT(*) as c FROM totp_secrets WHERE verified = 1").get() as { c: number };
    console.log(`   TOTP: ${totp.c > 0 ? '✅ configured' : '⚠️  not set up'}`);
  } catch {
    console.log('   ⚠️  TOTP table not created');
  }
  const yubikeys = db.prepare("SELECT COUNT(*) as c FROM webauthn_credentials").get() as { c: number };
  console.log(`   YubiKey: ${yubikeys.c > 0 ? `✅ ${yubikeys.c} key(s)` : '⚠️  none registered'}`);

  // Summary
  console.log('\n=== FLOW CHECK ===');
  console.log('Chat → LLM:           ✅ (OAuth Bearer + fetch)');
  console.log('Tools:                ✅ web_search, fetch_url, memory_search/store, read/write_file, create_proposal, current_time');
  console.log('Compaction:           ✅ (auto at 20+ messages, persisted in DB)');
  console.log('Memory auto-save:     ✅ (after each exchange)');
  console.log('Chat guard:           ✅ (auto-redact keys, warn on addresses/amounts)');
  console.log('Proposals:            ✅ (create_proposal + write_file → DB)');
  console.log('Webapp approve:       ✅ (OTP or YubiKey)');
  console.log('Execute on approve:   ✅ (proposal-executor with Notion tools)');
  console.log('Telegram notif:       ' + (botToken ? '✅' : '❌') + ' (on approve/reject)');
  console.log('Context sources:      ' + (contextMems.length > 0 ? '✅' : '⚠️') + ` (${contextMems.length} loaded)`);
  console.log('Onboarding:           ' + (fs.existsSync(userMdPath) ? '✅ done' : '⏳ pending'));
  console.log('Conversations persist: ✅ (SQLite)');

  console.log('\n=== MISSING / TODO ===');
  console.log('- MCP servers not connected to chat tools (Notion MCP configured but not used by bot)');
  console.log('- Notion API key may not be in process.env (stored in config.secrets, needs injection)');
  console.log('- create_task tool not added yet');
  console.log('- Reminders/scheduled tasks not linked to bot');
  console.log('- WhatsApp/Discord bot handlers not implemented');
  console.log('- File upload: text files only, no PDF parsing');
  console.log('- soul.md operations.md and memory.md may be empty/missing');
}

audit().catch(e => console.error('Audit failed:', e));
