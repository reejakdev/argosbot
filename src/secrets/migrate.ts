/**
 * Secret migration + config ref-resolution.
 *
 * Migration (one-time, at first boot with new code):
 *   Old .config had actual secret values in-line.
 *   This module extracts them → secrets store, replaces with "$KEY" references.
 *   After migration, .config contains no secret material.
 *
 * Resolution:
 *   "$KEY" strings anywhere in the config object are replaced with the
 *   actual value from the secrets store before Zod parsing.
 */

import { getAllSecretsSync, setManySecretsSync } from './store.js';

// ── Known field path → canonical secret key ────────────────────────────────────
// Extend this list as new integrations add apiKey fields.

export const SECRET_FIELD_MAP: Record<string, string> = {
  'notion.apiKey': 'NOTION_API_KEY',
  'linear.apiKey': 'LINEAR_API_KEY',
  'calendar.credentials.clientId': 'GOOGLE_CLIENT_ID',
  'calendar.credentials.clientSecret': 'GOOGLE_CLIENT_SECRET',
  'calendar.credentials.refreshToken': 'GOOGLE_REFRESH_TOKEN',
  'voice.whisperApiKey': 'WHISPER_API_KEY',
  'voice.elevenLabsApiKey': 'ELEVENLABS_API_KEY',
  'googleDrive.credentials.clientId': 'GOOGLE_DRIVE_CLIENT_ID',
  'googleDrive.credentials.clientSecret': 'GOOGLE_DRIVE_CLIENT_SECRET',
  'googleDrive.credentials.refreshToken': 'GOOGLE_DRIVE_REFRESH_TOKEN',
  'channels.telegram.personal.botToken': 'TELEGRAM_BOT_TOKEN',
  'channels.slack.personal.botToken': 'SLACK_BOT_TOKEN',
  'cloudflare.tunnel.token': 'CLOUDFLARE_TUNNEL_TOKEN',
};

// ── Dot-path helpers ────────────────────────────────────────────────────────────

function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  return dotPath
    .split('.')
    .reduce<unknown>(
      (cur, key) =>
        cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined,
      obj,
    );
}

function setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const segment = parts[i];
    if (!cur[segment] || typeof cur[segment] !== 'object') return;
    cur = cur[segment] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

// ── Migration ──────────────────────────────────────────────────────────────────

/**
 * Scan raw config object for actual secret values, move them to the secrets
 * store, and replace with "$KEY" references in-place.
 *
 * Returns the cleaned object + how many secrets were migrated.
 * Idempotent: already-"$REF" values are left alone.
 */
export function migrateSecretsFromRaw(raw: Record<string, unknown>): {
  cleaned: Record<string, unknown>;
  migrated: number;
} {
  const toStore: Record<string, string> = {};
  const cleaned = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

  // ── 1. secrets.* flat dict ──────────────────────────────────────────────────
  const secretsDict = cleaned.secrets;
  if (secretsDict && typeof secretsDict === 'object' && !Array.isArray(secretsDict)) {
    for (const [k, v] of Object.entries(secretsDict as Record<string, unknown>)) {
      if (typeof v === 'string' && v && !v.startsWith('$')) {
        toStore[k] = v;
        (cleaned.secrets as Record<string, string>)[k] = `$${k}`;
      }
    }
  }

  // ── 2. Known field paths ────────────────────────────────────────────────────
  for (const [fieldPath, secretKey] of Object.entries(SECRET_FIELD_MAP)) {
    const value = getNestedValue(cleaned, fieldPath);
    if (typeof value === 'string' && value && !value.startsWith('$')) {
      toStore[secretKey] = value;
      setNestedValue(cleaned, fieldPath, `$${secretKey}`);
    }
  }

  // ── 3. LLM provider apiKeys (dynamic provider IDs) ─────────────────────────
  const providers = (cleaned.llm as Record<string, unknown> | undefined)?.providers;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const [providerId, providerCfg] of Object.entries(providers as Record<string, unknown>)) {
      const cfg = providerCfg as Record<string, unknown> | null;
      if (cfg && typeof cfg.apiKey === 'string' && cfg.apiKey && !cfg.apiKey.startsWith('$')) {
        const secretKey = `LLM_APIKEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
        toStore[secretKey] = cfg.apiKey;
        cfg.apiKey = `$${secretKey}`;
      }
    }
  }

  // ── 4. MCP server env vars ─────────────────────────────────────────────────
  const mcpServers = cleaned.mcpServers;
  if (Array.isArray(mcpServers)) {
    for (const srv of mcpServers as Record<string, unknown>[]) {
      if (!srv || typeof srv !== 'object') continue;
      const env = srv.env as Record<string, string> | undefined;
      const name =
        typeof srv.name === 'string' ? srv.name.toUpperCase().replace(/[^A-Z0-9]/g, '_') : 'MCP';
      if (env && typeof env === 'object') {
        for (const [envKey, envVal] of Object.entries(env)) {
          if (typeof envVal === 'string' && envVal && !envVal.startsWith('$')) {
            const secretKey = `MCP_${name}_${envKey}`;
            toStore[secretKey] = envVal;
            env[envKey] = `$${secretKey}`;
          }
        }
      }
    }
  }

  if (Object.keys(toStore).length > 0) {
    setManySecretsSync(toStore);
  }

  return { cleaned, migrated: Object.keys(toStore).length };
}

// ── Resolution ─────────────────────────────────────────────────────────────────

/**
 * Walk a config object and replace any string value starting with "$"
 * with the corresponding secret from the store.
 *
 * Values that start with "$" but have no matching secret are left as-is
 * (they will fail Zod validation if the field is required, surfacing the issue
 * to the user rather than silently passing undefined).
 */
export function resolveSecretRefs(obj: unknown): unknown {
  const secrets = getAllSecretsSync();

  function walk(v: unknown): unknown {
    if (typeof v === 'string') {
      if (v.startsWith('$') && v.length > 1) {
        const key = v.slice(1);
        return secrets[key] ?? v;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        result[k] = walk(child);
      }
      return result;
    }
    return v;
  }

  return walk(obj);
}

/**
 * Reverse of resolveSecretRefs: replace actual secret values with "$KEY" refs.
 * Used before writing .config to ensure no secrets leak to disk.
 * Matches against the current secrets store — only known values are replaced.
 */
export function redactSecretsForDisk(obj: unknown): unknown {
  const secrets = getAllSecretsSync();
  // Build reverse map: value → key (only for non-trivial values)
  const reverseMap = new Map<string, string>();
  for (const [k, v] of Object.entries(secrets)) {
    if (v && v.length > 4) reverseMap.set(v, k);
  }

  function walk(v: unknown): unknown {
    if (typeof v === 'string') {
      const refKey = reverseMap.get(v);
      return refKey ? `$${refKey}` : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        result[k] = walk(child);
      }
      return result;
    }
    return v;
  }

  return walk(obj);
}
