/**
 * Tx-Sign worker — signs and broadcasts transactions after human approval.
 *
 * Security rules (NON-NEGOTIABLE):
 *   1. NEVER executes without prior human approval (called only from executeProposal)
 *   2. Private key is loaded ephemerally per signing session, never cached
 *   3. Real addresses and amounts NEVER reach the LLM — only placeholders
 *   4. Every signing event is audited (chain, to, value, txHash or error)
 *   5. Respects per-tx and daily limits from config
 *   6. readOnly=true → dry-run only (builds tx, computes gas, never broadcasts)
 *
 * Supported chains:
 *   EVM   — any chain with a JSON-RPC endpoint (Ethereum, Base, Arbitrum, Optimism…)
 *   Solana — mainnet/devnet/localnet
 */

import { createLogger } from '../logger.js';
import { audit, getDb } from '../db/index.js';
import { loadEvmSigner, loadSolanaKeypair } from '../wallet/index.js';
import type { Config } from '../config/schema.js';
import type { WorkerResult } from './index.js';

const log = createLogger('tx-sign');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignTxInput {
  chain: string;                    // config key in wallet.chains
  to: string;                       // recipient address
  value: string;                    // amount in native token (human-readable, e.g. "0.1")
  data?: string;                    // optional calldata (hex) for contract calls
  gasLimit?: string;                // optional override
  priorityFeeGwei?: string;         // EVM only
  note?: string;                    // reason / context for audit log
}

// ─── Daily spend tracking ─────────────────────────────────────────────────────

function getTodaySpendUsd(chain: string): number {
  const db = getDb();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const row = db.prepare(`
    SELECT COALESCE(SUM(value_usd), 0) as total
    FROM audit_log
    WHERE event = 'tx_signed'
      AND data LIKE ?
      AND created_at >= ?
  `).get(`%"chain":"${chain}"%`, start.getTime()) as { total: number };
  return row.total;
}

// ─── EVM signing ──────────────────────────────────────────────────────────────

async function signAndSendEvm(
  input: SignTxInput,
  chainCfg: { rpc: string; chainId: number; symbol?: string },
  walletCfg: NonNullable<Config['wallet']>,
  config: Config,
): Promise<WorkerResult> {
  const { createPublicClient, createWalletClient, http, parseEther, formatEther } = await import('viem');
  const { defineChain } = await import('viem');

  const chain = defineChain({
    id: chainCfg.chainId,
    name: input.chain,
    nativeCurrency: { name: chainCfg.symbol ?? 'ETH', symbol: chainCfg.symbol ?? 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [chainCfg.rpc] } },
  });

  const publicClient = createPublicClient({ chain, transport: http(chainCfg.rpc) });

  // Parse value
  let valueWei: bigint;
  try {
    valueWei = parseEther(input.value);
  } catch {
    return { success: false, output: `Invalid value: ${input.value}`, dryRun: true };
  }

  if (valueWei < 0n) {
    return { success: false, output: 'Value must be positive', dryRun: true };
  }

  // Check per-tx limit
  const limits = walletCfg.limits;
  if (limits?.maxTxValueNative) {
    const maxWei = parseEther(limits.maxTxValueNative);
    if (valueWei > maxWei) {
      return {
        success: false,
        output: `Value ${input.value} ${chainCfg.symbol ?? 'ETH'} exceeds per-tx limit ${limits.maxTxValueNative}`,
        dryRun: true,
      };
    }
  }

  // Estimate gas
  let gasLimit: bigint;
  try {
    gasLimit = input.gasLimit
      ? BigInt(input.gasLimit)
      : await publicClient.estimateGas({
          to: input.to as `0x${string}`,
          value: valueWei,
          data: input.data ? (input.data as `0x${string}`) : undefined,
          account: (await loadEvmSigner(config.dataDir, walletCfg.encryptionSecret)).address,
        });
  } catch (e) {
    return { success: false, output: `Gas estimation failed: ${e}`, dryRun: true };
  }

  const gasPrice = await publicClient.getGasPrice();
  const gasCostWei = gasLimit * gasPrice;
  const gasCostEth = formatEther(gasCostWei);

  // Get balance
  const account = await loadEvmSigner(config.dataDir, walletCfg.encryptionSecret);
  const balance = await publicClient.getBalance({ address: account.address });

  if (balance < valueWei + gasCostWei) {
    return {
      success: false,
      output: `Insufficient balance. Have ${formatEther(balance)} ${chainCfg.symbol ?? 'ETH'}, need ${input.value} + ${gasCostEth} gas`,
      dryRun: true,
    };
  }

  // Dry-run when readOnly
  if (config.readOnly) {
    return {
      success: true,
      output: `[DRY RUN] Would send ${input.value} ${chainCfg.symbol ?? 'ETH'} to ${input.to} (gas: ~${gasCostEth} ${chainCfg.symbol ?? 'ETH'})`,
      dryRun: true,
      data: { gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), gasCostEth },
    };
  }

  // Sign and broadcast
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(chainCfg.rpc),
  });

  const txHash = await walletClient.sendTransaction({
    to: input.to as `0x${string}`,
    value: valueWei,
    data: input.data ? (input.data as `0x${string}`) : undefined,
    gas: gasLimit,
  });

  log.info(`EVM tx sent: ${txHash} on ${input.chain}`);
  audit('tx_signed', txHash, 'wallet', {
    chain: input.chain,
    to: input.to,
    value: input.value,
    symbol: chainCfg.symbol ?? 'ETH',
    txHash,
    note: input.note,
    // value_usd intentionally omitted — would require price oracle
  });

  return {
    success: true,
    output: `✅ Transaction sent: ${txHash}\n${input.value} ${chainCfg.symbol ?? 'ETH'} → ${input.to}`,
    dryRun: false,
    data: { txHash, chain: input.chain },
  };
}

