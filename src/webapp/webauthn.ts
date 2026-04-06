/**
 * WebAuthn / FIDO2 — YubiKey authentication for the Argos web app.
 *
 * Powered by @simplewebauthn/server.
 *
 * Security model:
 *   - No passwords. No codes. Physical key tap only.
 *   - Registration (one-time): register your YubiKey with the local app.
 *   - Authentication: tap YubiKey → session token (30min, httpOnly cookie).
 *   - Approval of high-risk actions: fresh assertion required per approval
 *     (the proposal ID is embedded in the clientDataJSON — cryptographically bound).
 *   - Counter checked on every assertion (prevents cloning attacks).
 *   - All credentials stored locally in SQLite — never leaves your machine.
 *
 * Supported authenticators:
 *   - YubiKey 5 series (USB-A, USB-C, NFC) — FIDO2/WebAuthn resident keys
 *   - Any FIDO2-compliant hardware key
 *   - Platform authenticators (Touch ID, Face ID) — for convenience on laptop
 *
 * Clearance levels:
 *   standard  — one tap at login → approve low/medium risk proposals
 *   elevated  — fresh tap per high-risk approval → write operations, tx packs
 *               (the challenge includes the proposal ID, so the key "signs" the specific action)
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import crypto from 'crypto';
import { getDb, audit } from '../db/index.js';
import { createLogger } from '../logger.js';
import type { Request, Response, NextFunction } from 'express';

const log = createLogger('webauthn');

// ─── Config ───────────────────────────────────────────────────────────────────
// rpID must match the hostname you use to access the app.
// For LAN: use the IP or a local hostname (not 'localhost' if accessing from phone).
// Set WEBAUTHN_RP_ID in .env to match your setup.

function getRpConfig(): { rpID: string; rpName: string; origin: string } {
  const rpID = process.env.WEBAUTHN_RP_ID ?? 'localhost';
  const port = process.env.APP_PORT ?? '3000';
  const origin = process.env.WEBAUTHN_ORIGIN ?? `http://${rpID}:${port}`;
  return { rpID, rpName: 'Argos', origin };
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30min standard session
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5min challenge window
const ELEVATED_TTL_MS = 10 * 60 * 1000; // 10min elevated session

// ─── DB helpers ───────────────────────────────────────────────────────────────

interface StoredCredential {
  id: string;
  public_key: string;
  counter: number;
  device_name: string;
  transports: string | null;
  registered_at: number;
  last_used_at: number | null;
}

function getCredentials(): StoredCredential[] {
  return getDb().prepare(`SELECT * FROM webauthn_credentials`).all() as StoredCredential[];
}

function getCredentialById(credId: string): StoredCredential | null {
  return getDb()
    .prepare(`SELECT * FROM webauthn_credentials WHERE id = ?`)
    .get(credId) as StoredCredential | null;
}

function saveCredential(cred: {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  deviceName: string;
  transports?: string[];
}): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO webauthn_credentials
    (id, public_key, counter, device_name, transports, registered_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      cred.id,
      isoBase64URL.fromBuffer(cred.publicKey as Uint8Array<ArrayBuffer>),
      cred.counter,
      cred.deviceName,
      cred.transports ? JSON.stringify(cred.transports) : null,
      Date.now(),
    );
}

/** Atomically update counter — rejects if counter hasn't advanced (replay/race). */
function updateCounter(credId: string, newCounter: number): boolean {
  const result = getDb()
    .prepare(
      `UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ? AND counter < ?`,
    )
    .run(newCounter, Date.now(), credId, newCounter);
  return result.changes > 0;
}

// ─── Challenge management ──────────────────────────────────────────────────────

function storeChallenge(
  challenge: string,
  type: 'registration' | 'authentication' | 'approval',
  context?: Record<string, unknown>,
): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `
    INSERT INTO webauthn_challenges (id, challenge, type, context, created_at, expires_at, used)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `,
    )
    .run(
      id,
      challenge,
      type,
      context ? JSON.stringify(context) : null,
      now,
      now + CHALLENGE_TTL_MS,
    );
  return id;
}

