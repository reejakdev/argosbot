/**
 * src/addons/example.ts — Reference template for an Argos addon.
 *
 * Copy this file to `index.ts` and edit it to register your own custom skills,
 * cron handlers, channels, etc.
 *
 *   cp src/addons/example.ts src/addons/index.ts
 *
 * Argos auto-loads `src/addons/index.ts` at boot if it exists. Failures are silent.
 *
 * To enable any skill you register here, add an entry under `skills` in
 * `~/.argos/.config.json`:
 *
 *   { "skills": [{ "name": "my_custom_echo", "enabled": true }] }
 */

import { registerSkill } from '../skills/registry.js';
import { createLogger } from '../logger.js';

const log = createLogger('addon:example');

// ─── Example: a trivial skill that echoes its input ─────────────────────────

registerSkill({
  name: 'my_custom_echo',
  description: 'Example addon skill — echoes the input message back. Replace with your own logic.',
  tool: {
    name: 'my_custom_echo',
    description:
      'Echo the provided text back. This is a placeholder example demonstrating how to add a custom skill via src/addons/.',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to echo back.',
        },
      },
      required: ['text'],
    },
  },
  handler: async (input) => {
    const text = String(input.text ?? '').trim();
    if (!text) return { success: false, output: 'Missing text input.' };
    log.info(`echoing: ${text}`);
    return { success: true, output: `Echo: ${text}` };
  },
});

// ─── More examples — uncomment and edit as needed ────────────────────────────

// import { registerHandler, upsertCronJob } from '../scheduler/index.js';
//
// registerHandler('my_morning_check', async () => {
//   log.info('running custom morning check');
//   // your logic here
// });
//
// upsertCronJob({
//   name: 'my_morning_check',
//   schedule: '0 7 * * *', // 7am daily
//   handler: 'my_morning_check',
//   enabled: true,
//   config: {},
// });

log.info('example addon loaded');
