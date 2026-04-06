/**
 * Wallet monitor — polls EVM chains for incoming transactions to Argos's own wallet.
 *
 * Why: instead of waiting for a partner to say "I sent the funds", Argos detects
 * the on-chain event itself and injects it into the pipeline like any other message.
 *
 * Use cases:
 *   - Owner funds the bot wallet for operations (detected automatically)
 *   - Partner sends USDC as agreed → Argos detects + proposes confirmation message
 *   - Any ERC-20 or native token arrival → task created, planner notified
 *
 * What it monitors:
 *   - ERC-20 Transfer events (configured token list per chain)
 *   - Native coin balance increases (ETH, MATIC, etc.)
 *   - Solana: incoming txs via getSignaturesForAddress
 *
 * State: ~/.argos/wallet-monitor-state.json (last seen block/signature per chain)
 *
 * Config (config.wallet.monitor):
 *   enabled             boolean (default: false)
 *   pollIntervalSeconds number  (default: 60)
 *   watchNative         boolean (default: true)
 *   watchTokens         { address, symbol, decimals }[]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger.js';
import { audit } from '../db/index.js';
import { monotonicFactory } from 'ulid';
import type { RawMessage } from '../types.js';

const log = createLogger('wallet-monitor');
const ulid = monotonicFactory();

// ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface WalletMonitorConfig {
  pollIntervalSeconds: number;
  watchNative: boolean;
  watchTokens: Array<{
    address: string;
    symbol: string;
    decimals: number;
  }>;
}

interface MonitorState {
  evm: Record<string, { lastBlock: number; nativeBalance: string }>;
  solana: { lastSignature: string | null };
}

// ─── State persistence ────────────────────────────────────────────────────────

function statePath(): string {
  const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
  return path.join(dataDir, 'wallet-monitor-state.json');
}

function loadState(): MonitorState {
  try {
    if (existsSync(statePath())) {
      return JSON.parse(readFileSync(statePath(), 'utf8')) as MonitorState;
    }
  } catch {
    /* start fresh */
  }
  return { evm: {}, solana: { lastSignature: null } };
}

function saveState(state: MonitorState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (e) {
    log.warn('Failed to save wallet monitor state:', e);
  }
}

// ─── EVM polling ─────────────────────────────────────────────────────────────

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const data = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);
  return data.result;
}

function padAddress(addr: string): string {
  return '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();
}

