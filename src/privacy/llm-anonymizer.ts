/**
 * LLM-enhanced anonymization — second pass after regex.
 *
 * The regex anonymizer handles structured patterns (addresses, emails, amounts…).
 * This layer sends the already-partially-anonymized text to a language model
 * (preferably a small local model — no sensitive data leaves the machine) and
 * asks it to flag what regex missed:
 *   - Full person names not in knownPersons
 *   - Company / organization names
 *   - Internal project, vault, or account names
 *   - Specific location details
 *
 * Design:
 *   1. Regex pass runs first → text already partially redacted
 *   2. LLM receives the PARTIALLY anonymized text (less sensitive than raw)
 *   3. LLM returns JSON findings → applied on top of regex result
 *   4. Combined result returned with extended lookup table
 *
 * Recommended local models (via Ollama or LM Studio):
 *   - mistral-7b          (good balance — fast, accurate)
 *   - llama3.2:3b         (fast, lighter)
 *   - qwen2.5:7b          (strong at structured extraction)
 */

import { createLogger } from '../logger.js';
import { llmCall, type LLMConfig } from '../llm/index.js';
import type { AnonymizedResult } from './anonymizer.js';

const log = createLogger('llm-anonymizer');

// ─── Types ────────────────────────────────────────────────────────────────────

export type PiiCategory = 'person' | 'company' | 'project' | 'location' | 'account' | 'other';

export interface LlmFinding {
  text:       string;
  type:       PiiCategory;
  confidence: 'high' | 'medium' | 'low';
  reason?:    string;
}