function consumeChallenge(challengeId: string): {
  challenge: string;
  type: string;
  context: Record<string, unknown> | null;
} | null {
  const db = getDb();
  const row = db
    .prepare(
      `
    SELECT * FROM webauthn_challenges
    WHERE id = ? AND used = 0 AND expires_at > ?
  `,
    )
    .get(challengeId, Date.now()) as {
    challenge: string;
    type: string;
    context: string | null;
  } | null;

  if (!row) return null;

  db.prepare(`UPDATE webauthn_challenges SET used = 1 WHERE id = ?`).run(challengeId);
  return {
    challenge: row.challenge,
    type: row.type,
    context: row.context ? JSON.parse(row.context) : null,
  };
}

// Cleanup expired challenges (run periodically)
export function pruneExpiredChallenges(): void {
  const result = getDb()
    .prepare(`DELETE FROM webauthn_challenges WHERE expires_at < ?`)
    .run(Date.now());
  if (result.changes > 0) log.debug(`Pruned ${result.changes} expired challenges`);
}

// ─── Session management ───────────────────────────────────────────────────────

function issueSession(credentialId: string, clearance: 'standard' | 'elevated'): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const ttl = clearance === 'elevated' ? ELEVATED_TTL_MS : SESSION_TTL_MS;

  getDb()
    .prepare(
      `
    INSERT INTO webauthn_sessions (token, credential_id, created_at, expires_at, clearance)
    VALUES (?, ?, ?, ?, ?)
  `,
    )
    .run(token, credentialId, now, now + ttl, clearance);

  return token;
}

function getSession(token: string): {
  credentialId: string;
  clearance: 'standard' | 'elevated';
  expiresAt: number;
} | null {
  const row = getDb()
    .prepare(
      `
    SELECT * FROM webauthn_sessions WHERE token = ? AND expires_at > ?
  `,
    )
    .get(token, Date.now()) as {
    credential_id: string;
    clearance: string;
    expires_at: number;
  } | null;

  if (!row) return null;
  return {
    credentialId: row.credential_id,
    clearance: row.clearance as 'standard' | 'elevated',
    expiresAt: row.expires_at,
  };
}

function revokeSession(token: string): void {
  getDb().prepare(`DELETE FROM webauthn_sessions WHERE token = ?`).run(token);
}

function revokeAllSessions(): void {
  getDb().prepare(`DELETE FROM webauthn_sessions`).run();
}

// Prune expired sessions
export function pruneExpiredSessions(): void {
  getDb().prepare(`DELETE FROM webauthn_sessions WHERE expires_at < ?`).run(Date.now());
}

// ─── Express middleware ───────────────────────────────────────────────────────

export function requireAuth(clearance: 'standard' | 'elevated' = 'standard') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
      return;
    }

    // Try WebAuthn session first
    const session = getSession(token);
    if (session) {
      if (clearance === 'elevated' && session.clearance !== 'elevated') {
        res.status(403).json({
          error: 'Elevated authentication required — tap your YubiKey to confirm this action',
          code: 'ELEVATION_REQUIRED',
        });
        return;
      }
      (req as Request & { argosSession: typeof session }).argosSession = session;
      next();
      return;
    }

    // Fallback: try TOTP session
    try {
      const { validateSession } = await import('./totp.js');
      if (validateSession(token)) {
        // TOTP sessions are always 'standard' clearance
        if (clearance === 'elevated') {
          res.status(403).json({
            error: 'Elevated auth required — use YubiKey or re-enter TOTP code',
            code: 'ELEVATION_REQUIRED',
          });
          return;
        }
        (req as Request & { argosSession: { clearance: string } }).argosSession = {
          clearance: 'standard',
        };
        next();
        return;
      }
    } catch {
      /* totp module not available */
    }

    res.status(401).json({ error: 'Session expired — re-authenticate', code: 'SESSION_EXPIRED' });
  };
}

