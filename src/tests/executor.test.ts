/**
 * Proposal executor tests — critical execution path.
 *
 * Uses a real SQLite DB + real token machinery.
 * LLM agent calls (executeWithAgent via runToolLoop) are mocked.
 *
 * Scenarios:
 *   Security gate:
 *     1. No token → blocked before any action runs
 *     2. Wrong token → blocked
 *     3. Expired token → blocked
 *
 *   Idempotency:
 *     4. execution_count > 0 → blocked (duplicate execution guard)
 *
 *   write_file action:
 *     5. Valid path → file written, result = executed
 *     6. Path traversal (../) → blocked, result = partial
 *     7. Absolute path → blocked, result = partial
 *
 *   Action outcomes:
 *     8. All actions succeed → proposal status = executed
 *     9. One action fails → proposal status = partial
 *    10. notifyUser called with execution summary
 *    11. execution_count incremented on every execution attempt
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDb, loadUlid, getDb } from '../db/index.js';
import { generateExecutionToken } from '../gateway/approval.js';
import { executeApprovedProposal } from '../workers/proposal-executor.js';

// ─── Mock LLM agent loop — avoids any network call ───────────────────────────

vi.mock('../llm/tool-loop.js', () => ({
  runToolLoop: vi.fn(async () => ({
    content: 'Action completed successfully',
    toolCalls: [],
    inputTokens: 10,
    outputTokens: 10,
  })),
}));

vi.mock('../llm/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../llm/index.js')>();
  return {
    ...real,
    callAnthropicBearerRaw: vi.fn(async () => ({
      content: 'done',
      toolCalls: [],
      inputTokens: 5,
      outputTokens: 5,
      model: 'mock',
    })),
  };
});

vi.mock('../mcp/client.js', () => ({
  getMcpTools: vi.fn(() => []),
  executeMcpTool: vi.fn(async () => ({ output: 'mcp result' })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
const llmConfig = {
  provider: 'anthropic' as const,
  model: 'claude-opus-4-6',
  apiKey: 'test',
  maxTokens: 1024,
  temperature: 0,
};

let _idCounter = 0;
function uid(): string {
  return `exec-test-${Date.now()}-${++_idCounter}`;
}

function insertProposal(opts: {
  id: string;
  actions: Array<{ tool: string; input?: Record<string, unknown>; details?: string }>;
  executionCount?: number;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO proposals (id, context_summary, plan, actions, status, created_at, expires_at, execution_count)
    VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)
  `).run(
    opts.id,
    'Test context summary',
    'Test plan',
    JSON.stringify(opts.actions),
    Date.now(),
    Date.now() + 30 * 60 * 1000,
    opts.executionCount ?? 0,
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'argos-executor-test-'));
  process.env.DATA_DIR = tmpDir;
  initDb(tmpDir);
  await loadUlid();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Security gate ────────────────────────────────────────────────────────────

describe('security gate', () => {
  it('missing token → execution blocked, returns error', async () => {
    const id = uid();
    insertProposal({ id, actions: [{ tool: 'write_file', input: { path: 'test.txt', content: 'hi' } }] });
    const notifications: string[] = [];

    const result = await executeApprovedProposal(
      id,
      llmConfig,
      async (t) => { notifications.push(t); },
      '', // no token
    );

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('invalid execution token');
    expect(notifications[0]).toContain('blocked');
  });

  it('wrong token → execution blocked', async () => {
    const id = uid();
    insertProposal({ id, actions: [{ tool: 'write_file', input: { path: 'test.txt', content: 'hi' } }] });
    generateExecutionToken(id); // generate real token but use wrong one

    const result = await executeApprovedProposal(
      id, llmConfig, async () => {}, 'a'.repeat(64),
    );

    expect(result.success).toBe(false);
  });

  it('expired token → execution blocked', async () => {
    const id = uid();
    insertProposal({ id, actions: [{ tool: 'write_file', input: { path: 'test.txt', content: 'hi' } }] });
    generateExecutionToken(id);
    getDb().prepare('UPDATE execution_tokens SET expires_at = ? WHERE proposal_id = ?')
      .run(Date.now() - 1000, id);
    const tokenRow = getDb().prepare('SELECT token FROM execution_tokens WHERE proposal_id = ?')
      .get(id) as { token: string };

    const result = await executeApprovedProposal(
      id, llmConfig, async () => {}, tokenRow.token,
    );

    expect(result.success).toBe(false);
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('execution_count > 0 → blocked as duplicate', async () => {
    const id = uid();
    insertProposal({ id, actions: [{ tool: 'write_file', input: { path: 'dup.txt', content: 'hi' } }], executionCount: 1 });
    const token = generateExecutionToken(id);

    const result = await executeApprovedProposal(
      id, llmConfig, async () => {}, token,
    );

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('Already executed');
  });
});

// ─── write_file action ────────────────────────────────────────────────────────

describe('write_file action', () => {
  it('writes file to data dir and returns executed status', async () => {
    const id = uid();
    insertProposal({
      id,
      actions: [{ tool: 'write_file', input: { path: 'output/hello.txt', content: 'hello world' } }],
    });
    const token = generateExecutionToken(id);

    const result = await executeApprovedProposal(id, llmConfig, async () => {}, token);

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(existsSync(join(tmpDir, 'output/hello.txt'))).toBe(true);
    expect(readFileSync(join(tmpDir, 'output/hello.txt'), 'utf8')).toBe('hello world');
    const row = getDb().prepare('SELECT status FROM proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('executed');
  });

  it('path traversal ../ → blocked, proposal partial', async () => {
    const id = uid();
    insertProposal({
      id,
      actions: [{ tool: 'write_file', input: { path: '../etc/evil.txt', content: 'bad' } }],
    });
    const token = generateExecutionToken(id);

    const result = await executeApprovedProposal(id, llmConfig, async () => {}, token);

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('traversal');
    const row = getDb().prepare('SELECT status FROM proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('partial');
  });

  it('absolute path → blocked', async () => {
    const id = uid();
    insertProposal({
      id,
      actions: [{ tool: 'write_file', input: { path: '/etc/evil.txt', content: 'bad' } }],
    });
    const token = generateExecutionToken(id);

    const result = await executeApprovedProposal(id, llmConfig, async () => {}, token);

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('traversal');
  });
});

// ─── Action outcomes ──────────────────────────────────────────────────────────

describe('action outcomes', () => {
  it('all actions succeed → proposal status = executed', async () => {
    const id = uid();
    insertProposal({
      id,
      actions: [
        { tool: 'write_file', input: { path: 'a.txt', content: 'a' } },
        { tool: 'write_file', input: { path: 'b.txt', content: 'b' } },
      ],
    });
    const token = generateExecutionToken(id);

    const result = await executeApprovedProposal(id, llmConfig, async () => {}, token);

    expect(result.success).toBe(true);
    const row = getDb().prepare('SELECT status FROM proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('executed');
  });

  it('one action fails → proposal status = partial', async () => {
    const id = uid();
    insertProposal({
      id,
      actions: [
        { tool: 'write_file', input: { path: 'good.txt', content: 'ok' } },
        { tool: 'write_file', input: { path: '../bad.txt', content: 'evil' } },
      ],
    });
    const token = generateExecutionToken(id);

    const result = await executeApprovedProposal(id, llmConfig, async () => {}, token);

    expect(result.success).toBe(false);
    expect(result.results.length).toBeGreaterThan(0); // at least one succeeded
    expect(result.errors.length).toBeGreaterThan(0);  // at least one failed
    const row = getDb().prepare('SELECT status FROM proposals WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('partial');
  });

  it('notifyUser called with execution summary', async () => {
    const id = uid();
    insertProposal({
      id,
      actions: [{ tool: 'write_file', input: { path: 'notify.txt', content: 'x' } }],
    });
    const token = generateExecutionToken(id);
    const notifications: string[] = [];

    await executeApprovedProposal(id, llmConfig, async (t) => { notifications.push(t); }, token);

    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[0]).toContain('executed');
  });

  it('execution_count incremented after execution', async () => {
    const id = uid();
    insertProposal({
      id,
      actions: [{ tool: 'write_file', input: { path: 'count.txt', content: 'x' } }],
    });
    const token = generateExecutionToken(id);

    await executeApprovedProposal(id, llmConfig, async () => {}, token);

    const row = getDb().prepare('SELECT execution_count FROM proposals WHERE id = ?').get(id) as { execution_count: number };
    expect(row.execution_count).toBe(1);
  });
});
