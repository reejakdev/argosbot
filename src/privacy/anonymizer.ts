/**
 * Regex-based anonymizer — no LLM dependency, runs locally.
 * Handles crypto-specific patterns: ETH/BTC/Solana addresses, tx hashes,
 * ENS names, plus generic PII: emails, phone numbers, names from config.
 *
 * Returns anonymized text + a lookup table to re-identify locally.
 */

import { createLogger } from '../logger.js';
import type { AnonymizerConfig } from '../config/schema.js';

const log = createLogger('anonymizer');

export interface AnonymizedResult {
  text: string;
  // Maps placeholder → original value (stored locally only, never sent to LLM)
  lookup: Record<string, string>;
}

type PatternEntry = {
  key: string;                      // e.g. 'ETH_ADDR', 'EMAIL'
  regex: RegExp;
  label: (i: number) => string;     // e.g. (i) => `ADDR_${i}`
};

// ─── Pattern registry ─────────────────────────────────────────────────────────

const CRYPTO_PATTERNS: PatternEntry[] = [
  // Ethereum / EVM addresses (0x + 40 hex chars)
  {
    key: 'ETH_ADDR',
    regex: /\b0x[0-9a-fA-F]{40}\b/g,
    label: i => `[ADDR_${i}]`,
  },
  // Transaction hashes (0x + 64 hex chars)
  {
    key: 'TX_HASH',
    regex: /\b0x[0-9a-fA-F]{64}\b/g,
    label: i => `[TXHASH_${i}]`,
  },
  // ENS names (.eth domains)
  {
    key: 'ENS',
    regex: /\b[\w-]+\.eth\b/gi,
    label: i => `[ENS_${i}]`,
  },
  // Bitcoin legacy addresses (1... or 3...)
  {
    key: 'BTC_LEGACY',
    regex: /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g,
    label: i => `[BTC_${i}]`,
  },
  // Bitcoin bech32 (bc1...)
  {
    key: 'BTC_BECH32',
    regex: /\bbc1[a-zA-HJ-NP-Z0-9]{6,87}\b/g,
    label: i => `[BTC_${i}]`,
  },
  // Solana addresses (base58, 32-44 chars, starting with common prefixes)
  {
    key: 'SOL_ADDR',
    regex: /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g,
    label: i => `[SOL_${i}]`,
  },
];

const PII_PATTERNS: PatternEntry[] = [
  // Email addresses
  {
    key: 'EMAIL',
    regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    label: i => `[EMAIL_${i}]`,
  },
  // Phone numbers (international formats)
  {
    key: 'PHONE',
    regex: /(?:\+|00)[1-9]\d{7,14}\b|\b\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}\b/g,
    label: i => `[PHONE_${i}]`,
  },
  // IP addresses
  {
    key: 'IP',
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    label: i => `[IP_${i}]`,
  },
  // URLs with credentials (http://user:pass@...)
  {
    key: 'URL_CRED',
    regex: /https?:\/\/[^:]+:[^@]+@[^\s]+/g,
    label: i => `[URL_CRED_${i}]`,
  },
  // API keys / secrets (long alphanumeric strings prefixed by common patterns)
  {
    key: 'SECRET',
    regex: /(?:sk-|pk-|Bearer\s+)[A-Za-z0-9\-_]{20,}/g,
    label: i => `[SECRET_${i}]`,
  },
];

// Amount bucketing: replace exact amounts with ranges
const AMOUNT_REGEX = /(?:€|\$|USD|EUR|USDC|USDT|ETH|BTC|SOL)\s*[\d,.']+(?:\.\d+)?|[\d,.']+(?:\.\d+)?\s*(?:€|\$|USD|EUR|USDC|USDT|ETH|BTC|SOL)/gi;