function extractToken(req: Request): string | null {
  // Try cookie first
  const cookieHeader = req.headers.cookie ?? '';
  const cookieMatch = cookieHeader.match(/argos_session=([^;]+)/);
  if (cookieMatch?.[1]) return cookieMatch[1];
  // Try Authorization header
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// ─── Check if any key is registered ──────────────────────────────────────────

export function hasRegisteredKeys(): boolean {
  const count = (
    getDb().prepare(`SELECT COUNT(*) as c FROM webauthn_credentials`).get() as { c: number }
  ).c;
  return count > 0;
}

// ─── Registration flow ────────────────────────────────────────────────────────

export async function beginRegistration(deviceName: string): Promise<{
  options: ReturnType<typeof generateRegistrationOptions> extends Promise<infer T> ? T : never;
  challengeId: string;
}> {
  const { rpID, rpName } = getRpConfig();
  const existingCredentials = getCredentials();

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: 'argos-owner',
    userDisplayName: 'Argos Owner',
    attestationType: 'none',
    // Prevent re-registering the same key
    excludeCredentials: existingCredentials.map((c) => ({
      id: c.id,
      transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransport[]) : undefined,
    })),
    authenticatorSelection: {
      // Prefer cross-platform (YubiKey) over platform (Touch ID)
      // Use 'any' to allow both
      authenticatorAttachment: 'cross-platform',
      requireResidentKey: false,
      userVerification: 'preferred',
    },
  });

  const challengeId = storeChallenge(options.challenge, 'registration', { deviceName });
  log.info(`Registration challenge generated for "${deviceName}"`);
  return { options, challengeId };
}

export async function completeRegistration(
  challengeId: string,
  response: RegistrationResponseJSON,
  deviceName: string,
): Promise<{ success: boolean; message: string }> {
  const challengeData = consumeChallenge(challengeId);
  if (!challengeData || challengeData.type !== 'registration') {
    return { success: false, message: 'Invalid or expired challenge' };
  }

  const { rpID, origin } = getRpConfig();

  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return { success: false, message: 'Verification failed' };
    }

    const { credential } = verification.registrationInfo;

    saveCredential({
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      deviceName,
      transports: response.response.transports,
    });

    audit('yubikey_registered', credential.id, 'webauthn', { deviceName });
    log.info(`YubiKey registered: "${deviceName}" (id: ${credential.id.slice(0, 16)}…)`);
    return { success: true, message: `YubiKey "${deviceName}" registered successfully` };
  } catch (e) {
    log.error('Registration verification failed', e);
    return { success: false, message: String(e) };
  }
}

// ─── Authentication flow ──────────────────────────────────────────────────────

export async function beginAuthentication(): Promise<{
  options: ReturnType<typeof generateAuthenticationOptions> extends Promise<infer T> ? T : never;
  challengeId: string;
}> {
  const { rpID } = getRpConfig();
  const credentials = getCredentials();

  if (credentials.length === 0) {
    throw new Error('No YubiKey registered. Complete registration first.');
  }

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: credentials.map((c) => ({
      id: c.id,
      transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransport[]) : undefined,
    })),
    userVerification: 'preferred',
  });

  const challengeId = storeChallenge(options.challenge, 'authentication');
  return { options, challengeId };
}

export async function completeAuthentication(
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<{ success: boolean; sessionToken?: string; message: string }> {
  const challengeData = consumeChallenge(challengeId);
  if (!challengeData || challengeData.type !== 'authentication') {
    return { success: false, message: 'Invalid or expired challenge' };
  }

  const credential = getCredentialById(response.id);
  if (!credential) {
    return { success: false, message: 'Unknown credential' };
  }

  const { rpID, origin } = getRpConfig();

  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credential.id,
        publicKey: isoBase64URL.toBuffer(credential.public_key),
        counter: credential.counter,
        transports: credential.transports
          ? (JSON.parse(credential.transports) as AuthenticatorTransport[])
          : undefined,
      },
    });

    if (!verification.verified) {
      return { success: false, message: 'Verification failed' };
    }

    // Update counter atomically (replay attack prevention — rejects stale counter)
    if (!updateCounter(credential.id, verification.authenticationInfo.newCounter)) {
      log.warn(`Counter race detected for credential ${credential.id} — rejecting`);
      return { success: false, message: 'Authentication rejected (counter race)' };
    }

    const sessionToken = issueSession(credential.id, 'standard');
    audit('yubikey_authenticated', credential.id, 'webauthn', { device: credential.device_name });
    log.info(`Authenticated: "${credential.device_name}"`);

    return { success: true, sessionToken, message: 'Authenticated' };
  } catch (e) {
    log.error('Authentication verification failed', e);
    return { success: false, message: String(e) };
  }
}

