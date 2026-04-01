/**
 * Transaction Prep Worker — READ-ONLY.
 *
 * Produces a structured operation review pack for the owner to review
 * before manually executing in any external system.
 *
 * Never connects to any external system directly.
 * Never signs, submits, or simulates operations.
 * Purely documentation and due-diligence structure.
 *
 * Output format mirrors what a compliance officer would want to see:
 *   - Operation summary
 *   - Chain + vault info (anonymized)
 *   - Asset + amount bucket
 *   - Due diligence checklist
 *   - Risk flags
 *   - Reviewer signature placeholder
 */

import { createLogger } from '../logger.js';
import type { WorkerResult } from './index.js';

const log = createLogger('tx-prep');

export interface TxPack {
  id: string;
  generatedAt: string;
  operation: string;
  chain: string;
  vaultRef: string;
  asset: string;
  amountRef: string;
  checklist: ChecklistItem[];
  risks: string[];
  notes: string;
  status: 'draft' | 'reviewed' | 'approved' | 'rejected';
}

export interface ChecklistItem {
  item: string;
  checked: boolean;
}

const OPERATION_CHECKLISTS: Record<string, string[]> = {
  deposit: [
    'Verify source wallet is whitelisted',
    'Confirm asset and network match expected parameters',
    'Check deposit address on vault dashboard',
    'Verify no smart contract interaction required (simple transfer)',
    'Confirm amount aligns with agreed terms',
    'Check network congestion / gas fees reasonable',
  ],
  withdrawal: [
    'Verify destination address is in approved whitelist',
    'Confirm withdrawal is within daily limit',
    'Check if multi-sig quorum is required',
    'Verify asset and network',
    'Review for round-number / unusual amount',
    'Confirm no open disputes or holds on account',
    'Check AML screening of destination',
  ],
  swap: [
    'Verify DEX/protocol is approved',
    'Check slippage tolerance is within policy',
    'Review price impact vs current market',
    'Confirm route: asset in → asset out',
    'Check contract address against known-good list',
    'Verify no sandwich attack risk (use private mempool if needed)',
  ],
  bridge: [
    'Verify bridge protocol is approved and audited',
    'Check destination chain and address',
    'Review bridge fees and processing time',
    'Confirm asset will arrive as expected on destination',
    'Check for any known issues with bridge at time of transaction',
    'Verify you have gas on destination chain',
  ],
  approve: [
    'CRITICAL: Verify contract address you are approving',
    'Check allowance amount — use exact amount, not unlimited if possible',
    'Verify the protocol you are approving is audited',
    'Confirm this approval is necessary for the intended operation',
    'Check for existing approvals that should be revoked first',
  ],
  other: [
    'Identify exact nature of transaction',
    'Verify contract interaction is intentional',
    'Review calldata / function signature',
    'Check contract audit status',
    'Confirm signer authority',
  ],
};

const RISK_CHECKERS: Array<{
  name: string;
  check: (input: Record<string, unknown>) => boolean;
  message: string;
}> = [
  {
    name: 'approve_unlimited',
    check: i => i.operation === 'approve',
    message: '⚠️ Approval operation — verify allowance amount (never approve unlimited to unknown contracts)',
  },
  {
    name: 'bridge_op',
    check: i => i.operation === 'bridge',
    message: '⚠️ Bridge operation — verify destination chain and allow for processing delays',
  },
  {
    name: 'large_amount',
    check: i => String(i.amount_ref ?? '').includes('>1M') || String(i.amount_ref ?? '').includes('100K-1M'),
    message: '🔴 Large amount detected — ensure multi-sig quorum and compliance sign-off',
  },
  {
    name: 'unknown_chain',
    check: i => !['ethereum', 'arbitrum', 'base', 'optimism', 'polygon', 'solana', 'bitcoin'].includes(String(i.chain ?? '').toLowerCase()),
    message: '⚠️ Non-standard chain — verify RPC endpoints and confirm chain support',
  },
];

export class TxPrepWorker {
  prepare(input: Record<string, unknown>, _readOnly: boolean): WorkerResult {
    const operation = (input.operation as string) ?? 'other';
    const chain = (input.chain as string) ?? 'unknown';
    const vaultRef = (input.vault_ref as string) ?? 'VAULT_?';
    const asset = (input.asset as string) ?? 'ASSET_?';
    const amountRef = (input.amount_ref as string) ?? 'AMT_?';
    const userNotes = (input.notes as string) ?? '';

    // Build checklist
    const baseItems = OPERATION_CHECKLISTS[operation] ?? OPERATION_CHECKLISTS.other;
    const userItems = (input.checklist as string[] | undefined) ?? [];
    const allItems = [...baseItems, ...userItems];
    const checklist: ChecklistItem[] = allItems.map(item => ({ item, checked: false }));

    // Auto-detect risks
    const risks: string[] = [];
    for (const checker of RISK_CHECKERS) {
      if (checker.check(input)) risks.push(checker.message);
    }
    // Add user-provided risks
    const userRisks = (input.risks as string[] | undefined) ?? [];
    risks.push(...userRisks);

    const pack: TxPack = {
      id: `TX-${Date.now().toString(36).toUpperCase()}`,
      generatedAt: new Date().toISOString(),
      operation,
      chain,
      vaultRef,
      asset,
      amountRef,
      checklist,
      risks,
      notes: userNotes,
      status: 'draft',
    };

    const formatted = this.formatPack(pack);

    log.info(`Transaction pack prepared: ${pack.id}`, {
      operation,
      chain,
      asset,
      risks: risks.length,
    });

    return {
      success: true,
      dryRun: true, // always dry-run — we never touch the chain
      output: formatted,
      data: pack,
    };
  }

  private formatPack(pack: TxPack): string {
    const lines = [
      `🔐 *TRANSACTION REVIEW PACK*`,
      `ID: \`${pack.id}\`  |  Generated: ${new Date(pack.generatedAt).toLocaleString('fr-FR')}`,
      ``,
      `📋 *Operation Summary*`,
      `• Type: **${pack.operation.toUpperCase()}**`,
      `• Chain: ${pack.chain}`,
      `• Vault/Contract: \`${pack.vaultRef}\``,
      `• Asset: ${pack.asset}`,
      `• Amount: ${pack.amountRef}`,
      pack.notes ? `• Notes: ${pack.notes}` : null,
      ``,
      `✅ *Due Diligence Checklist*`,
      ...pack.checklist.map((c, i) => `${i + 1}. [ ] ${c.item}`),
    ];

    if (pack.risks.length > 0) {
      lines.push(``, `🚨 *Risk Flags*`);
      lines.push(...pack.risks.map(r => `• ${r}`));
    }

    lines.push(
      ``,
      `📝 *Reviewer Sign-off*`,
      `Reviewed by: _______________`,
      `Approved by: _______________`,
      `Date: _______________`,
      ``,
      `⚠️ _This pack is for review only. Execute manually in your custody solution after all items are checked._`,
    );

    return lines.filter(l => l !== null).join('\n');
  }
}
