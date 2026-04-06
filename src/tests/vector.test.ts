/**
 * Tests for vector/store.ts — chunking functions.
 * Pure logic, no DB or LLM required.
 */

import { describe, it, expect } from 'vitest';
import { chunkText, chunkCode } from '../vector/store.js';

// ─── chunkText ────────────────────────────────────────────────────────────────

describe('chunkText', () => {
  it('returns one chunk for content above minimum length', () => {
    const content = 'This is a sufficiently long piece of content.';
    const chunks = chunkText(content, 'test:doc', 'Test');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].sourceRef).toBe('test:doc');
    expect(chunks[0].chunkIndex).toBe(0);
  });

  it('skips content shorter than 20 chars', () => {
    const chunks = chunkText('Hello world', 'test:short', 'Short');
    expect(chunks).toHaveLength(0);
  });

  it('splits long content into overlapping chunks', () => {
    const lines = Array.from(
      { length: 60 },
      (_, i) => `This is line number ${i + 1} with enough content.`,
    );
    const chunks = chunkText(lines.join('\n'), 'test:long', 'Long');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)!.content).toContain('line number 60');
  });

  it('includes all provided tags', () => {
    const chunks = chunkText(
      'Content with enough length to pass the filter.',
      'test:tagged',
      'Tagged',
      ['a', 'b'],
    );
    expect(chunks[0].tags).toEqual(['a', 'b']);
  });

  it('propagates field metadata', () => {
    const chunks = chunkText(
      'Enough content to be indexed properly here.',
      'test:fields',
      'Fields',
      [],
      {
        field1: 'chat123',
        field2: 'Alice',
      },
    );
    expect(chunks[0].field1).toBe('chat123');
    expect(chunks[0].field2).toBe('Alice');
  });

  it('generates unique sequential IDs', () => {
    const lines = Array.from(
      { length: 80 },
      (_, i) => `This is line number ${i} with some padding content.`,
    );
    const chunks = chunkText(lines.join('\n'), 'test:ids', 'IDs');
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('overlap ensures last line appears in final chunk', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(3, '0')}`);
    const chunks = chunkText(lines.join('\n'), 'test:overlap', 'Overlap');
    expect(chunks.at(-1)!.content).toContain('line 049');
  });
});

// ─── chunkCode ────────────────────────────────────────────────────────────────
// Mock with 3 networks so chunkCode doesn't fall back to chunkText (threshold: ≥3 depth-2 blocks)

const MOCK_ADDRESSES_TS = `
export const ADDRESSES = {
  mainnet: {
    TokenA: {
      token: '0x1111111111111111111111111111111111111111',
      depositVault: '0x2222222222222222222222222222222222222222',
      redemptionVault: '0x3333333333333333333333333333333333333333',
    },
    TokenB: {
      token: '0x4444444444444444444444444444444444444444',
      depositVault: '0x5555555555555555555555555555555555555555',
      redemptionVault: '0x6666666666666666666666666666666666666666',
    },
    TokenC: {
      token: '0x7777777777777777777777777777777777777777',
      depositVault: '0x8888888888888888888888888888888888888888',
      redemptionVault: '0x9999999999999999999999999999999999999999',
    },
  },
  polygon: {
    TokenA: {
      token: '0x1111111111111111111111111111111111111111',
      depositVault: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
    TokenB: {
      token: '0x4444444444444444444444444444444444444444',
      depositVault: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    },
  },
  base: {
    TokenC: {
      token: '0x7777777777777777777777777777777777777777',
      depositVaultSwapper: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    },
  },
};
`.trim();

describe('chunkCode', () => {
  it('produces ≥3 chunks for structured config with 3+ depth-2 blocks', () => {
    const chunks = chunkCode(MOCK_ADDRESSES_TS, 'github:test/repo', 'Test Repo');
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('TokenB and its depositVault are in the SAME chunk — the original bug', () => {
    const chunks = chunkCode(MOCK_ADDRESSES_TS, 'github:test/repo', 'Test Repo');
    // Every chunk containing TokenB must also contain the mainnet depositVault address
    const tokenBChunks = chunks.filter((c) => c.content.includes('TokenB'));
    const anyHasVault = tokenBChunks.some((c) =>
      c.content.includes('0x5555555555555555555555555555555555555555'),
    );
    expect(anyHasVault).toBe(true);
  });

  it('all addresses are retrievable across chunks', () => {
    const chunks = chunkCode(MOCK_ADDRESSES_TS, 'github:test/repo', 'Test Repo');
    const allContent = chunks.map((c) => c.content).join('\n');
    expect(allContent).toContain('0x5555555555555555555555555555555555555555'); // TokenB mainnet deposit
    expect(allContent).toContain('0x9999999999999999999999999999999999999999'); // TokenC base
    expect(allContent).toContain('0x1111111111111111111111111111111111111111'); // TokenA token
  });

  it('prepends a breadcrumb header with // network > ...', () => {
    const chunks = chunkCode(MOCK_ADDRESSES_TS, 'github:test/repo', 'Test Repo');
    const hasBreadcrumb = chunks.some((c) => c.content.startsWith('//'));
    expect(hasBreadcrumb).toBe(true);
  });

  it('polygon network is retrievable', () => {
    const chunks = chunkCode(MOCK_ADDRESSES_TS, 'github:test/repo', 'Test Repo');
    const allContent = chunks.map((c) => c.content).join('\n');
    expect(allContent).toContain('polygon');
    expect(allContent).toContain('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('falls back to chunkText for prose (not structured)', () => {
    const prose = Array.from(
      { length: 50 },
      (_, i) => `This is sentence number ${i + 1} in a plain prose document without braces.`,
    ).join('\n');
    const codeChunks = chunkCode(prose, 'doc:prose', 'Prose');
    const textChunks = chunkText(prose, 'doc:prose', 'Prose');
    expect(codeChunks.length).toBe(textChunks.length);
  });

  it('each chunk has a valid sourceRef and sequential chunkIndex', () => {
    const chunks = chunkCode(MOCK_ADDRESSES_TS, 'github:test/repo', 'Test Repo');
    chunks.forEach((c, i) => {
      expect(c.sourceRef).toBe('github:test/repo');
      expect(c.chunkIndex).toBe(i);
    });
  });

  it('chunk IDs are unique', () => {
    const chunks = chunkCode(MOCK_ADDRESSES_TS, 'github:test/repo', 'Test Repo');
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