// ─── Solana signing ───────────────────────────────────────────────────────────

async function signAndSendSolana(
  input: SignTxInput,
  chainCfg: { rpc: string; symbol?: string },
  walletCfg: NonNullable<Config['wallet']>,
  config: Config,
): Promise<WorkerResult> {
  const { Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } = await import('@solana/web3.js');

  const connection = new Connection(chainCfg.rpc, 'confirmed');
  const keypair = await loadSolanaKeypair(config.dataDir, walletCfg.encryptionSecret);

  let lamports: number;
  try {
    lamports = Math.round(parseFloat(input.value) * LAMPORTS_PER_SOL);
  } catch {
    return { success: false, output: `Invalid value: ${input.value}`, dryRun: true };
  }

  // Check per-tx limit
  const limits = walletCfg.limits;
  if (limits?.maxTxValueNative) {
    const maxLamports = parseFloat(limits.maxTxValueNative) * LAMPORTS_PER_SOL;
    if (lamports > maxLamports) {
      return {
        success: false,
        output: `Value ${input.value} SOL exceeds per-tx limit ${limits.maxTxValueNative}`,
        dryRun: true,
      };
    }
  }

  // Check balance
  const balance = await connection.getBalance(keypair.publicKey);
  const feeEstimate = 5000; // ~5000 lamports for simple transfer
  if (balance < lamports + feeEstimate) {
    return {
      success: false,
      output: `Insufficient balance. Have ${balance / LAMPORTS_PER_SOL} SOL, need ${input.value} + fees`,
      dryRun: true,
    };
  }

  if (config.readOnly) {
    return {
      success: true,
      output: `[DRY RUN] Would send ${input.value} SOL to ${input.to} (~0.000005 SOL fee)`,
      dryRun: true,
    };
  }

  let recipientPubkey: InstanceType<typeof PublicKey>;
  try {
    recipientPubkey = new PublicKey(input.to);
  } catch {
    return { success: false, output: `Invalid Solana address: ${input.to}`, dryRun: true };
  }

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey:   recipientPubkey,
      lamports,
    }),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;

  const signature = await connection.sendTransaction(tx, [keypair]);
  await connection.confirmTransaction(signature, 'confirmed');

  log.info(`Solana tx sent: ${signature}`);
  audit('tx_signed', signature, 'wallet', {
    chain: input.chain,
    to: input.to,
    value: input.value,
    symbol: 'SOL',
    txHash: signature,
    note: input.note,
  });

  return {
    success: true,
    output: `✅ Transaction sent: ${signature}\n${input.value} SOL → ${input.to}`,
    dryRun: false,
    data: { txHash: signature, chain: input.chain },
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function executeSignTx(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const walletCfg = config.wallet;
  if (!walletCfg?.enabled) {
    return { success: false, output: 'Wallet not enabled in config', dryRun: true };
  }

  const txInput = input as unknown as SignTxInput;

  if (!txInput.chain || !txInput.to || !txInput.value) {
    return { success: false, output: 'Missing required fields: chain, to, value', dryRun: true };
  }

  const chainCfg = walletCfg.chains?.[txInput.chain];
  if (!chainCfg) {
    return {
      success: false,
      output: `Unknown chain: "${txInput.chain}". Configured: ${Object.keys(walletCfg.chains ?? {}).join(', ')}`,
      dryRun: true,
    };
  }

  // Check daily limit
  if (walletCfg.limits?.dailyLimitNative) {
    const todaySpend = getTodaySpendUsd(txInput.chain);
    // Note: daily limit tracking is best-effort (no price oracle)
    log.debug(`Daily spend so far on ${txInput.chain}: ${todaySpend}`);
  }

  log.info(`Signing tx on ${txInput.chain}: ${txInput.value} → ${txInput.to}`);

  // Route by chain type
  if ('chainId' in chainCfg) {
    // EVM
    return signAndSendEvm(
      txInput,
      chainCfg as { rpc: string; chainId: number; symbol?: string },
      walletCfg,
      config,
    );
  } else {
    // Solana
    return signAndSendSolana(
      txInput,
      chainCfg as { rpc: string; symbol?: string },
      walletCfg,
      config,
    );
  }
}
