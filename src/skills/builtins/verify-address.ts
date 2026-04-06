/**
 * verify_protocol_address skill
 *
 * Runs a sub-agent that checks whether a partner-provided address is officially
 * documented by the named protocol — DOCS FIRST, no third-party sources.
 *
 * The skill spins up its own LLM tool-use loop (web_search + fetch_url) with
 * a strict system prompt, then returns a short Slack-friendly verdict.
 *
 * Enabled via config:
 *   { "name": "verify_protocol_address", "enabled": true }
 *
 * No API key required — uses the same LLM as the main planner.
 */

import { registerSkill } from '../registry.js';

const SYSTEM_PROMPT = `Tu es un agent "Whitelist — DOCS first".
Tu vas recevoir un message brut d'un partenaire.
Ta mission : décider si on peut approuver une whitelist d'adresse, en te basant d'abord sur la documentation officielle du protocole.

Règles :
- Tu DOIS utiliser web_search et fetch_url avant de répondre.
- Tu dois extraire depuis le message (sans inventer) :
    • protocole / projet (sinon "unknown")
    • adresse 0x… ou adresse Solana (sinon "missing address")
    • chaîne(s) (sinon "unknown")
    • raison / use-case (sinon "missing reason")
    • URLs présentes dans le message
- Tu dois trouver UNIQUEMENT :
    • le site officiel du protocole
    • la documentation officielle (docs.*, GitBook officiel, /docs sur domaine officiel)
    INTERDIT : blogs, Medium, Coingecko, Defillama, DEXscreener, forums.
    Les explorers (Etherscan, Basescan…) ne comptent PAS comme preuve officielle.
- Priorité absolue : vérifier si l'adresse apparaît dans la doc officielle.
    • Parcours le TOC / sidebar si GitBook/Next.
    • Cherche l'adresse exact-match (case-insensitive).

Décision :
- ✅ APPROVE seulement si l'adresse est trouvée dans la doc officielle avec contexte clair.
- ⚠️ MANUAL REVIEW si adresse non trouvée dans docs, infos manquantes, ou docs inaccessibles.
- ❌ REJECT uniquement si une source officielle contredit explicitement (liste exhaustive où l'adresse est absente) — sinon préfère MANUAL REVIEW.

Score (0.00–1.00) :
  base 0.30
  +0.50 si adresse trouvée dans docs officielles avec contexte clair
  +0.10 si la doc a une section "Contracts/Deployments/Addresses" structurée
  -0.30 si adresse non trouvée dans docs
  -0.20 si protocole ou chain inconnus
  -0.20 si raison absente
  clamp 0..1

FORMAT DE SORTIE (obligatoire, 6–10 lignes, Slack-friendly) :
✅/⚠️/❌ <DECISION> — <Protocol ou unknown> — <Chain ou unknown>
Summary: …
Why it's ok to approve:
• …
• …
Score: 0.xx
Sources:
• Docs: <url>
• Website: <url>
• Match pages: <url1>, <url2>  (uniquement si adresse trouvée)`;

registerSkill({
  name: 'verify_protocol_address',
  description:
    'Verify that a partner-provided crypto address is officially documented by the named protocol. DOCS FIRST — cross-checks against official documentation only.',
  tool: {
    name: 'verify_protocol_address',
    description:
      'Verify that a crypto address claimed by a partner matches the official documentation of the named protocol. Returns APPROVE / MANUAL REVIEW / REJECT with a score and sources. Use whenever a partner asks to whitelist or use a specific contract/wallet address.',
    input_schema: {
      type: 'object',
      properties: {
        partner_message: {
          type: 'string',
          description:
            'The raw partner message requesting address whitelisting or mentioning an address to use. Include the full message as received.',
        },
      },
      required: ['partner_message'],
    },
  },
  handler: async (input, cfg) => {
    const partnerMessage = String(input.partner_message ?? '').trim();
    if (!partnerMessage) {
      return { success: false, output: 'Missing partner_message input.' };
    }

    // Use the global config to get LLM settings
    const { getConfig } = await import('../../config/index.js');
    const { llmConfigFromConfig, callWithTools, buildToolResultMessages } =
      await import('../../llm/index.js');
    const { executeBuiltinTool, BUILTIN_TOOLS } = await import('../../llm/builtin-tools.js');
    const { createLogger } = await import('../../logger.js');
    const log = createLogger('skill:verify-address');

    const config = getConfig();
    const llmCfg = {
      ...llmConfigFromConfig(config),
      temperature: 0, // deterministic — this is a verification task
      maxTokens: (cfg.maxTokens as number | undefined) ?? 2048,
    };

    // Sub-agent tools: web_search + fetch_url only
    type ToolDef = { name: string; description: string; input_schema: unknown };
    const tools: ToolDef[] = BUILTIN_TOOLS.filter(
      (t) => t.name === 'web_search' || t.name === 'fetch_url',
    ) as ToolDef[];

    const messages: unknown[] = [
      { role: 'user', content: `Vérifie cette adresse pour moi :\n\n${partnerMessage}` },
    ];

    let verdict = '';
    let iterations = 0;
    const MAX_ITER = 6; // bounded — web fetches are slow

    while (iterations < MAX_ITER) {
      iterations++;
      const step = await callWithTools(llmCfg, SYSTEM_PROMPT, messages, tools);

      if (step.text) verdict = step.text;

      if (step.done || step.toolCalls.length === 0) break;

      // Execute web_search / fetch_url calls
      const feedbacks: Array<{ id: string; content: string }> = [];
      for (const call of step.toolCalls) {
        log.debug(`verify-address tool call: ${call.name}`);
        const result = await executeBuiltinTool(call.name, call.input);
        feedbacks.push({ id: call.id, content: result.output });
      }

      messages.push(...buildToolResultMessages(llmCfg, step._rawAssistant, feedbacks));
    }

    if (!verdict) {
      return { success: false, output: 'Sub-agent returned no verdict after web search.' };
    }

    return { success: true, output: verdict };
  },
});
