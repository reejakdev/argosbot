import { buildSystemPrompt } from '../src/prompts/index.js';
import { loadConfig } from '../src/config/index.js';
import { callAnthropicBearerRaw, llmConfigFromConfig } from '../src/llm/index.js';
import { BUILTIN_TOOLS, executeBuiltinTool } from '../src/llm/builtin-tools.js';
import { runToolLoop } from '../src/llm/tool-loop.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

async function test() {
  const config = loadConfig();
  const llmConfig = llmConfigFromConfig(config);

  let systemPrompt = buildSystemPrompt('chat', config);

  const userMdPath = path.join(os.homedir(), '.argos', 'user.md');
  const isFirst = !fs.existsSync(userMdPath);
  console.log('First interaction:', isFirst);

  if (isFirst) {
    systemPrompt += `\n\n---\n## ONBOARDING MODE
You are meeting this user for the first time. You MUST:
1. Introduce yourself as Argos — security and privacy first.
2. Ask: What should I call you? What's your role? What language? What do you expect from me?
3. Be warm. Reply in the user's language.`;
  }

  console.log('System prompt:', systemPrompt.length, 'chars');
  console.log('Tools:', BUILTIN_TOOLS.map(t => t.name).join(', '));

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: 'Salut' },
  ];

  const response = await runToolLoop(
    llmConfig, systemPrompt, messages,
    BUILTIN_TOOLS, executeBuiltinTool, callAnthropicBearerRaw,
  );

  console.log('\n=== RESPONSE ===');
  console.log(response.content);
  console.log('Tokens:', response.inputTokens, 'in /', response.outputTokens, 'out');
}

test().catch(e => console.error('FAIL:', e.message?.slice(0, 300)));
