import { describe, it, expect, beforeEach } from 'vitest';
import { resolveCredential, redactCredential } from '../workers/credentials.js';

// ─── resolveCredential — config: prefix ──────────────────────────────────────

describe('resolveCredential config:', () => {
  it('resolves a key present in configSecrets', async () => {
    const cred = await resolveCredential('config:MY_TOKEN', { MY_TOKEN: 'secret-value' });
    expect(cred.value).toBe('secret-value');
  });

  it('rejects a key NOT in configSecrets even if it exists in process.env', async () => {
    process.env._TEST_LEAK = 'should-not-leak';
    await expect(resolveCredential('config:_TEST_LEAK', {})).rejects.toThrow(
      'not found in config.secrets',
    );
    delete process.env._TEST_LEAK;
  });

  it('rejects a key absent from both configSecrets and process.env', async () => {
    await expect(resolveCredential('config:NON_EXISTENT_KEY_XYZ', {})).rejects.toThrow(
      'not found in config.secrets',
    );
  });

  it('uses empty configSecrets when not provided — blocks all config: refs', async () => {
    process.env._TEST_KEY = 'leaked';
    await expect(resolveCredential('config:_TEST_KEY')).rejects.toThrow(
      'not found in config.secrets',
    );
    delete process.env._TEST_KEY;
  });
});

// ─── resolveCredential — unknown format ──────────────────────────────────────

describe('resolveCredential format validation', () => {
  it('throws on unknown ref format', async () => {
    await expect(resolveCredential('plaintext-ref')).rejects.toThrow(
      'Unknown credential ref format',
    );
  });

  it('throws when ref is empty', async () => {
    await expect(resolveCredential('')).rejects.toThrow('credential_ref is required');
  });
});

// ─── redactCredential ─────────────────────────────────────────────────────────

describe('redactCredential', () => {
  it('replaces all present fields with ***', () => {
    const redacted = redactCredential({ username: 'alice', password: 'hunter2', token: 'tok' });
    expect(redacted.username).toBe('***');
    expect(redacted.password).toBe('***');
    expect(redacted.token).toBe('***');
  });

  it('omits undefined fields', () => {
    const redacted = redactCredential({ username: 'alice' });
    expect(Object.keys(redacted)).toEqual(['username']);
  });

  it('returns empty object for empty credential', () => {
    expect(redactCredential({})).toEqual({});
  });
});

// ─── resolveCredential — vault: and op:// (mocked — require 1Password CLI) ───

describe('resolveCredential vault: / op:// without 1Password CLI', () => {
  beforeEach(() => {
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
  });

  it('throws when OP token is missing for vault: ref', async () => {
    await expect(resolveCredential('vault:MyItem')).rejects.toThrow('OP_SERVICE_ACCOUNT_TOKEN');
  });

  it('throws when OP token is missing for op:// ref', async () => {
    await expect(resolveCredential('op://vault/item/field')).rejects.toThrow(
      'OP_SERVICE_ACCOUNT_TOKEN',
    );
  });
});