function formatAmount(raw: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toLocaleString()}.${fracStr.slice(0, 4)}`;
}

async function pollEvmChain(
  chainName: string,
  rpcUrl: string,
  walletAddr: string,
  cfg: WalletMonitorConfig,
  state: MonitorState,
  onTx: (msg: RawMessage) => Promise<void>,
): Promise<void> {
  const chainState = state.evm[chainName] ?? { lastBlock: 0, nativeBalance: '0' };

  // Get current block
  const latestHex = (await rpc(rpcUrl, 'eth_blockNumber', [])) as string;
  const latest = parseInt(latestHex, 16);

  if (chainState.lastBlock === 0) {
    // First run — set cursor to latest, start watching from now
    chainState.lastBlock = latest;
    state.evm[chainName] = chainState;
    log.info(`Wallet monitor [${chainName}]: initialized at block ${latest}`);
    return;
  }

  if (latest <= chainState.lastBlock) return;

  const fromBlock = '0x' + (chainState.lastBlock + 1).toString(16);
  const toBlock = latestHex;

  // ── ERC-20 incoming transfers ──────────────────────────────────────────────
  for (const token of cfg.watchTokens) {
    try {
      const logs = (await rpc(rpcUrl, 'eth_getLogs', [
        {
          fromBlock,
          toBlock,
          topics: [ERC20_TRANSFER_TOPIC, null, padAddress(walletAddr)],
          address: token.address,
        },
      ])) as Array<{
        data: string;
        topics: string[];
        transactionHash: string;
        blockNumber: string;
      }>;

      for (const log_ of logs) {
        const raw = BigInt(log_.data);
        const from = '0x' + log_.topics[1].slice(26);
        const amt = formatAmount(raw, token.decimals);
        const content = `Incoming ${token.symbol} transfer detected on ${chainName}: received ${amt} ${token.symbol} from ${from}. Tx: ${log_.transactionHash}`;

        log.info(`Wallet monitor [${chainName}]: +${amt} ${token.symbol} from ${from}`);
        audit('wallet_incoming_tx', undefined, 'wallet', {
          chain: chainName,
          symbol: token.symbol,
          amount: amt,
          from,
          tx: log_.transactionHash,
        });

        await onTx(buildWalletMessage(chainName, walletAddr, content));
      }
    } catch (e) {
      log.warn(`Wallet monitor [${chainName}] ERC-20 poll failed: ${e}`);
    }
  }

  // ── Native coin balance check ──────────────────────────────────────────────
  if (cfg.watchNative) {
    try {
      const balHex = (await rpc(rpcUrl, 'eth_getBalance', [walletAddr, 'latest'])) as string;
      const current = BigInt(balHex);
      const prev = BigInt(chainState.nativeBalance ?? '0');

      if (current > prev && prev > 0n) {
        const diff = current - prev;
        const diffEth = formatAmount(diff, 18);
        const content = `Incoming native coin on ${chainName}: received ${diffEth} (balance change detected on wallet ${walletAddr})`;

        log.info(`Wallet monitor [${chainName}]: +${diffEth} native`);
        audit('wallet_incoming_native', undefined, 'wallet', { chain: chainName, diff: diffEth });

        await onTx(buildWalletMessage(chainName, walletAddr, content));
      }

      chainState.nativeBalance = current.toString();
    } catch (e) {
      log.warn(`Wallet monitor [${chainName}] native balance check failed: ${e}`);
    }
  }

  chainState.lastBlock = latest;
  state.evm[chainName] = chainState;
}

// ─── Solana polling ───────────────────────────────────────────────────────────

async function pollSolana(
  rpcUrl: string,
  walletAddr: string,
  state: MonitorState,
  onTx: (msg: RawMessage) => Promise<void>,
): Promise<void> {
  type SolSig = { signature: string; err: null | unknown };
  try {
    const params: Record<string, unknown> = { limit: 20 };
    if (state.solana.lastSignature) params.until = state.solana.lastSignature;

    const sigs = (await rpc(rpcUrl, 'getSignaturesForAddress', [walletAddr, params])) as SolSig[];

    if (!sigs.length) return;

    // Update cursor — newest signature is first
    state.solana.lastSignature = sigs[0].signature;

    // Skip error transactions
    const incoming = sigs.filter((s) => s.err === null);
    if (!incoming.length) return;

    // On first run, just set the cursor without alerting
    if (!state.solana.lastSignature) return;

    for (const sig of incoming.slice(0, 5)) {
      const content = `Incoming Solana transaction detected on wallet ${walletAddr}. Signature: ${sig.signature}`;
      log.info(`Wallet monitor [solana]: new tx ${sig.signature.slice(0, 16)}…`);
      audit('wallet_incoming_solana', undefined, 'wallet', { sig: sig.signature });
      await onTx(buildWalletMessage('solana', walletAddr, content));
    }
  } catch (e) {
    log.warn(`Wallet monitor [solana] poll failed: ${e}`);
  }
}

// ─── Message builder ──────────────────────────────────────────────────────────

function buildWalletMessage(chain: string, walletAddr: string, content: string): RawMessage {
  return {
    id: ulid(),
    channel: 'wallet',
    source: 'wallet' as const,
    chatId: `wallet:${chain}:${walletAddr.slice(0, 10)}`,
    chatName: `Wallet [${chain}]`,
    chatType: 'dm' as const,
    senderId: `wallet:${chain}`,
    senderName: `On-chain [${chain}]`,
    partnerName: `On-chain [${chain}]`,
    content,
    links: [],
    receivedAt: Date.now(),
    meta: { source: 'wallet_monitor', chain },
  };
}

// ─── Main monitor ─────────────────────────────────────────────────────────────

export function createWalletMonitor(
  walletAddresses: { evm?: string; solana?: string },
  chainConfigs: Record<string, { rpc: string; chainId?: number; symbol?: string }>,
  cfg: WalletMonitorConfig,
  onTx: (msg: RawMessage) => Promise<void>,
): { start: () => void; stop: () => void } {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const poll = async () => {
    if (!running) return;

    const state = loadState();
    let dirty = false;

    // EVM chains
    if (walletAddresses.evm) {
      for (const [chainName, chain] of Object.entries(chainConfigs)) {
        if (!('chainId' in chain) && chain.chainId === undefined) continue; // skip non-EVM
        try {
          const before = JSON.stringify(state.evm[chainName]);
          await pollEvmChain(chainName, chain.rpc, walletAddresses.evm, cfg, state, onTx);
          if (JSON.stringify(state.evm[chainName]) !== before) dirty = true;
        } catch (e) {
          log.warn(`Wallet monitor poll error [${chainName}]: ${e}`);
        }
      }
    }

    // Solana
    if (walletAddresses.solana) {
      for (const [_chainName, chain] of Object.entries(chainConfigs)) {
        if ('chainId' in chain) continue; // skip EVM
        const before = state.solana.lastSignature;
        await pollSolana(chain.rpc, walletAddresses.solana, state, onTx);
        if (state.solana.lastSignature !== before) dirty = true;
      }
    }

    if (dirty) saveState(state);

    if (running) {
      timer = setTimeout(poll, cfg.pollIntervalSeconds * 1000);
    }
  };

  return {
    start: () => {
      running = true;
      log.info(`Wallet monitor started — polling every ${cfg.pollIntervalSeconds}s`);
      if (walletAddresses.evm) log.info(`  EVM:    ${walletAddresses.evm}`);
      if (walletAddresses.solana) log.info(`  Solana: ${walletAddresses.solana}`);
      poll().catch((e) => log.warn('Wallet monitor initial poll failed:', e));
    },
    stop: () => {
      running = false;
      if (timer) clearTimeout(timer);
      log.info('Wallet monitor stopped');
    },
  };
}
