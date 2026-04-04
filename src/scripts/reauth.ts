/**
 * Re-OAuth script — re-run the Anthropic OAuth PKCE flow and update tokens in config.
 * Reads/writes config.json directly — no loadConfig(), no schema validation.
 */

import { exec }           from 'node:child_process';
import { platform }       from 'node:process';
import readline           from 'node:readline';
import fs                 from 'node:fs';
import path               from 'node:path';
import os                 from 'node:os';
import { loginAnthropic } from '../auth/anthropic-oauth.js';

const CONFIG_PATH = path.join(os.homedir(), '.argos', 'config.json');

function openBrowser(url: string): void {
  const cmd =
    platform === 'darwin' ? `open "${url}"` :
    platform === 'win32'  ? `start "" "${url}"` :
                            `xdg-open "${url}"`;
  exec(cmd, err => {
    if (err) console.log(`\n→ Open this URL manually:\n  ${url}\n`);
  });
}

function promptManualCode(): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\nPaste the callback URL or code#state (or Enter to wait for browser): ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  console.log('\n🔐 Argos — Anthropic OAuth re-authentication\n');
  console.log('Opening browser…');
  console.log('(If it does not open, the URL will be printed below)\n');

  const tokens = await loginAnthropic({
    openBrowser,
    onProgress:    msg => console.log(`  ⋯ ${msg}`),
    onManualInput: promptManualCode,
  });

  // Read → patch → write, no validation
  const raw    = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw) as Record<string, unknown>;

  if (!config.llm) config.llm = {};
  const llm = config.llm as Record<string, unknown>;
  if (!llm.providers) llm.providers = {};
  const providers = llm.providers as Record<string, Record<string, unknown>>;
  if (!providers['anthropic-oauth']) providers['anthropic-oauth'] = {};

  providers['anthropic-oauth'].oauthAccess  = tokens.access;
  providers['anthropic-oauth'].oauthRefresh = tokens.refresh;
  providers['anthropic-oauth'].oauthExpires = tokens.expires;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });

  // Update secrets store (file + keychain) so $LLM_APIKEY_ANTHROPIC_OAUTH resolves to the new token
  const { initSecretsStoreSync, setManySecretsSync } = await import('../secrets/store.js');
  initSecretsStoreSync(path.join(os.homedir(), '.argos'));
  // Small delay to let keychain probe complete
  await new Promise(r => setTimeout(r, 500));
  setManySecretsSync({
    'LLM_APIKEY_ANTHROPIC_OAUTH': tokens.access,
    'ANTHROPIC_OAUTH_ACCESS':     tokens.access,
    'ANTHROPIC_OAUTH_REFRESH':    tokens.refresh,
  });
  console.log('  ✅ Secrets updated (file + keychain)');

  console.log('\n✅ Tokens saved to ~/.argos/config.json');
  console.log(`   Expires: ${new Date(tokens.expires).toLocaleString()}`);

  // Test the token with a real API call
  console.log('\n  ⋯ Testing token…');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type':   'application/json',
      'authorization':  `Bearer ${tokens.access}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages:   [{ role: 'user', content: 'hi' }],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (res.ok) {
    console.log('  ✅ Token works — API call successful\n');
  } else {
    const body = await res.text();
    console.error(`  ❌ Token test failed: ${res.status} — ${body.slice(0, 120)}\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});
