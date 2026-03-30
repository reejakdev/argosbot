import { loginAnthropic } from '../src/auth/anthropic-oauth.js';
import { exec } from 'child_process';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

async function main() {
  console.log('Starting OAuth login...');

  const tokens = await loginAnthropic({
    openBrowser: (url) => {
      console.log('Open this URL:');
      console.log(url);
      exec(`open "${url}"`);
    },
    onProgress: (msg) => console.log(msg),
  });

  console.log('Token prefix:', tokens.access.slice(0, 20));
  console.log('Expires:', new Date(tokens.expires).toLocaleString());

  // Save to config
  const cfgPath = process.env.HOME + '/.argos/config.json';
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const p = cfg.llm.providers['anthropic-oauth'];
  p.oauthAccess = tokens.access;
  p.oauthRefresh = tokens.refresh;
  p.oauthExpires = tokens.expires;
  p.apiKey = tokens.access;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  console.log('Saved to config!');

  // Test with raw fetch (NOT SDK — SDK adds headers that break OAuth)
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${tokens.access}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'claude-cli/2.1.75',
      'x-app': 'cli',
      'accept': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 64,
      stream: true,
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello', cache_control: { type: 'ephemeral' } }] }],
    }),
  });

  console.log('API Status:', res.status);
  const body = await res.text();
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const evt = JSON.parse(line.slice(6));
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') text += evt.delta.text;
    } catch {}
  }
  console.log('LLM TEST:', text || '(empty — check status above)');
}

main().catch(e => console.error('Failed:', e.message));
