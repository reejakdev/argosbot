/**
 * Whitelist verifier — "DOCS first" agent.
 *
 * Given a partner message requesting an address whitelist, this agent:
 *   1. Extracts protocol / address / chain / reason from the message
 *   2. Searches for the official documentation (docs.*, GitBook, /docs)
 *   3. Browses the docs and looks for an EXACT address match
 *   4. Returns a structured verdict: APPROVE / MANUAL_REVIEW / REJECT + score + sources
 *
 * Decision rules (from user spec):
 *   ✅ APPROVE       — address found in official docs with clear context
 *   ⚠️ MANUAL_REVIEW — address not found, missing info, or docs inaccessible
 *   ❌ REJECT        — official source EXPLICITLY contradicts (exhaustive list where address is absent)
 *
 * The agent uses web_search + fetch_url only — no memory, no side effects.
 * Runs in the bearer-auth tool loop (same as proposal-executor / telegram-bot).
 */

import { createLogger } from '../logger.js';
import type { LLMConfig } from '../llm/index.js';

const log = createLogger('whitelist-verifier');

// ─── Types ─────────────────────────────────────────────────────────────────────

export type WhitelistDecision = 'APPROVE' | 'MANUAL_REVIEW' | 'REJECT';

export interface WhitelistVerification {
  decision:  WhitelistDecision;
  protocol:  string;
  chain:     string;
  address:   string;
  reason:    string;
  summary:   string;
  why:       string;
  score:     number;          // 0.00–1.00
  sources: {
    docs?:        string;
    website?:     string;
    matchPages?:  string[];
  };
  rawOutput: string;          // full LLM response for debugging
  timedOut?: boolean;
}

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a "Whitelist — DOCS first" verification agent for a crypto/fintech company.
Your job: decide if a partner's whitelist request can be approved based on official protocol documentation.

## Rules

You MUST use web_search at least once.

Extract from the message (do NOT invent):
- protocol / project (or "unknown")
- address 0x… (or "missing address")
- chain(s) (or "unknown")
- reason / use-case (or "missing reason")
- any URLs present in the message

Then find ONLY:
- the official website of the protocol
- the official documentation (docs.*, official GitBook, /docs on official domain)
FORBIDDEN sources: blogs, Medium, CoinGecko, DefiLlama, DEXscreener, forums, Reddit.
Block explorers (Etherscan, Basescan, etc.) are NOT proof — do not cite them as official.

Priority: verify if the address appears in the official docs.
- Browse TOC / sidebar if GitBook or Nextra.
- Search for the exact address (case-insensitive).

## Decision

✅ APPROVE — address found in official docs with clear context (contract/treasury/module/vault).
⚠️ MANUAL_REVIEW — address not found in docs, missing info (address/reason/protocol/chain), or docs inaccessible.
❌ REJECT — only if an official source EXPLICITLY contradicts (e.g. exhaustive address list where this address is absent). Otherwise default to MANUAL_REVIEW, never REJECT speculatively.

## Score (0.00–1.00)
Start at 0.30
+0.50 if address found in official docs with clear context
+0.10 if the doc has a structured "Contracts / Deployments / Addresses" section
−0.30 if address NOT found in docs
−0.20 if protocol or chain unknown
−0.20 if reason is absent
Clamp to [0, 1].

## Output format (STRICT — Slack-friendly, 6–10 lines max)

✅/⚠️/❌ <DECISION> — <Protocol or unknown> — <Chain or unknown>
Summary: <one sentence>
Why it's ok to approve:
• <point 1>
• <point 2>
Score: 0.XX
Sources:
  Docs: <url>
  Website: <url>
  Match pages: <url1>, <url2>   ← ONLY if address was found

