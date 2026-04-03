/**
 * Tests for memory/store.ts — SQLite-backed memory with TTL and FTS5.
 * Uses a real in-process SQLite DB in a temp dir — no mocking.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDb } from '../db/index.js';
import { storeQuick, search, archive, purgeExpired } from '../memory/store.js';
import { getDb } from '../db/index.js';
import { monotonicFactory } from 'ulid';

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'argos-test-'));
  process.env.DATA_DIR = tmpDir;
  initDb(tmpDir);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── storeQuick ───────────────────────────────────────────────────────────────

describe('storeQuick', () => {
  it('stores a memory and returns an entry with an ID', () => {
    const entry = storeQuick('Alice sent a deposit request', 'task', ['alice']);
    expect(entry.id).toBeTruthy();
    expect(entry.content).toBe('Alice sent a deposit request');
    expect(entry.category).toBe('task');
    expect(entry.tags).toContain('alice');
  });

  it('respects custom ttlDays', () => {
    const tenDays = 10 * 24 * 60 * 60 * 1000;
    const entry = storeQuick('short-lived note', 'general', [], 10);
    expect(entry.expiresAt).toBeTruthy();
    const delta = entry.expiresAt! - Date.now();
    expect(delta).toBeGreaterThan(tenDays - 5_000);
    expect(delta).toBeLessThan(tenDays + 5_000);
  });

  it('default ttlDays is 30', () => {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const entry = storeQuick('default ttl entry', 'general');
    const delta = entry.expiresAt! - Date.now();
    expect(delta).toBeGreaterThan(thirtyDays - 10_000);
    expect(delta).toBeLessThan(thirtyDays + 10_000);
  });

  it('archived flag defaults to false', () => {
    const entry = storeQuick('non-archived', 'general');
    expect(entry.archived).toBe(false);
  });
});

// ─── search (FTS5) ────────────────────────────────────────────────────────────

describe('search', () => {
  it('finds a stored memory by keyword', () => {
    storeQuick('TokenA redemption vault address needed', 'task', ['copper']);
    const results = search({ query: 'TokenA redemption vault' });
    expect(results.some(r => r.content.includes('TokenA'))).toBe(true);
  });

  it('returns empty array for unmatched query', () => {
    const results = search({ query: 'xyzzy_nonexistent_12345' });
    expect(results).toHaveLength(0);
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      storeQuick(`limit test entry ${i}`, 'general');
    }
    const results = search({ query: 'limit test entry', limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('strips FTS5 special chars without throwing', () => {
    // Should not throw on special chars like +, -, ^, (, )
    expect(() => search({ query: 'hello-world (test) +urgent' })).not.toThrow();
  });
});

// ─── archive ─────────────────────────────────────────────────────────────────

describe('archive', () => {
  it('marks entry as archived with no expiry', () => {
    const entry = storeQuick('important decision to archive', 'general');
    archive(entry.id);

    const db = getDb();
    const row = db.prepare('SELECT archived, expires_at FROM memories WHERE id = ?').get(entry.id) as
      { archived: number; expires_at: number | null };

    expect(row.archived).toBe(1);
    expect(row.expires_at).toBeNull();
  });
});

// ─── purgeExpired ─────────────────────────────────────────────────────────────

describe('purgeExpired', () => {
  it('removes entries past their expiry', () => {
    const db   = getDb();
    const ulid = monotonicFactory();
    const id   = ulid();

    db.prepare(`
      INSERT INTO memories (id, content, tags, category, source_ref, importance, archived, expires_at, created_at)
      VALUES (?, ?, ?, 'general', ?, 5, 0, ?, ?)
    `).run(id, 'expired entry content', '[]', `test:${id}`, Date.now() - 1_000, Date.now() - 2_000);

    const count = purgeExpired();
    expect(count).toBeGreaterThanOrEqual(1);

    const row = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  it('does NOT remove archived entries', () => {
    const entry = storeQuick('archived — must survive purge', 'general');
    archive(entry.id);
    purgeExpired();

    const db  = getDb();
    const row = db.prepare('SELECT id FROM memories WHERE id = ?').get(entry.id);
    expect(row).toBeDefined();
  });

  it('does NOT remove entries that have not yet expired', () => {
    const entry = storeQuick('far future expiry', 'general', [], 365);
    purgeExpired();

    const db  = getDb();
    const row = db.prepare('SELECT id FROM memories WHERE id = ?').get(entry.id);
    expect(row).toBeDefined();
  });
});
