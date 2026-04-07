/**
 * Anthropic OAuth — PKCE authorization code flow
 *
 * Mirrors the pi-ai/OpenClaw implementation:
 *   1. Open browser → claude.ai/oauth/authorize (PKCE)
 *   2. Listen on localhost:53692 for callback
 *   3. Exchange code → access_token + refresh_token
 *   4. Auto-refresh when expired
 *
 * Tokens are stored in ~/.argos/config.json → llm.providers.anthropic-oauth
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createLogger } from '../logger.js';

const log = createLogger('oauth');

// Cooldown for refresh-failed notifications (avoid spam)
let _lastRefreshFailNotify = 0;

// ─── Constants (same as pi-ai / Claude Code) ─────────────────────────────────

const CLIENT_ID = atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl');
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const MANUAL_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

// ─── PKCE ─────────────────────────────────────────────────────────────────────

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const buf = crypto.randomBytes(32);
  const verifier = buf.toString('base64url');
  const hash = crypto.createHash('sha256').update(verifier).digest();
  const challenge = hash.toString('base64url');
  return { verifier, challenge };
}

// ─── Token types ──────────────────────────────────────────────────────────────

export interface OAuthTokens {
  access: string;
  refresh: string;
  expires: number; // epoch ms — when access_token expires
}

// ─── Login flow ───────────────────────────────────────────────────────────────

/**
 * Start the full OAuth PKCE login flow.
 * Opens browser, listens for callback, exchanges code for tokens.
 *
 * @param openBrowser  called with the auth URL — open it in the user's browser
 * @param onManualInput  optional fallback — prompt user to paste code/URL manually
 */
export async function loginAnthropic(options: {
  openBrowser: (url: string) => void;
  onProgress?: (msg: string) => void;
  onManualInput?: () => Promise<string>;
}): Promise<OAuthTokens> {
  const { verifier, challenge } = await generatePKCE();

  const authParams = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
  });

  const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`;

  // Start local callback server
  let resolvedCode: string | null = null;
  let resolvedState: string | null = null;
  let redirectUriForExchange = REDIRECT_URI;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '', 'http://localhost');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>Auth Failed</h1><p>${error}</p>`);
      return;
    }

    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Auth Failed</h1><p>Missing code or state.</p>');
      return;
    }

    if (state !== verifier) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Auth Failed</h1><p>State mismatch.</p>');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Authenticated!</h1><p>Return to your terminal.</p></body></html>');

    resolvedCode = code;
    resolvedState = state;
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, resolve);
  });

  try {
    // Open browser
    options.openBrowser(authUrl);
    options.onProgress?.('Waiting for browser authentication…');

    // Wait for callback or manual input
    const waitForCallback = async (): Promise<void> => {
      while (!resolvedCode) {
        await new Promise((r) => setTimeout(r, 200));
      }
    };

    if (options.onManualInput) {
      // Race: callback server vs manual paste
      const manualPromise = options.onManualInput().then((input) => {
        if (!resolvedCode && input) {
          const parsed = parseAuthInput(input);
          if (parsed.code) {
            resolvedCode = parsed.code;
            resolvedState = parsed.state ?? verifier;
            redirectUriForExchange = MANUAL_REDIRECT_URI;
          }
        }
      });

      await Promise.race([waitForCallback(), manualPromise]);

      // If still no code, wait for whichever finishes
      if (!resolvedCode) {
        await Promise.race([waitForCallback(), manualPromise]);
      }
    } else {
      await waitForCallback();
    }

    if (!resolvedCode) {
      throw new Error('No authorization code received');
    }

    options.onProgress?.('Exchanging code for tokens…');
    return await exchangeCode(resolvedCode, resolvedState!, verifier, redirectUriForExchange);
  } finally {
    server.close();
  }
}

// ─── Token exchange ───────────────────────────────────────────────────────────

async function exchangeCode(
  code: string,
  state: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: ${res.status} — ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    // Expire 5 minutes early to avoid edge cases
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

// ─── Token refresh ────────────────────────────────────────────────────────────

export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthTokens> {
  log.debug('Refreshing Anthropic OAuth token…');

  // Note: scope in refresh can cause "invalid_scope" if the original login
  // used a different scope set. Omit scope to inherit from original grant.
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    // Notify owner via Telegram bot — refresh token expired (~30d) requires manual reauth
    // Cooldown: max 1 notification per hour to avoid spam
    const now = Date.now();
    if (now - _lastRefreshFailNotify > 3600_000) {
      _lastRefreshFailNotify = now;
      try {
        const { getSendToApprovalChat } = await import('../core/pipeline.js');
        const send = getSendToApprovalChat();
        send(
          '🔐 *Anthropic OAuth refresh failed*\n\n' +
          'Run `argos reauth` from terminal to re-authenticate.\n\n' +
          `Falling back to local LLM until then.`
        ).catch(() => {});
      } catch { /* not wired yet */ }
    }
    throw new Error(`Token refresh failed: ${res.status} — ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  log.debug('Token refreshed successfully');

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

// ─── Auto-refresh wrapper ─────────────────────────────────────────────────────

/**
 * Get a valid access token, refreshing if expired.
 * Updates the tokens in-place and calls onRefresh so the caller can persist.
 */
export async function getValidAccessToken(
  tokens: OAuthTokens,
  onRefresh?: (newTokens: OAuthTokens) => void,
): Promise<string> {
  if (Date.now() < tokens.expires) {
    return tokens.access;
  }

  // Long-lived tokens (sk-ant-oat01- from `claude setup-token`) have no refresh token
  // and don't need refresh — they're valid for ~1 year as-is
  if (!tokens.refresh) {
    log.warn('Access token expired but no refresh token available — token must be regenerated manually');
    return tokens.access;
  }

  log.info('Access token expired, refreshing…');
  const refreshed = await refreshAnthropicToken(tokens.refresh);

  // Update in-place
  tokens.access = refreshed.access;
  tokens.refresh = refreshed.refresh;
  tokens.expires = refreshed.expires;

  onRefresh?.(refreshed);
  return refreshed.access;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseAuthInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    /* not a URL */
  }

  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code, state };
  }

  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    };
  }

  return { code: value };
}
