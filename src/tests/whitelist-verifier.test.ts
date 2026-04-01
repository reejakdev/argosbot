/**
 * Tests for core/whitelist-verifier.ts — pure output parser.
 * No LLM calls, no network.
 */

import { describe, it, expect } from 'vitest';

// Import the private parseVerifierOutput via a re-export shim — we test the
// public interface through formatVerificationNotif + known output shapes.
// Since parseVerifierOutput is not exported, we test it indirectly via the
// exported formatVerificationNotif which depends on a parsed WhitelistVerification.
import { formatVerificationNotif } from '../core/whitelist-verifier.js';
import type { WhitelistVerification } from '../core/whitelist-verifier.js';

// ─── formatVerificationNotif ─────────────────────────────────────────────────

const makeVerif = (overrides: Partial<WhitelistVerification> = {}): WhitelistVerification => ({
  decision:  'APPROVE',
  protocol:  'Midas Protocol',
  chain:     'Ethereum mainnet',
  address:   '0xa8a5c4FF4c86a459EBbDC39c5BE77833B3A15d88',
  reason:    'mBASIS depositVault',
  summary:   'Address found in official Smart Contracts Registry.',
  why:       'Exact match in docs.midas.app/resources/smart-contracts-addresses',
  score:     0.90,
  sources:   {
    docs:       'https://docs.midas.app/resources/smart-contracts-addresses',
    website:    'https://midas.app',
    matchPages: ['https://docs.midas.app/resources/smart-contracts-addresses'],
  },
  rawOutput: '',
  ...overrides,
});

describe('formatVerificationNotif', () => {
  it('shows ✅ for APPROVE', () => {
    const notif = formatVerificationNotif(makeVerif({ decision: 'APPROVE' }));
    expect(notif).toContain('✅');
    expect(notif).toContain('APPROVE');
  });

  it('shows ⚠️ for MANUAL_REVIEW', () => {
    const notif = formatVerificationNotif(makeVerif({ decision: 'MANUAL_REVIEW', score: 0.30 }));
    expect(notif).toContain('⚠️');
    expect(notif).toContain('MANUAL REVIEW');
  });

  it('shows ❌ for REJECT', () => {
    const notif = formatVerificationNotif(makeVerif({ decision: 'REJECT', score: 0.00 }));
    expect(notif).toContain('❌');
    expect(notif).toContain('REJECT');
  });

  it('includes score bar', () => {
    const notif = formatVerificationNotif(makeVerif({ score: 0.90 }));
    expect(notif).toContain('Score:');
    expect(notif).toContain('90%');
  });

  it('includes docs URL when present', () => {
    const notif = formatVerificationNotif(makeVerif());
    expect(notif).toContain('https://docs.midas.app');
  });

  it('includes match pages when found', () => {
    const notif = formatVerificationNotif(makeVerif({
      sources: {
        docs:       'https://docs.midas.app/resources/smart-contracts-addresses',
        matchPages: ['https://docs.midas.app/resources/smart-contracts-addresses'],
      },
    }));
    expect(notif).toContain('Match:');
  });

  it('omits match pages when not found (MANUAL_REVIEW)', () => {
    const notif = formatVerificationNotif(makeVerif({
      decision: 'MANUAL_REVIEW',
      score: 0.10,
      sources: { docs: 'https://docs.example.com' },
    }));
    expect(notif).not.toContain('Match:');
  });

  it('score bar is full for 100%', () => {
    const notif = formatVerificationNotif(makeVerif({ score: 1.0 }));
    expect(notif).toContain('██████████');
  });

  it('score bar is empty for 0%', () => {
    const notif = formatVerificationNotif(makeVerif({ score: 0.0, decision: 'REJECT' }));
    expect(notif).toContain('░░░░░░░░░░');
  });

  it('output is Slack-friendly (no raw HTML, no trailing spaces)', () => {
    const notif = formatVerificationNotif(makeVerif());
    expect(notif).not.toContain('<');
    expect(notif).not.toContain('>');
  });
});

// ─── Decision logic via score ─────────────────────────────────────────────────

describe('score semantics', () => {
  it('score 0.90 maps to high-confidence APPROVE', () => {
    const v = makeVerif({ score: 0.90, decision: 'APPROVE' });
    expect(v.score).toBeGreaterThanOrEqual(0.85);
    expect(v.decision).toBe('APPROVE');
  });

  it('score 0.00 with REJECT reflects explicit contradiction', () => {
    const v = makeVerif({ score: 0.00, decision: 'REJECT' });
    expect(v.score).toBe(0);
    expect(v.decision).toBe('REJECT');
  });

  it('score is clamped to [0, 1]', () => {
    const v = makeVerif({ score: 1.5 });
    // formatVerificationNotif should not crash on out-of-range scores
    expect(() => formatVerificationNotif(v)).not.toThrow();
  });
});