export interface LlmAnonymizedResult extends AnonymizedResult {
  llmFindings:    LlmFinding[];
  llmApplied:     number;       // how many findings were actually applied
  tokensUsed:     number;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a PII (Personally Identifiable Information) detector for a privacy pipeline.

The text you receive has already been partially anonymized — structured patterns like crypto addresses, emails, and amounts have been replaced with placeholders (e.g. [ADDR_1], [EMAIL_1], [AMT_10K-100K_USDC]).

Your task: identify any REMAINING sensitive information that was NOT caught by the regex pass.

Look for:
- Full names of people (executives, employees, clients, counterparties)
- Company or organization names that appear in a sensitive context
- Internal project names, vault names, product names, fund names
- Specific location details (office addresses, cities tied to sensitive operations)
- Internal account references, contract IDs, deal names

Rules:
- Only flag text that actually appears in the input — no hallucinations
- Skip common words, generic titles (CEO, Director), and public company names used in passing
- Prefer high confidence over recall — false positives pollute the lookup table
- Placeholders like [ADDR_1] are already handled — skip them

Respond with ONLY a JSON array. No explanation outside the JSON.`;

function buildPrompt(partiallyAnonymizedText: string): string {
  return `Find remaining sensitive information in this partially-anonymized text:

---
${partiallyAnonymizedText.slice(0, 4000)}
---

Return JSON array of findings (return [] if clean):
[
  {
    "text": "exact string as it appears in the input",
    "type": "person | company | project | location | account | other",
    "confidence": "high | medium | low",
    "reason": "one-line explanation (optional)"
  }
]`;
}

// ─── LLM call + parse ─────────────────────────────────────────────────────────

async function detectWithLlm(
  text: string,
  llmConfig: LLMConfig,
): Promise<{ findings: LlmFinding[]; tokensUsed: number }> {
  const response = await llmCall(
    { ...llmConfig, temperature: 0 },
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: buildPrompt(text) },
    ],
  );

  const tokensUsed = response.inputTokens + response.outputTokens;

  try {
    const { extractJson } = await import('../llm/index.js');
    const raw = extractJson(response.content) as unknown;

    if (!Array.isArray(raw)) return { findings: [], tokensUsed };

    const findings: LlmFinding[] = (raw as Array<Record<string, unknown>>)
      .filter(f => typeof f.text === 'string' && f.text.length > 1)
      .map(f => ({
        text:       String(f.text),
        type:       (['person', 'company', 'project', 'location', 'account', 'other'].includes(String(f.type))
          ? f.type : 'other') as PiiCategory,
        confidence: (['high', 'medium', 'low'].includes(String(f.confidence))
          ? f.confidence : 'medium') as LlmFinding['confidence'],
        reason:     f.reason ? String(f.reason) : undefined,
      }));

    return { findings, tokensUsed };
  } catch (e) {
    log.warn('LLM anonymizer: failed to parse response', e);
    return { findings: [], tokensUsed };
  }
}

// ─── Apply findings ───────────────────────────────────────────────────────────

function applyFindings(
  text: string,
  lookup: Record<string, string>,
  findings: LlmFinding[],
  minConfidence: LlmFinding['confidence'] = 'medium',
): { text: string; applied: number } {
  const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };
  const threshold = CONFIDENCE_RANK[minConfidence];

  // Count existing placeholders per category prefix to continue numbering
  const counters: Record<string, number> = {};
  for (const ph of Object.keys(lookup)) {
    const match = ph.match(/^\[([A-Z]+)_(\d+)\]$/);
    if (match) {
      const key = match[1];
      counters[key] = Math.max(counters[key] ?? 0, parseInt(match[2], 10));
    }
  }

  const typeToKey: Record<PiiCategory, string> = {
    person:   'PERSON',
    company:  'ORG',
    project:  'PROJECT',
    location: 'LOC',
    account:  'ACCOUNT',
    other:    'PII',
  };

  let result = text;
  let applied = 0;

  // Deduplicate by text (case-insensitive), sort high confidence first
  const seen = new Map<string, string>(); // normalized text → placeholder
  const sorted = [...findings].sort(
    (a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence],
  );

  for (const finding of sorted) {
    if (CONFIDENCE_RANK[finding.confidence] < threshold) continue;
    // Skip if not actually present in current text (might already be replaced)
    if (!result.includes(finding.text)) continue;

    const normalized = finding.text.toLowerCase();

    let placeholder = seen.get(normalized);
    if (!placeholder) {
      const key = typeToKey[finding.type];
      counters[key] = (counters[key] ?? 0) + 1;
      placeholder = `[${key}_${counters[key]}]`;
      seen.set(normalized, placeholder);
    }

    // Escape for use in regex, replace all occurrences case-insensitively
    const escaped = finding.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = (result.match(new RegExp(escaped, 'gi')) ?? []).length;
    result = result.replace(new RegExp(escaped, 'gi'), placeholder);
    lookup[placeholder] = finding.text;
    applied += count;
  }

  return { text: result, applied };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface LlmAnonymizerOptions {
  /** Minimum confidence level to apply a finding (default: 'medium') */
  minConfidence?: LlmFinding['confidence'];
  /** Skip LLM call if regex already anonymized enough (default: false) */
  skipIfClean?: boolean;
}

/**
 * Enhance an existing regex anonymization result with an LLM second pass.
 *
 * @param regexResult  Output from `Anonymizer.anonymize()` — already partially redacted
 * @param llmConfig    LLM to use — prefer a local model (Ollama, LM Studio)
 * @param options      Tuning options
 */
export async function enhanceWithLlm(
  regexResult: AnonymizedResult,
  llmConfig: LLMConfig,
  options: LlmAnonymizerOptions = {},
): Promise<LlmAnonymizedResult> {
  const { minConfidence = 'medium', skipIfClean = false } = options;

  // If skipIfClean is set and regex already found many replacements, skip
  if (skipIfClean && Object.keys(regexResult.lookup).length > 10) {
    return {
      ...regexResult,
      llmFindings: [],
      llmApplied: 0,
      tokensUsed: 0,
    };
  }

  log.debug('Running LLM anonymization pass', {
    textLength: regexResult.text.length,
    regexReplacements: Object.keys(regexResult.lookup).length,
    model: llmConfig.model,
  });

  try {
    const { findings, tokensUsed } = await detectWithLlm(regexResult.text, llmConfig);

    log.debug(`LLM found ${findings.length} additional PII candidates`);

    const extendedLookup = { ...regexResult.lookup };
    const { text, applied } = applyFindings(
      regexResult.text,
      extendedLookup,
      findings,
      minConfidence,
    );

    log.debug(`Applied ${applied} LLM findings`, {
      applied,
      skipped: findings.length - applied,
      tokensUsed,
    });

    return {
      text,
      lookup: extendedLookup,
      llmFindings: findings,
      llmApplied: applied,
      tokensUsed,
    };
  } catch (e) {
    log.error('LLM anonymizer pass failed — returning regex-only result', e);
    return {
      ...regexResult,
      llmFindings: [],
      llmApplied: 0,
      tokensUsed: 0,
    };
  }
}