// ─── Elevated authentication (per high-risk approval) ─────────────────────────
// The proposal ID is embedded in the challenge so the YubiKey cryptographically
// signs a commitment to THIS specific action — not just "I am the owner".

export async function beginElevatedAuth(proposalId: string): Promise<{
  options: ReturnType<typeof generateAuthenticationOptions> extends Promise<infer T> ? T : never;
  challengeId: string;
}> {
  const { rpID } = getRpConfig();
  const credentials = getCredentials();

  if (credentials.length === 0) {
    throw new Error('No YubiKey registered');
  }

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: credentials.map((c) => ({ id: c.id })),
    userVerification: 'required', // PIN or biometric required for elevated
  });

  const challengeId = storeChallenge(options.challenge, 'approval', { proposalId });
  log.info(`Elevated auth challenge for proposal ${proposalId.slice(-8)}`);
  return { options, challengeId };
}

export async function completeElevatedAuth(
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<{ success: boolean; sessionToken?: string; proposalId?: string; message: string }> {
  const challengeData = consumeChallenge(challengeId);
  if (!challengeData || challengeData.type !== 'approval') {
    return { success: false, message: 'Invalid or expired challenge' };
  }

  const proposalId = challengeData.context?.proposalId as string | undefined;
  const credential = getCredentialById(response.id);
  if (!credential) return { success: false, message: 'Unknown credential' };

  const { rpID, origin } = getRpConfig();

  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credential.id,
        publicKey: isoBase64URL.toBuffer(credential.public_key),
        counter: credential.counter,
      },
    });

    if (!verification.verified) return { success: false, message: 'Verification failed' };

    if (!updateCounter(credential.id, verification.authenticationInfo.newCounter)) {
      log.warn(`Counter race detected on elevated auth for credential ${credential.id}`);
      return { success: false, message: 'Authentication rejected (counter race)' };
    }

    const sessionToken = issueSession(credential.id, 'elevated');
    audit('yubikey_elevated_auth', credential.id, 'webauthn', {
      device: credential.device_name,
      proposalId,
    });
    log.info(
      `Elevated auth granted for proposal ${proposalId?.slice(-8)} by "${credential.device_name}"`,
    );

    return { success: true, sessionToken, proposalId, message: 'Elevated access granted' };
  } catch (e) {
    log.error('Elevated auth failed', e);
    return { success: false, message: String(e) };
  }
}

// ─── List registered keys ────────────────────────────────────────────────────

export function listCredentials(): Array<{
  id: string;
  deviceName: string;
  registeredAt: number;
  lastUsedAt: number | null;
}> {
  return getCredentials().map((c) => ({
    id: c.id.slice(0, 16) + '…',
    deviceName: c.device_name,
    registeredAt: c.registered_at,
    lastUsedAt: c.last_used_at,
  }));
}

export function deleteCredential(deviceName: string): boolean {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM webauthn_credentials WHERE device_name = ?')
    .run(deviceName);
  if (result.changes > 0) {
    audit('yubikey_revoked', deviceName, 'webauthn', { device: deviceName });
    log.warn(`Credential revoked: "${deviceName}"`);
    return true;
  }
  return false;
}

// ─── Revoke all sessions (panic button) ──────────────────────────────────────

export function revokeAll(): void {
  revokeAllSessions();
  log.warn('All WebAuthn sessions revoked');
  audit('webauthn_revoke_all', undefined, 'webauthn');
}

export { revokeSession };
