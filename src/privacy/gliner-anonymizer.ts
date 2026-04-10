/**
 * GLiNER-based NER anonymizer — drop-in replacement for the LLM second pass.
 *
 * Calls a local GLiNER HTTP server (gliner_server.py) to detect PII spans
 * that regex missed: person names, org names, internal project/vault names, etc.
 *
 * Advantages over LLM:
 *   - No hallucination (span-only extraction — only returns text that exists)
 *   - ~50ms vs 1–3s latency
 *   - ~200MB model vs 4GB+ for a 7B LLM
 *   - Same placeholder system: PERSON_1, ORG_1, PROJECT_1, ADDR_1…
 *
 * Falls back silently to regex-only if the server is unreachable.
 *
 * Config:
 *   anonymizer.glinerUrl = "http://127.0.0.1:7688"   (default)
 */

import { createLogger } from '../logger.js';
import type { AnonymizedResult } from './anonymizer.js';
import type { LlmFinding, LlmAnonymizedResult } from './llm-anonymizer.js';

const log = createLogger('gliner-anonymizer');

const DEFAULT_URL = 'http://127.0.0.1:7688';
const TIMEOUT_MS = 5_000;

// ─── GLiNER server response shape ────────────────────────────────────────────

interface GlinerFinding {
  text: string;
  type: string;   // person | company | project | location | account | other
  confidence: 'high' | 'medium' | 'low';
  score: number;
}

interface GlinerResponse {
  findings: GlinerFinding[];
  model: string;
  text_length: number;
}

// ─── Apply GLiNER findings using the same placeholder logic as llm-anonymizer ─

function applyFindings(
  text: string,
  lookup: Record<string, string>,
  findings: GlinerFinding[],
  minConfidence: 'high' | 'medium' | 'low' = 'medium',
): { text: string; applied: number } {
  const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };
  const threshold = CONFIDENCE_RANK[minConfidence];

  // Continue numbering from existing placeholders
  const counters: Record<string, number> = {};
  for (const ph of Object.keys(lookup)) {
    const match = ph.match(/^\[([A-Z]+)_(\d+)\]$/);
    if (match) {
      const key = match[1];
      counters[key] = Math.max(counters[key] ?? 0, parseInt(match[2], 10));
    }
  }

  const typeToKey: Record<string, string> = {
    person:   'PERSON',
    company:  'ORG',
    project:  'PROJECT',
    location: 'LOC',
    account:  'ACCOUNT',
    other:    'PII',
  };

  let result = text;
  let applied = 0;
  const seen = new Map<string, string>(); // normalized → placeholder

  // High confidence first
  const sorted = [...findings].sort(
    (a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence],
  );

  for (const finding of sorted) {
    if (CONFIDENCE_RANK[finding.confidence] < threshold) continue;
    if (!result.includes(finding.text)) continue; // already replaced or wrong span

    const normalized = finding.text.toLowerCase();
    let placeholder = seen.get(normalized);

    if (!placeholder) {
      const key = typeToKey[finding.type] ?? 'PII';
      counters[key] = (counters[key] ?? 0) + 1;
      placeholder = `[${key}_${counters[key]}]`;
      seen.set(normalized, placeholder);
    }

    const escaped = finding.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = (result.match(new RegExp(escaped, 'gi')) ?? []).length;
    result = result.replace(new RegExp(escaped, 'gi'), placeholder);
    lookup[placeholder] = finding.text; // preserve for de-anonymization
    applied += count;
  }

  return { text: result, applied };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface GlinerOptions {
  url?: string;
  threshold?: number;             // GLiNER confidence threshold (0–1, default 0.4)
  minConfidence?: 'high' | 'medium' | 'low';
}

/**
 * Enhance an existing regex anonymization result with GLiNER NER.
 * Same signature as `enhanceWithLlm` — fully interchangeable.
 */
export async function enhanceWithGliner(
  regexResult: AnonymizedResult,
  options: GlinerOptions = {},
): Promise<LlmAnonymizedResult> {
  const url = options.url ?? DEFAULT_URL;
  const threshold = options.threshold ?? 0.4;
  const minConfidence = options.minConfidence ?? 'medium';

  const passthrough = (): LlmAnonymizedResult => ({
    ...regexResult,
    llmFindings: [],
    llmApplied: 0,
    tokensUsed: 0,
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`${url}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: regexResult.text, threshold }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      log.warn(`GLiNER server returned ${res.status} — skipping`);
      return passthrough();
    }

    const data = (await res.json()) as GlinerResponse;
    // Filter out findings that are already-redacted placeholders.
    // GLiNER sees text like "[EMAIL_1]" and may return "EMAIL_1" (without brackets) as an entity.
    const PLACEHOLDER_RE = /^(\[[A-Z]+_\d+\]|[A-Z]+_\d+)$/;
    const findings = (data.findings ?? []).filter((f) => !PLACEHOLDER_RE.test(f.text));

    log.debug(`GLiNER found ${findings.length} entities in ${regexResult.text.length} chars`);

    const extendedLookup = { ...regexResult.lookup };
    const { text, applied } = applyFindings(regexResult.text, extendedLookup, findings, minConfidence);

    if (applied > 0) {
      log.debug(`GLiNER applied ${applied} additional redactions`);
    }

    // Cast to LlmFinding[] for interface compatibility
    const llmFindings: LlmFinding[] = findings.map((f) => ({
      text: f.text,
      type: f.type as LlmFinding['type'],
      confidence: f.confidence,
    }));

    return {
      text,
      lookup: extendedLookup,
      llmFindings,
      llmApplied: applied,
      tokensUsed: 0, // GLiNER has no token cost
    };
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      log.warn('GLiNER server timeout — falling back to regex-only');
    } else {
      log.warn(`GLiNER unreachable — falling back to regex-only: ${e}`);
    }
    return passthrough();
  }
}

/**
 * Check if the GLiNER server is reachable.
 */
export async function isGlinerAvailable(url = DEFAULT_URL): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}
