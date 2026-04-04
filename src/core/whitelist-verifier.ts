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

## Verification steps (in order)

### Step 1 — Contract metadata
Use explorer_api to get: contract name, verified status, deployer address.
Pass the appropriate explorer base URL for the chain (e.g. https://api.hyperevmscan.io for HyperEVM, https://api.etherscan.io for Ethereum, https://api.basescan.org for Base).

### Step 2 — Deployer cross-reference
Take the deployer address from step 1.
Check if it's labeled on Etherscan or Basescan using explorer_api with the deployer address.
A labeled deployer ("LayerZero: Deployer", "Uniswap: Deployer", etc.) is strong secondary confirmation.
Also search GitHub: query "{deployer_address} site:github.com/LayerZero-Labs" or relevant org.

### Step 3 — Official docs
Find ONLY:
- the official website of the protocol
- the official documentation (docs.*, official GitBook, /docs on official domain)
FORBIDDEN sources: blogs, Medium, CoinGecko, DefiLlama, DEXscreener, forums, Reddit.
Block explorer HTML pages are NOT proof.

For LayerZero: check https://docs.layerzero.network/v2/developers/value-transfer-api/contracts/addresses (full address list) and https://docs.layerzero.network/v2/deployments/chains/{chain-slug}
For other protocols: search "{protocol} official contract addresses {chain}"

Priority: find the address in official docs OR confirm deployer is a known protocol deployer.

## Decision

✅ APPROVE — address found in official docs with clear context (contract/treasury/module/vault).
⚠️ MANUAL_REVIEW — address not found in docs, missing info (address/reason/protocol/chain), or docs inaccessible.
❌ REJECT — only if an official source EXPLICITLY contradicts (e.g. exhaustive address list where this address is absent). Otherwise default to MANUAL_REVIEW, never REJECT speculatively.

## Score (0.00–1.00)
Start at 0.30
+0.50 if address found in official docs with clear context
+0.20 if deployer is labeled on a major explorer as an official protocol deployer
+0.10 if explorer_api confirms contract is verified and name matches the expected protocol
+0.10 if the doc has a structured "Contracts / Deployments / Addresses" section
−0.20 if address NOT found in docs but deployer is confirmed
−0.40 if address NOT found in docs AND deployer is unlabeled/unknown
−0.20 if protocol or chain unknown
−0.10 if reason is absent
Clamp to [0, 1].

## Output format (STRICT — Slack-friendly, 6–10 lines max)

✅/⚠️/❌ <DECISION> — <Protocol or unknown> — <Chain or unknown>
Summary: <one sentence>
Why it's ok to approve:
• <point 1>
• <point 2>
Deployer: <deployer address> — <labeled / unlabeled>
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
  {
    name: 'explorer_api',
    description: 'Query a block explorer JSON API to get verified contract metadata (name, source, creator). Works on all Etherscan-compatible explorers. Pass the address and the explorer base URL (e.g. "https://api.etherscan.io", "https://api.basescan.org", "https://api.hyperevmscan.io").',
    input_schema: {
      type: 'object',
      properties: {
        address:      { type: 'string', description: 'Contract address (0x...)' },
        explorer_api: { type: 'string', description: 'Base API URL, e.g. https://api.etherscan.io' },
      },
      required: ['address', 'explorer_api'],
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

    // Restrict executor to web_search + fetch_url + explorer_api — no side effects
    const safeExecutor = async (name: string, input: Record<string, unknown>) => {
      if (name === 'web_search' || name === 'fetch_url') {
        return executeBuiltinTool(name, input);
      }
      if (name === 'explorer_api') {
        const address     = input.address as string;
        const explorerApi = (input.explorer_api as string).replace(/\/$/, '');
        try {
          // Etherscan-compatible: /api?module=contract&action=getsourcecode
          const url = `${explorerApi}/api?module=contract&action=getsourcecode&address=${address}`;
          const res = await fetch(url, { headers: { 'User-Agent': 'argos-verifier/1.0' }, signal: AbortSignal.timeout(10_000) });
          const json = await res.json() as { status: string; result: Array<{ ContractName?: string; CompilerVersion?: string; ABI?: string }> };
          if (json.status === '1' && json.result?.[0]) {
            const r = json.result[0] as { ContractName?: string; CompilerVersion?: string; ABI?: string };
            // Also fetch deployer via getcontractcreation
            let deployer = 'unknown';
            try {
              const creatorRes = await fetch(`${explorerApi}/api?module=contract&action=getcontractcreation&contractaddresses=${address}`, { signal: AbortSignal.timeout(5_000) });
              const creatorJson = await creatorRes.json() as { status: string; result: Array<{ contractCreator?: string }> };
              if (creatorJson.status === '1') deployer = creatorJson.result[0]?.contractCreator ?? 'unknown';
            } catch { /* non-fatal */ }
            return { output: `ContractName: ${r.ContractName ?? 'unknown'}\nCompiler: ${r.CompilerVersion ?? 'unknown'}\nVerified: yes\nDeployer: ${deployer}` };
          }
          // Blockscout format fallback: /api/v2/smart-contracts/{address}
          const baseUrl = explorerApi.replace(/\/api$/, '');
          const bsUrl = `${baseUrl}/api/v2/smart-contracts/${address}`;
          const bsRes = await fetch(bsUrl, { headers: { 'User-Agent': 'argos-verifier/1.0' }, signal: AbortSignal.timeout(10_000) });
          if (bsRes.ok) {
            const bsJson = await bsRes.json() as { name?: string; compiler_version?: string; is_verified?: boolean; deployed_bytecode?: unknown };
            // Blockscout: get deployer via /api/v2/addresses/{address}
            let deployer = 'unknown';
            try {
              const addrRes = await fetch(`${baseUrl}/api/v2/addresses/${address}`, { signal: AbortSignal.timeout(5_000) });
              if (addrRes.ok) {
                const addrJson = await addrRes.json() as { creator_address_hash?: string; creation_tx_hash?: string };
                deployer = addrJson.creator_address_hash ?? 'unknown';
              }
            } catch { /* non-fatal */ }
            return { output: `ContractName: ${bsJson.name ?? 'unknown'}\nCompiler: ${bsJson.compiler_version ?? 'unknown'}\nVerified: ${bsJson.is_verified ?? false}\nDeployer: ${deployer}` };
          }
          return { output: `No verified contract found at ${explorerApi} for ${address}` };
        } catch (e) {
          return { output: `explorer_api error: ${(e as Error).message}`, error: true };
        }
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