Do NOT add anything outside this format. No preamble. No explanation after.`;

// ─── Tool definitions (web_search + fetch_url only) ──────────────────────────

const VERIFIER_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web. Use DuckDuckGo-style queries.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    description: 'Fetch and read the text content of a URL (HTML is stripped). Use this to browse official documentation pages.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
  },
];

// ─── Output parser ─────────────────────────────────────────────────────────────

function parseVerifierOutput(raw: string): Omit<WhitelistVerification, 'rawOutput' | 'timedOut'> {
  const text = raw.trim();

  // Decision line: ✅/⚠️/❌ DECISION — Protocol — Chain
  const decisionMatch = text.match(/^([✅⚠️❌])\s*(APPROVE|MANUAL_REVIEW|MANUAL REVIEW|REJECT)\s*[—–-]\s*([^\n—–-]+?)\s*[—–-]\s*([^\n]+)/im);
  const rawDec   = (decisionMatch?.[2] ?? 'MANUAL_REVIEW').toUpperCase().replace(' ', '_');
  const decision = (['APPROVE', 'MANUAL_REVIEW', 'REJECT'].includes(rawDec) ? rawDec : 'MANUAL_REVIEW') as WhitelistDecision;
  const protocol = decisionMatch?.[3]?.trim() ?? 'unknown';
  const chain    = decisionMatch?.[4]?.trim() ?? 'unknown';

  // Extract fields
  const summaryMatch   = text.match(/Summary:\s*(.+)/i);
  const scoreMatch     = text.match(/Score:\s*([\d.]+)/i);
  const docsMatch      = text.match(/Docs:\s*(https?:\/\/\S+)/i);
  const websiteMatch   = text.match(/Website:\s*(https?:\/\/\S+)/i);
  const matchPageMatch = text.match(/Match pages?:\s*(.+)/i);
  const whyMatch       = text.match(/Why[^\n]*:\n([\s\S]*?)(?=Score:|Sources:|$)/i);

  const matchPages = matchPageMatch?.[1]
    ? matchPageMatch[1].split(',').map(u => u.trim()).filter(u => u.startsWith('http'))
    : [];

  // Address extraction — from the raw text (agent should echo it back in summary or Why)
  const addrMatch = text.match(/\b(0x[0-9a-fA-F]{40})\b/);

  return {
    decision,
    protocol,
    chain,
    address:  addrMatch?.[1] ?? 'missing address',
    reason:   'see summary',
    summary:  summaryMatch?.[1]?.trim() ?? text.slice(0, 120),
    why:      whyMatch?.[1]?.trim() ?? '',
    score:    Math.min(1, Math.max(0, parseFloat(scoreMatch?.[1] ?? '0.30'))),
    sources:  {
      docs:       docsMatch?.[1],
      website:    websiteMatch?.[1],
      matchPages: matchPages.length > 0 ? matchPages : undefined,
    },
  };
}

// ─── Main verifier ─────────────────────────────────────────────────────────────

const VERIFY_TIMEOUT_MS = 45_000; // 45s max — docs browsing takes time

export async function verifyWhitelistDocs(
  partnerMessage: string,
  llmConfig: LLMConfig,
): Promise<WhitelistVerification> {
  const start = Date.now();
  log.info(`Whitelist verification starting for message: "${partnerMessage.slice(0, 80)}"`);

  try {
    const { runToolLoop }              = await import('../llm/tool-loop.js');
    const { callAnthropicBearerRaw }   = await import('../llm/index.js');
    const { executeBuiltinTool }       = await import('../llm/builtin-tools.js');

    // Restrict executor to web_search + fetch_url only — no side effects
    const safeExecutor = async (name: string, input: Record<string, unknown>) => {
      if (name === 'web_search' || name === 'fetch_url') {
        return executeBuiltinTool(name, input);
      }
      return { output: `Tool "${name}" is not available in verification mode.`, error: true };
    };

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), VERIFY_TIMEOUT_MS),
    );

    const verifyPromise = runToolLoop(
      llmConfig,
      SYSTEM_PROMPT,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Partner whitelist request:\n\n${partnerMessage}` },
      ],
      VERIFIER_TOOLS,
      safeExecutor,
      callAnthropicBearerRaw,
    );

    const response = await Promise.race([verifyPromise, timeoutPromise]);
    const raw = response.content.trim();

    log.info(`Whitelist verification completed in ${Date.now() - start}ms`);
    log.debug(`Verifier raw output:\n${raw}`);

    return { ...parseVerifierOutput(raw), rawOutput: raw };

  } catch (e) {
    const isTimeout = e instanceof Error && e.message === 'TIMEOUT';
    log.warn(`Whitelist verification ${isTimeout ? 'timed out' : 'failed'}: ${e}`);

    return {
      decision:  'MANUAL_REVIEW',
      protocol:  'unknown',
      chain:     'unknown',
      address:   'unknown',
      reason:    'verification failed',
      summary:   isTimeout
        ? 'Verification timed out — manual review required.'
        : `Verification error: ${(e as Error).message?.slice(0, 80)}`,
      why:       '',
      score:     0.10,
      sources:   {},
      rawOutput: '',
      timedOut:  isTimeout,
    };
  }
}

// ─── Formatting helpers ────────────────────────────────────────────────────────

export function formatVerificationNotif(v: WhitelistVerification): string {
  const icons: Record<WhitelistDecision, string> = {
    APPROVE:       '✅',
    MANUAL_REVIEW: '⚠️',
    REJECT:        '❌',
  };
  const icon     = icons[v.decision];
  const clampedScore = Math.max(0, Math.min(1, v.score));
  const filled = Math.round(clampedScore * 10);
  const scoreBar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const scoreStr = `${scoreBar} ${(clampedScore * 100).toFixed(0)}%`;

  const lines = [
    `${icon} *${v.decision.replace('_', ' ')}* — ${v.protocol} — ${v.chain}`,
    `_${v.summary}_`,
    `Score: \`${scoreStr}\``,
  ];

  if (v.sources.docs) {
    lines.push(`Docs: ${v.sources.docs}`);
  }
  if (v.sources.matchPages?.length) {
    lines.push(`Match: ${v.sources.matchPages.slice(0, 2).join(', ')}`);
  }

  return lines.join('\n');
}
