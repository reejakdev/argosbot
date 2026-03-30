/**
 * Chat Guard — pre-check messages before sending to LLM.
 *
 * Two levels:
 * 1. AUTO-REDACT: private keys, API keys, seed phrases → replaced silently
 * 2. WARN: crypto addresses, large amounts, emails → ask user confirmation
 */

import { createLogger } from '../logger.js';

const log = createLogger('chat-guard');

export interface GuardResult {
  /** Sanitized text (auto-redacted) */
  sanitized: string;
  /** True if something was auto-redacted */
  redacted: boolean;
  /** What was redacted (for logging) */
  redactedItems: string[];
  /** True if user should confirm before sending */
  needsConfirmation: boolean;
  /** Warning message to show user */
  warningMessage?: string;
  /** Detected sensitive items that need confirmation */
  warnings: string[];
}

// ─── Auto-redact patterns (silently replaced, never sent to LLM) ──────────────

const AUTO_REDACT: Array<{ pattern: RegExp; label: string; replacement: string }> = [
  // Ethereum private keys (64 hex chars, optionally 0x prefixed)
  { pattern: /\b(0x)?[0-9a-fA-F]{64}\b/g, label: 'private key', replacement: '[PRIVATE_KEY_REDACTED]' },
  // Bitcoin WIF private keys
  { pattern: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g, label: 'BTC private key', replacement: '[PRIVATE_KEY_REDACTED]' },
  // Solana private keys (base58, 87-88 chars)
  { pattern: /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/g, label: 'SOL private key', replacement: '[PRIVATE_KEY_REDACTED]' },
  // BIP39 seed phrases (12 or 24 lowercase words)
  { pattern: /\b(?:[a-z]{3,8}\s){11}[a-z]{3,8}\b/g, label: 'seed phrase (12 words)', replacement: '[SEED_PHRASE_REDACTED]' },
  { pattern: /\b(?:[a-z]{3,8}\s){23}[a-z]{3,8}\b/g, label: 'seed phrase (24 words)', replacement: '[SEED_PHRASE_REDACTED]' },
  // API keys (common patterns)
  { pattern: /\b(sk-[a-zA-Z0-9_-]{20,})\b/g, label: 'API key (sk-)', replacement: '[API_KEY_REDACTED]' },
  { pattern: /\b(ghp_[a-zA-Z0-9]{36,})\b/g, label: 'GitHub token', replacement: '[API_KEY_REDACTED]' },
  { pattern: /\b(xox[bpas]-[a-zA-Z0-9-]{10,})\b/g, label: 'Slack token', replacement: '[API_KEY_REDACTED]' },
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, label: 'AWS access key', replacement: '[API_KEY_REDACTED]' },
  // Generic long hex secrets (>40 chars, likely a key)
  { pattern: /\b[0-9a-fA-F]{40,}\b/g, label: 'hex secret', replacement: '[HEX_SECRET_REDACTED]' },
];

// ─── Warning patterns (user must confirm) ─────────────────────────────────────

const WARN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Ethereum addresses
  { pattern: /\b0x[0-9a-fA-F]{40}\b/g, label: 'Ethereum address' },
  // Bitcoin addresses
  { pattern: /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, label: 'Bitcoin address' },
  { pattern: /\bbc1[a-zA-HJ-NP-Z0-9]{25,90}\b/g, label: 'Bitcoin bech32 address' },
  // Solana addresses (base58, 32-44 chars)
  { pattern: /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, label: 'Solana address' },
  // Email addresses
  { pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, label: 'email address' },
  // Large amounts ($10k+ or 10k+ with any currency/token)
  { pattern: /\$\s*[1-9]\d{4,}(?:[.,]\d+)?/g, label: 'large amount' },
  { pattern: /\b[1-9]\d{4,}(?:[.,]\d+)?\s*(?:USDC|USDT|ETH|BTC|SOL|DAI|EUR|USD|GBP|CHF|BUSD|WETH|WBTC|stETH|AAVE|UNI|LINK|MATIC|ARB|OP)\b/gi, label: 'large amount' },
  { pattern: /\b(?:USDC|USDT|ETH|BTC|SOL|DAI|EUR|USD)\s*[1-9]\d{4,}(?:[.,]\d+)?\b/gi, label: 'large amount' },
];

/**
 * Check a message for sensitive content before sending to LLM.
 */
export function guardMessage(text: string): GuardResult {
  let sanitized = text;
  const redactedItems: string[] = [];
  const warnings: string[] = [];

  // Step 1: Auto-redact (silent, no confirmation needed)
  for (const { pattern, label, replacement } of AUTO_REDACT) {
    const matches = sanitized.match(pattern);
    if (matches) {
      for (const match of matches) {
        // Don't redact short hex strings that are likely not keys
        if (label === 'hex secret' && match.length < 40) continue;
        // Don't redact if it looks like an address (40 hex = ETH address, handled in warnings)
        if (label === 'hex secret' && match.length === 40) continue;

        sanitized = sanitized.replace(match, replacement);
        redactedItems.push(`${label}: ${match.slice(0, 8)}…${match.slice(-4)}`);
        log.warn(`Auto-redacted ${label} from chat message`);
      }
    }
  }

  // Step 2: Check for warning patterns (need confirmation)
  for (const { pattern, label } of WARN_PATTERNS) {
    const matches = sanitized.match(pattern);
    if (matches) {
      for (const match of matches) {
        warnings.push(`${label}: ${match.slice(0, 20)}…`);
      }
    }
  }

  const needsConfirmation = warnings.length > 0;
  const warningMessage = needsConfirmation
    ? `⚠️ Sensitive data detected:\n${warnings.map(w => `• ${w}`).join('\n')}\n\nThis will be sent to the LLM. Continue? (reply "yes" to send, anything else to cancel)`
    : undefined;

  return {
    sanitized,
    redacted: redactedItems.length > 0,
    redactedItems,
    needsConfirmation,
    warningMessage,
    warnings,
  };
}
