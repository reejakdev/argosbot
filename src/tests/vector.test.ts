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
    const lines = Array.from({ length: 60 }, (_, i) => `This is line number ${i + 1} with enough content.`);
    const chunks = chunkText(lines.join('\n'), 'test:long', 'Long');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)!.content).toContain('line number 60');
  });

  it('includes all provided tags', () => {
    const chunks = chunkText('Content with enough length to pass the filter.', 'test:tagged', 'Tagged', ['a', 'b']);
    expect(chunks[0].tags).toEqual(['a', 'b']);
  });

  it('propagates field metadata', () => {
    const chunks = chunkText('Enough content to be indexed properly here.', 'test:fields', 'Fields', [], {
      field1: 'chat123',
      field2: 'Alice',
    });
    expect(chunks[0].field1).toBe('chat123');
    expect(chunks[0].field2).toBe('Alice');
  });

  it('generates unique sequential IDs', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `This is line number ${i} with some padding content.`);
    const chunks = chunkText(lines.join('\n'), 'test:ids', 'IDs');
    const ids = chunks.map(c => c.id);
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
    mTBILL: {
      token: '0xDD629E5241CbC5919847783e6C96B2De4754e438',
      depositVault: '0x99361435420048Bc1B2aC3B68A2Dd04Fecb00C6f',
      redemptionVault: '0x0c7501BF8e1e4dF7B48D86E4D28A3FbcB2B43AeC',
    },
    mBASIS: {
      token: '0x2a8c22E3b10036f3AEF5875d04f8441d4188b656',
      depositVault: '0xa8a5c4FF4c86a459EBbDC39c5BE77833B3A15d88',
      redemptionVault: '0x19AB19e61A930d08Be6E23Fae32f7e0D60b00C6b',
    },
    mHyperBTC: {
      token: '0x59D397F742DA0B0E59eDaf98C16E05D91bE6d9bA',
      depositVault: '0xD6e082f68b9d2B92B1C24dB3BD4c8e9c4Df4A7eE',
      redemptionVault: '0x16d4f955B0aA1b1570Fe3e9bB2f8c19C407cdb67',
    },
  },
  polygon: {
    mTBILL: {
      token: '0xDD629E5241CbC5919847783e6C96B2De4754e438',
      depositVault: '0xE0E38233F2f0dA3F9faDf5bA8B5B0E38d35F3A1c',
    },
    mBASIS: {
      token: '0x2a8c22E3b10036f3AEF5875d04f8441d4188b656',
      depositVault: '0xf3D210AaFfbcD7B09b2ec4B2C8E8B0bA5f5D1B4a',
    },
  },
  base: {
    mHyperBTC: {
      token: '0x59D397F742DA0B0E59eDaf98C16E05D91bE6d9bA',
      depositVaultSwapper: '0x16d4f955B0aA1b1570Fe3e9bB2f8c19C407cdb67',
    },
  },
};
`.trim();

describe('chunkCode', () => {
  it('produces ≥3 chunks for structured config with 3+ depth-2 blocks', () => {
    const chunks = chunkCode(MOCK_ADDRESSES_TS, 'github:test/repo', 'Test Repo');
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('mBASIS and its depositVault are in the SAME chunk — the original bug', () => {
    const chunks = chunkCode(MOCK_ADDRESSES_TS, 'github:test/repo', 'Test Repo');
    // Every chunk containing mBASIS must also contain the mainnet depositVault address
    const mBasisChunks = chunks.filter(c => c.content.includes('mBASIS'));
    const anyHasVault  = mBasisChunks.some(c =>
      c.content.includes('0xa8a5c4FF4c86a459EBbDC39c5BE77833B3A15d88'),
    );
    expect(anyHasVault).toBe(true);
  });

  it('all addresses are retrievable across chunks', () => {
    const chunks = chunkCode(MOCK_ADDRESSES_TS, 'github:test/repo', 'Test Repo');
    const allContent = chunks.map(c => c.content).join('\n');
    expect(allContent).toContain('0xa8a5c4FF4c86a459EBbDC39c5BE77833B3A15d88'); // mBASIS mainnet deposit
    expect(allContent).toContain('0x16d4f955B0aA1b1570Fe3e9bB2f8c19C407cdb67'); // mHyperBTC base
    expect(allContent).toContain('0xDD629E5241CbC5919847783e6C96B2De4754e438'); // mTBILL token
  });

  it('prepends a breadcrumb header with // network > ...', () => {
    const chunks = chunkCode(MOCK_ADDRESSES_TS, 'github:test/repo', 'Test Repo');
    const hasBreadcrumb = chunks.some(c => c.content.startsWith('//'));
    expect(hasBreadcrumb).toBe(true);
  });

  it('polygon network is retrievable', () => {
    const chunks = chunkCode(MOCK_ADDRESSES_TS, 'github:test/repo', 'Test Repo');
    const allContent = chunks.map(c => c.content).join('\n');
    expect(allContent).toContain('polygon');
    expect(allContent).toContain('0xE0E38233F2f0dA3F9faDf5bA8B5B0E38d35F3A1c');
  });

  it('falls back to chunkText for prose (not structured)', () => {
    const prose = Array.from({ length: 50 }, (_, i) =>
      `This is sentence number ${i + 1} in a plain prose document without braces.`
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
    const ids = chunks.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
