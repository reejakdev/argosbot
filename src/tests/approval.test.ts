/**
 * Approval gateway tests — critical security path.
 *
 * Tests the full approve → token flow without any network calls.
 * Uses a real SQLite DB (temp dir) and direct DB manipulation for fixtures.
 *
 * Scenarios:
 *   Risk enforcement:
 *     1. Low-risk → Telegram can approve (normal mode)
 *     2. Medium-risk → Telegram blocked, YubiKey required
 *     3. High-risk → Telegram blocked, YubiKey required
 *     4. cloudMode → ALL proposals blocked on Telegram, even low-risk
 *
 *   Execution token lifecycle:
 *     5. generateExecutionToken → stored in DB with 5min TTL
 *     6. validateAndConsumeToken → valid token → true, marked used
 *     7. validateAndConsumeToken → expired → false
 *     8. validateAndConsumeToken → already used → false
 *     9. validateAndConsumeToken → wrong token → false
 *    10. validateAndConsumeToken → no token → false
 *    11. validateAndConsumeToken → wrong-length token → false (no throw)
 *    12. Re-approval replaces old token (INSERT OR REPLACE)
 *
 *   Approval workflow:
 *    13. handleCallback approve low-risk → approved + token generated
 *    14. handleCallback approve medium-risk → blocked
 *    15. handleCallback reject → rejected
 *    16. handleCallback snooze → expiry extended by 1h
 *    17. handleCallback expired proposal → expired
 *    18. handleCallback unknown proposalId → not found
 *    19. handleCallback already approved → skipped
 *
 *   expireStaleApprovals:
 *    20. Marks past-expiry proposals as expired
 *    21. Does not touch proposals not yet expired
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDb, loadUlid, getDb } from '../db/index.js';
import {
  initApprovalGateway,
  proposalRequiresYubiKey,
  generateExecutionToken,
  validateAndConsumeToken,
  handleCallback,
  expireStaleApprovals,
} from '../gateway/approval.js';
import type { Proposal, ProposedAction } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
const sent: string[] = [];

function mockSend(_chatId: string, text: string): Promise<{ message_id: number }> {
  sent.push(text);
  return Promise.resolve({ message_id: 1 });
}

function makeAction(risk: 'low' | 'medium' | 'high'): ProposedAction {
  return {
    type: 'draft_reply',
    description: `${risk} risk action`,
    risk,
    payload: {},
    requiresApproval: true,
  };
}

let _idCounter = 0;
function uid(): string {
  return `test-${Date.now()}-${++_idCounter}`;
}

function insertProposal(opts: {
  id: string;
  risk: 'low' | 'medium' | 'high';
  status?: string;
  expiresAt?: number;
}): void {
  const db = getDb();
  const actions: ProposedAction[] = [makeAction(opts.risk)];
  db.prepare(`
    INSERT INTO proposals (id, context_summary, plan, actions, status, created_at, expires_at, execution_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    opts.id,
    'Test context',
    'Test plan',
    JSON.stringify(actions),
    opts.status ?? 'awaiting_approval',
    Date.now(),
    opts.expiresAt ?? Date.now() + 30 * 60 * 1000,
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'argos-approval-test-'));
  process.env.DATA_DIR = tmpDir;
  initDb(tmpDir);
  await loadUlid();
  // Normal mode by default
  initApprovalGateway(mockSend, 'test-chat-id', false);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  sent.length = 0;
});

// ─── Risk enforcement ─────────────────────────────────────────────────────────

describe('proposalRequiresYubiKey', () => {
  it('low-risk only → does not require YubiKey (normal mode)', () => {
    initApprovalGateway(mockSend, 'test-chat-id', false);
    expect(proposalRequiresYubiKey([makeAction('low')])).toBe(false);
  });

  it('medium-risk → requires YubiKey', () => {
    initApprovalGateway(mockSend, 'test-chat-id', false);
    expect(proposalRequiresYubiKey([makeAction('medium')])).toBe(true);
  });

  it('high-risk → requires YubiKey', () => {
    initApprovalGateway(mockSend, 'test-chat-id', false);
    expect(proposalRequiresYubiKey([makeAction('high')])).toBe(true);
  });

  it('mixed low + high → requires YubiKey', () => {
    initApprovalGateway(mockSend, 'test-chat-id', false);
    expect(proposalRequiresYubiKey([makeAction('low'), makeAction('high')])).toBe(true);
  });

  it('cloudMode ON → even low-risk requires YubiKey', () => {
    initApprovalGateway(mockSend, 'test-chat-id', true);
    expect(proposalRequiresYubiKey([makeAction('low')])).toBe(true);
    // Restore normal mode for subsequent tests
    initApprovalGateway(mockSend, 'test-chat-id', false);
  });
});

// ─── Execution token lifecycle ────────────────────────────────────────────────

describe('generateExecutionToken', () => {
  it('creates a token in execution_tokens with 5-min TTL', () => {
    const proposalId = uid();
    const token = generateExecutionToken(proposalId);
    expect(token).toHaveLength(64); // 32 bytes = 64 hex chars
    const db = getDb();
    const row = db.prepare('SELECT * FROM execution_tokens WHERE proposal_id = ?').get(proposalId) as {
      token: string; expires_at: number; used: number;
    };
    expect(row).toBeDefined();
    expect(row.token).toBe(token);
    expect(row.used).toBe(0);
    expect(row.expires_at).toBeGreaterThan(Date.now() + 4 * 60 * 1000); // > 4min remaining
  });

  it('re-approval replaces old token (INSERT OR REPLACE)', () => {
    const proposalId = uid();
    const token1 = generateExecutionToken(proposalId);
    const token2 = generateExecutionToken(proposalId);
    expect(token2).not.toBe(token1);
    const db = getDb();
    const rows = db.prepare('SELECT * FROM execution_tokens WHERE proposal_id = ?').all(proposalId);
    expect(rows).toHaveLength(1); // only one row, old replaced
  });
});

describe('validateAndConsumeToken', () => {
  it('valid token → returns true and marks as used', () => {
    const proposalId = uid();
    const token = generateExecutionToken(proposalId);
    expect(validateAndConsumeToken(proposalId, token)).toBe(true);
    const db = getDb();
    const row = db.prepare('SELECT used FROM execution_tokens WHERE proposal_id = ?').get(proposalId) as { used: number };
    expect(row.used).toBe(1);
  });

  it('already used token → returns false', () => {
    const proposalId = uid();
    const token = generateExecutionToken(proposalId);
    validateAndConsumeToken(proposalId, token); // consume
    expect(validateAndConsumeToken(proposalId, token)).toBe(false); // second attempt
  });

  it('expired token → returns false', () => {
    const proposalId = uid();
    generateExecutionToken(proposalId);
    // Manually expire the token
    getDb().prepare('UPDATE execution_tokens SET expires_at = ? WHERE proposal_id = ?')
      .run(Date.now() - 1000, proposalId);
    const token = getDb().prepare('SELECT token FROM execution_tokens WHERE proposal_id = ?')
      .get(proposalId) as { token: string };
    expect(validateAndConsumeToken(proposalId, token.token)).toBe(false);
  });

  it('wrong token → returns false', () => {
    const proposalId = uid();
    generateExecutionToken(proposalId);
    const wrongToken = 'a'.repeat(64);
    expect(validateAndConsumeToken(proposalId, wrongToken)).toBe(false);
  });

  it('no token for proposalId → returns false', () => {
    expect(validateAndConsumeToken(uid(), 'a'.repeat(64))).toBe(false);
  });

  it('wrong-length token → returns false without throwing', () => {
    const proposalId = uid();
    generateExecutionToken(proposalId);
    expect(() => validateAndConsumeToken(proposalId, 'short')).not.toThrow();
    expect(validateAndConsumeToken(proposalId, 'short')).toBe(false);
  });
});

// ─── handleCallback ───────────────────────────────────────────────────────────

describe('handleCallback', () => {
  it('approve low-risk → transitions to approved, generates execution token', async () => {
    initApprovalGateway(mockSend, 'test-chat-id', false);
    const id = uid();
    insertProposal({ id, risk: 'low' });

    let executionCalled = false;
    const result = await handleCallback(
      `approve:${id}`,
      'cb-1',
      async () => { executionCalled = true; },
    );

    expect(result).toContain('Approved');
    const db = getDb();
    const row = db.prepare('SELECT status FROM proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('approved');
    // Token must exist
    const tokenRow = db.prepare('SELECT used FROM execution_tokens WHERE proposal_id = ?').get(id);
    expect(tokenRow).toBeDefined();
  });

  it('approve medium-risk via Telegram → blocked, returns YubiKey message', async () => {
    initApprovalGateway(mockSend, 'test-chat-id', false);
    const id = uid();
    insertProposal({ id, risk: 'medium' });

    const result = await handleCallback(`approve:${id}`, 'cb-2', async () => {});

    expect(result).toContain('YubiKey');
    const db = getDb();
    const row = db.prepare('SELECT status FROM proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('awaiting_approval'); // unchanged
  });

  it('cloudMode: approve low-risk via Telegram → blocked', async () => {
    initApprovalGateway(mockSend, 'test-chat-id', true); // cloudMode ON
    const id = uid();
    insertProposal({ id, risk: 'low' });

    const result = await handleCallback(`approve:${id}`, 'cb-3', async () => {});

    expect(result).toContain('YubiKey');
    const db = getDb();
    const row = db.prepare('SELECT status FROM proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('awaiting_approval'); // still pending
    initApprovalGateway(mockSend, 'test-chat-id', false); // restore
  });

  it('reject → transitions proposal to rejected', async () => {
    const id = uid();
    insertProposal({ id, risk: 'low' });

    const result = await handleCallback(`reject:${id}`, 'cb-4', async () => {});

    expect(result).toContain('Rejected');
    const db = getDb();
    const row = db.prepare('SELECT status FROM proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('rejected');
  });

  it('snooze → extends expiry by ~1h', async () => {
    const id = uid();
    const originalExpiry = Date.now() + 5 * 60 * 1000; // 5 min from now
    insertProposal({ id, risk: 'low', expiresAt: originalExpiry });

    await handleCallback(`snooze:${id}`, 'cb-5', async () => {});

    const db = getDb();
    const row = db.prepare('SELECT expires_at FROM proposals WHERE id = ?').get(id) as { expires_at: number };
    expect(row.expires_at).toBeGreaterThan(originalExpiry + 50 * 60 * 1000); // at least 50min added
  });

  it('expired proposal → returns expiry message, marks as expired', async () => {
    const id = uid();
    insertProposal({ id, risk: 'low', expiresAt: Date.now() - 1000 }); // already expired

    const result = await handleCallback(`approve:${id}`, 'cb-6', async () => {});

    expect(result).toContain('expired');
    const db = getDb();
    const row = db.prepare('SELECT status FROM proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('expired');
  });

  it('unknown proposalId → returns not found', async () => {
    const result = await handleCallback('approve:nonexistent-id', 'cb-7', async () => {});
    expect(result).toContain('not found');
  });

  it('already approved proposal → skips', async () => {
    const id = uid();
    insertProposal({ id, risk: 'low', status: 'approved' });

    const result = await handleCallback(`approve:${id}`, 'cb-8', async () => {});

    expect(result).toContain('approved'); // already in that state
  });
});

// ─── expireStaleApprovals ─────────────────────────────────────────────────────

describe('expireStaleApprovals', () => {
  it('marks past-expiry awaiting proposals as expired', () => {
    const id = uid();
    insertProposal({ id, risk: 'low', expiresAt: Date.now() - 1000 });
    getDb().prepare(
      "INSERT INTO approvals (id, proposal_id, status, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?)"
    ).run(uid(), id, Date.now(), Date.now() - 1000);

    expireStaleApprovals();

    const row = getDb().prepare('SELECT status FROM proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('expired');
  });

  it('does not expire proposals with future expiry', () => {
    const id = uid();
    insertProposal({ id, risk: 'low', expiresAt: Date.now() + 60 * 60 * 1000 });

    expireStaleApprovals();

    const row = getDb().prepare('SELECT status FROM proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('awaiting_approval');
  });
});
