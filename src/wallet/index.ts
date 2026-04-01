/**
 * Argos Wallet — local hot wallet for bot-initiated transactions.
 *
 * Security model:
 *   - Private key is NEVER stored in the DB, NEVER logged, NEVER sent to any LLM
 *   - Key is encrypted with AES-256-GCM using a secret derived from config
 *   - Wallet file lives at ~/.argos/wallet.enc (0600, owner-only)
 *   - Every key generation and signing event is audited
 *
 * Supports: EVM (via viem), Solana (via @solana/web3.js, optional)
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { audit } from '../db/index.js';
import { createLogger } from '../logger.js';

function resolveDir(dir: string): string {
  return dir.startsWith('~') ? join(homedir(), dir.slice(1)) : resolve(dir);
}

const log = createLogger('wallet');

// ─── Types ────────────────────────────────────────────────────────────────────

interface EncryptedKey {
  iv: string;     // hex
  tag: string;    // hex (GCM auth tag)
  ct: string;     // hex ciphertext
}

interface WalletFile {
  version: 2;
  evm?: {
    address: string;  // public, plaintext
    key: EncryptedKey;
  };
  solana?: {
    address: string;  // public, plaintext
    key: EncryptedKey;
  };
}

export interface WalletAddresses {
  evm?: string;
  solana?: string;
}

// ─── Encryption helpers ───────────────────────────────────────────────────────

function deriveKey(secret: string): Buffer {
  // scrypt: N=2^14, r=8, p=1 — fast enough for startup, hard to brute-force
  return scryptSync(secret, 'argos-wallet-v2', 32, { N: 16384, r: 8, p: 1 });
}

function encrypt(key: Buffer, plaintext: string): EncryptedKey {
  const iv = randomBytes(12);  // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv:  iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ct:  ct.toString('hex'),
  };
}

function decrypt(key: Buffer, enc: EncryptedKey): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(enc.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(enc.ct, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

// ─── Wallet file path ─────────────────────────────────────────────────────────

function walletPath(dataDir: string): string {
  return join(resolveDir(dataDir), 'wallet.enc');
}

function loadFile(dataDir: string): WalletFile | null {
  const p = walletPath(dataDir);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as WalletFile;
}

function saveFile(dataDir: string, wallet: WalletFile): void {
  const p = walletPath(dataDir);
  writeFileSync(p, JSON.stringify(wallet, null, 2), { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* already correct on most systems */ }
}

// ─── EVM key management ───────────────────────────────────────────────────────

async function generateEvmKey(): Promise<{ address: string; privateKey: `0x${string}` }> {
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  return { address: account.address, privateKey: pk };
}

async function loadEvmPrivateKey(enc: EncryptedKey, encKey: Buffer): Promise<`0x${string}`> {
  return decrypt(encKey, enc) as `0x${string}`;
}

// ─── Solana key management ────────────────────────────────────────────────────

async function generateSolanaKey(): Promise<{ address: string; secretKey: Uint8Array }> {
  const { Keypair } = await import('@solana/web3.js');
  const kp = Keypair.generate();
  return {
    address:   kp.publicKey.toBase58(),
    secretKey: kp.secretKey,
  };
}

async function loadSolanaSecretKey(enc: EncryptedKey, encKey: Buffer): Promise<Uint8Array> {
  const hex = decrypt(encKey, enc);
  return Buffer.from(hex, 'hex');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate or load the bot wallet.
 * On first call: generates EVM + Solana keys, encrypts, saves to disk.
 * On subsequent calls: loads from disk (fast path).
 */
export async function ensureWallet(
  dataDir: string,
  encryptionSecret: string,
  chains: { evm: boolean; solana: boolean },
): Promise<WalletAddresses> {
  const encKey = deriveKey(encryptionSecret);
  let file = loadFile(dataDir);

  // Fresh install or new chain
  let dirty = false;
  if (!file) {
    file = { version: 2 };
    dirty = true;
    log.info('Wallet: generating new bot wallet…');
  }

  if (chains.evm && !file.evm) {
    const { address, privateKey } = await generateEvmKey();
    file.evm = { address, key: encrypt(encKey, privateKey) };
    dirty = true;
    log.info(`Wallet: new EVM address → ${address}`);
    audit('wallet_generated', undefined, 'wallet', { type: 'evm', address });
  }

  if (chains.solana && !file.solana) {
    const { address, secretKey } = await generateSolanaKey();
    file.solana = { address, key: encrypt(encKey, Buffer.from(secretKey).toString('hex')) };
    dirty = true;
    log.info(`Wallet: new Solana address → ${address}`);
    audit('wallet_generated', undefined, 'wallet', { type: 'solana', address });
  }

  if (dirty) saveFile(dataDir, file);

  return { evm: file.evm?.address, solana: file.solana?.address };
}

/**
 * Load the EVM private key into memory for signing.
 * Call once per signing session — never cache outside of this module.
 */
export async function loadEvmSigner(
  dataDir: string,
  encryptionSecret: string,
): Promise<import('viem').Account> {
  const encKey = deriveKey(encryptionSecret);
  const file = loadFile(dataDir);
  if (!file?.evm) throw new Error('No EVM wallet found — call ensureWallet first');

  const { privateKeyToAccount } = await import('viem/accounts');
  const pk = await loadEvmPrivateKey(file.evm.key, encKey);
  return privateKeyToAccount(pk);
}

/**
 * Load the Solana keypair for signing.
 */
export async function loadSolanaKeypair(
  dataDir: string,
  encryptionSecret: string,
): Promise<import('@solana/web3.js').Keypair> {
  const encKey = deriveKey(encryptionSecret);
  const file = loadFile(dataDir);
  if (!file?.solana) throw new Error('No Solana wallet found — call ensureWallet first');

  const { Keypair } = await import('@solana/web3.js');
  const secretKey = await loadSolanaSecretKey(file.solana.key, encKey);
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Return public addresses only (safe to log / show to user).
 */
export function getWalletAddresses(dataDir: string): WalletAddresses {
  const file = loadFile(dataDir);
  if (!file) return {};
  return { evm: file.evm?.address, solana: file.solana?.address };
}