function bucketAmount(raw: string): string {
  const numStr = raw.replace(/[^0-9.]/g, '');
  const n = parseFloat(numStr);
  if (isNaN(n)) return '[AMT_?]';
  const currency = raw.match(/€|\$|USD|EUR|USDC|USDT|ETH|BTC|SOL/i)?.[0]?.toUpperCase() ?? '';
  if (n < 1_000)       return `[AMT_<1K_${currency}]`;
  if (n < 10_000)      return `[AMT_1K-10K_${currency}]`;
  if (n < 100_000)     return `[AMT_10K-100K_${currency}]`;
  if (n < 1_000_000)   return `[AMT_100K-1M_${currency}]`;
  return `[AMT_>1M_${currency}]`;
}

// ─── Main anonymizer ──────────────────────────────────────────────────────────

export class Anonymizer {
  private counters: Record<string, number> = {};
  private seenValues: Map<string, string> = new Map(); // value → placeholder

  constructor(private config: Pick<AnonymizerConfig, 'mode' | 'knownPersons' | 'knownAddresses' | 'bucketAmounts' | 'customPatterns'>) {}

  anonymize(text: string): AnonymizedResult {
    if (this.config.mode === 'none') {
      return { text, lookup: {} };
    }

    const lookup: Record<string, string> = {};
    let result = text;

    // 0. Replace known addresses from config first (most specific)
    for (const addr of this.config.knownAddresses) {
      if (!addr) continue;
      const placeholder = this.getOrCreate(addr, 'KNOWN_ADDR', lookup);
      result = result.split(addr).join(placeholder);
    }

    // 1. Replace known persons from config
    for (const name of this.config.knownPersons) {
      if (!name) continue;
      const regex = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');
      result = result.replace(regex, () => {
        const ph = this.getOrCreate(name, 'PERSON', lookup);
        return ph;
      });
    }

    // 2. Crypto patterns — run before generic PII to avoid partial overlap
    for (const entry of CRYPTO_PATTERNS) {
      result = result.replace(entry.regex, (match) => {
        // Skip Solana false positives — too short
        if (entry.key === 'SOL_ADDR' && match.length < 32) return match;
        return this.getOrCreate(match, entry.key, lookup);
      });
    }

    // 3. PII patterns
    for (const entry of PII_PATTERNS) {
      result = result.replace(entry.regex, (match) => {
        return this.getOrCreate(match, entry.key, lookup);
      });
    }

    // 4. Amount bucketing
    if (this.config.bucketAmounts) {
      result = result.replace(AMOUNT_REGEX, (match) => {
        const bucket = bucketAmount(match);
        lookup[bucket] = match; // always log for audit
        return bucket;
      });
    }

    // 5. Custom patterns from config
    for (const cp of this.config.customPatterns) {
      try {
        const regex = new RegExp(cp.pattern, 'g');
        result = result.replace(regex, cp.replacement);
      } catch (e) {
        log.warn(`Invalid custom pattern: ${cp.pattern}`, e);
      }
    }

    log.debug('Anonymized', {
      originalLength: text.length,
      redactedLength: result.length,
      replacements: Object.keys(lookup).length,
    });

    return { text: result, lookup };
  }

  private getOrCreate(value: string, key: string, lookup: Record<string, string>): string {
    const normalized = value.toLowerCase();
    if (this.seenValues.has(normalized)) {
      const ph = this.seenValues.get(normalized)!;
      lookup[ph] = value;
      return ph;
    }
    this.counters[key] = (this.counters[key] ?? 0) + 1;
    const placeholder = `[${key}_${this.counters[key]}]`;
    this.seenValues.set(normalized, placeholder);
    lookup[placeholder] = value;
    return placeholder;
  }

  // Reset counters between documents (call between unrelated contexts)
  reset(): void {
    this.counters = {};
    this.seenValues = new Map();
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Singleton factory — creates one anonymizer per config
let _anonymizer: Anonymizer | null = null;
export function getAnonymizer(config: Anonymizer['config']): Anonymizer {
  if (!_anonymizer) _anonymizer = new Anonymizer(config);
  return _anonymizer;
}
