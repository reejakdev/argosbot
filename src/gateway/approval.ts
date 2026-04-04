/**
 * Approval Gateway — the human-in-the-loop layer.
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  SECURITY INVARIANT — NEVER RELAX WITHOUT EXPLICIT DECISION     ║
 * ║                                                                  ║
 * ║  risk: low    → Telegram inline button OK                       ║
 * ║  risk: medium → Web app + YubiKey (FIDO2) ONLY                  ║
 * ║  risk: high   → Web app + YubiKey (FIDO2) ONLY                  ║
 * ║                                                                  ║
 * ║  Telegram cannot approve medium/high-risk proposals.            ║
 * ║  This is hardcoded — not configurable.                          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * State machine:
 *   proposed → awaiting_approval → approved → executed
 *                               → rejected
 *                               → expired (after TTL)
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { monotonicFactory } from 'ulid';
import { getDb, audit } from '../db/index.js';
import { createLogger } from '../logger.js';
import type { Proposal, ProposedAction, ApprovalRequest } from '../types.js';

const ulid = monotonicFactory();
const log = createLogger('approval');

// ─── Telegram bot reference (injected at startup) ─────────────────────────────

type SendMessageFn = (chatId: string, text: string, options?: unknown) => Promise<{ message_id: number }>;
let _sendMessage: SendMessageFn | null = null;
let _approvalChatId: string = '';
let _cloudMode = false;

export function initApprovalGateway(
  sendMessage: SendMessageFn,
  approvalChatId: string,
  cloudMode = false,
): void {
  _sendMessage = sendMessage;
  _approvalChatId = approvalChatId;
  _cloudMode = cloudMode;
  if (cloudMode) {
    log.warn('Security: cloudMode=true — Telegram approval fully disabled, YubiKey required for all proposals');
  }
  log.info(`Approval gateway initialized → chat ${approvalChatId}`);
}

// ─── Format approval message ──────────────────────────────────────────────────

function formatApprovalMessage(proposal: Proposal): string {
  const lines: string[] = [
    `🔔 *ARGOS — Approval Required*`,
    ``,
    `📋 *Situation*`,
    proposal.contextSummary,
    ``,
    `🗺 *Plan*`,
    proposal.plan.slice(0, 500) + (proposal.plan.length > 500 ? '…' : ''),
    ``,
    `⚡ *Actions proposed (${proposal.actions.length})*`,
  ];

  for (const [i, action] of proposal.actions.entries()) {
    const riskEmoji = { low: '🟢', medium: '🟡', high: '🔴' }[action.risk];
    lines.push(`${i + 1}. ${riskEmoji} ${action.description}`);
  }

  if (proposal.draftReply) {
    lines.push(``, `📝 *Draft reply*`);
    lines.push(`_${proposal.draftReply.slice(0, 300)}_`);
  }

  const needsYubiKey = proposal.actions.some(a => a.risk === 'medium' || a.risk === 'high');
  if (needsYubiKey) {
    lines.push(
      ``,
      `🔐 *YubiKey required — cannot approve here*`,
      `This proposal contains medium/high-risk actions.`,
      `Open the web app and tap your YubiKey to approve.`,
      `👉 http://localhost:${process.env.APP_PORT ?? '3000'}`,
    );
  }

  const expiresIn = Math.round((proposal.expiresAt - Date.now()) / 60_000);
  lines.push(``, `⏱ Expires in ${expiresIn} min | ID: \`${proposal.id.slice(-8)}\``);

  return lines.join('\n');
}

// ─── Risk enforcement ─────────────────────────────────────────────────────────
// INVARIANT: medium and high risk proposals MUST go through YubiKey (web app).
// This function is the single enforcement point — called before any Telegram approval.

export function proposalRequiresYubiKey(actions: ProposedAction[]): boolean {
  // cloudMode: ALL proposals require YubiKey regardless of risk level
  if (_cloudMode) return true;
  return actions.some(a => a.risk === 'medium' || a.risk === 'high');
}

function buildInlineKeyboard(proposalId: string, actions: ProposedAction[]) {
  const needsYubiKey = proposalRequiresYubiKey(actions);
  const hasHighRisk  = actions.some(a => a.risk === 'high');

  if (needsYubiKey) {
    // Telegram cannot approve — only show Reject + snooze + a web app nudge
    return {
      inline_keyboard: [
        [
          { text: '❌ Reject', callback_data: `reject:${proposalId}` },
          { text: '⏰ Later (+1h)', callback_data: `snooze:${proposalId}` },
        ],
        ...(hasHighRisk ? [[{ text: '🔴 Details', callback_data: `details:${proposalId}` }]] : []),
      ],
    };
  }

  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve:${proposalId}` },
        { text: '❌ Reject', callback_data: `reject:${proposalId}` },
      ],
      [{ text: '⏰ Later (+1h)', callback_data: `snooze:${proposalId}` }],
    ],
  };
}

// ─── Ephemeral execution tokens ───────────────────────────────────────────────
//
// Two-layer security model:
//   Layer 1 — DB status gate:    `WHERE id = ? AND status = 'approved'`
//   Layer 2 — execution token:   generated ONLY during a real human approval action
//
// The token is a 32-byte random value stored with a 5-min TTL and a single-use flag.
// Workers must present it before executing — without it, execution is blocked even if
// the DB was directly modified to set status='approved'.

const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function generateExecutionToken(proposalId: string): string {
  const token = randomBytes(32).toString('hex');
  const now   = Date.now();
  const db    = getDb();

  // INSERT OR REPLACE — handles the edge case where a token already exists
  // (e.g. re-approval after a snooze). The old token is invalidated.
  db.prepare(`
    INSERT OR REPLACE INTO execution_tokens (proposal_id, token, created_at, expires_at, used)
    VALUES (?, ?, ?, ?, 0)
  `).run(proposalId, token, now, now + TOKEN_TTL_MS);

  audit('execution_token_issued', proposalId, 'security');
  log.info(`Execution token issued for proposal ${proposalId.slice(-8)} (TTL: 5min)`);
  return token;
}

/**
 * Validate and atomically consume an execution token.
 * Returns true only if:
 *   - A token exists for this proposalId
 *   - It matches the provided value (constant-time comparison)
 *   - It hasn't expired
 *   - It hasn't already been used
 *   - The atomic mark-as-used succeeded (no race)
 */
export function validateAndConsumeToken(proposalId: string, token: string): boolean {
  const db = getDb();

  const row = db.prepare(
    'SELECT token, expires_at, used FROM execution_tokens WHERE proposal_id = ?'
  ).get(proposalId) as { token: string; expires_at: number; used: number } | undefined;

  if (!row) {
    log.warn(`Execution blocked: no token for proposal ${proposalId.slice(-8)}`);
    audit('execution_blocked', proposalId, 'security', { reason: 'no_token' });
    return false;
  }
  if (row.used) {
    log.warn(`Execution blocked: token already consumed for proposal ${proposalId.slice(-8)}`);
    audit('execution_blocked', proposalId, 'security', { reason: 'token_already_used' });
    return false;
  }
  if (row.expires_at < Date.now()) {
    log.warn(`Execution blocked: token expired for proposal ${proposalId.slice(-8)}`);
    audit('execution_blocked', proposalId, 'security', { reason: 'token_expired' });
    return false;
  }

  // Constant-time comparison — prevents timing-based token enumeration
  let match = false;
  try {
    match = timingSafeEqual(Buffer.from(row.token, 'hex'), Buffer.from(token, 'hex'));
  } catch {
    // Length mismatch — definitely invalid
    match = false;
  }
  if (!match) {
    log.warn(`Execution blocked: token mismatch for proposal ${proposalId.slice(-8)}`);
    audit('execution_blocked', proposalId, 'security', { reason: 'token_mismatch' });
    return false;
  }

  // Atomically mark as used — WHERE used = 0 prevents race conditions
  const result = db.prepare(
    'UPDATE execution_tokens SET used = 1 WHERE proposal_id = ? AND used = 0'
  ).run(proposalId);

  if (result.changes === 0) {
    // Race condition: another request consumed it between our check and the update
    log.warn(`Execution blocked: token race condition for proposal ${proposalId.slice(-8)}`);
    audit('execution_blocked', proposalId, 'security', { reason: 'token_race' });
    return false;
  }

  audit('execution_token_consumed', proposalId, 'security');
  return true;
}

// ─── Send approval request ────────────────────────────────────────────────────

export async function requestApproval(proposal: Proposal): Promise<ApprovalRequest> {
  if (!_sendMessage) throw new Error('Approval gateway not initialized');

  const text = formatApprovalMessage(proposal);
  const keyboard = buildInlineKeyboard(proposal.id, proposal.actions);

  // Update proposal status
  const db = getDb();
  db.prepare(`UPDATE proposals SET status = 'awaiting_approval' WHERE id = ?`).run(proposal.id);

  let tgMessageId: number | undefined;
  try {
    const sent = await _sendMessage(_approvalChatId, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    tgMessageId = sent.message_id;
  } catch (e) {
    log.error('Failed to send approval message', e);
    throw e;
  }

  const now = Date.now();
  const approval: ApprovalRequest = {
    id: ulid(),
    proposalId: proposal.id,
    telegramMessageId: tgMessageId,
    status: 'pending',
    createdAt: now,
    expiresAt: proposal.expiresAt,
  };

  db.prepare(`
    INSERT INTO approvals (id, proposal_id, telegram_message_id, status, created_at, expires_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(approval.id, approval.proposalId, tgMessageId ?? null, now, approval.expiresAt);

  log.info(`Approval ${approval.id} sent for proposal ${proposal.id}`, { tgMessageId });
  audit('approval_requested', approval.id, 'approval', { proposalId: proposal.id });

  return approval;
}

// ─── Handle callback query (from Telegram inline button press) ─────────────────

export async function handleCallback(
  callbackData: string,
  callbackId: string,
  executeApprovedProposal: (proposal: Proposal, actions: ProposedAction[], token: string) => Promise<void>,
): Promise<string> {
  const [action, proposalId] = callbackData.split(':');
  if (!proposalId) return 'Invalid callback';

  const db = getDb();
  const proposalRow = db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(proposalId) as Record<string, unknown> | null;

  if (!proposalRow) return `❌ Proposal ${proposalId.slice(-8)} not found`;

  if (proposalRow.status !== 'awaiting_approval') {
    return `ℹ️ Proposal already ${proposalRow.status}`;
  }

  // Check expiry
  if ((proposalRow.expires_at as number) < Date.now()) {
    db.prepare(`UPDATE proposals SET status = 'expired' WHERE id = ?`).run(proposalId);
    db.prepare(`UPDATE approvals SET status = 'expired' WHERE proposal_id = ?`).run(proposalId);
    return `⏰ Proposal expired`;
  }

  const now = Date.now();

  switch (action) {
    case 'approve': {
      // ── SECURITY INVARIANT ───────────────────────────────────────────────
      // Telegram cannot approve medium/high-risk proposals.
      // This is enforced here regardless of how the callback was triggered.
      const proposalActions = JSON.parse(proposalRow.actions as string) as ProposedAction[];
      if (proposalRequiresYubiKey(proposalActions)) {
        log.warn(`Blocked Telegram approval of medium/high-risk proposal ${proposalId}`);
        audit('telegram_approval_blocked', proposalId, 'security', { reason: 'requires_yubikey' });
        return `🔐 This proposal requires YubiKey approval.\nOpen the web app: http://localhost:${process.env.APP_PORT ?? '3000'}`;
      }
      // ─────────────────────────────────────────────────────────────────────

      // Generate ephemeral execution token INSIDE the transaction — it only
      // exists after a real human approval action. Workers must present it.
      let executionToken = '';
      db.transaction(() => {
        db.prepare(`UPDATE proposals SET status = 'approved', approved_at = ? WHERE id = ?`).run(now, proposalId);
        db.prepare(`UPDATE approvals SET status = 'approved', responded_at = ? WHERE proposal_id = ?`).run(now, proposalId);
        executionToken = generateExecutionToken(proposalId);
      })();

      log.info(`Proposal ${proposalId} APPROVED`);
      audit('proposal_approved', proposalId, 'proposal');

      const proposal: Proposal = {
        id: proposalId,
        contextSummary: proposalRow.context_summary as string,
        plan: proposalRow.plan as string,
        actions: JSON.parse(proposalRow.actions as string) as ProposedAction[],
        draftReply: proposalRow.draft_reply as string | undefined,
        status: 'approved',
        createdAt: proposalRow.created_at as number,
        approvedAt: now,
        expiresAt: proposalRow.expires_at as number,
      };

      // Execute in background — don't block the callback response
      void executeApprovedProposal(proposal, proposal.actions, executionToken).catch(e => {
        log.error(`Execution failed for proposal ${proposalId}`, e);
      });

      return `✅ Approved — executing ${proposal.actions.length} action(s)`;
    }

    case 'reject': {
      db.transaction(() => {
        db.prepare(`UPDATE proposals SET status = 'rejected' WHERE id = ?`).run(proposalId);
        db.prepare(`UPDATE approvals SET status = 'rejected', responded_at = ? WHERE proposal_id = ?`).run(now, proposalId);
      })();
      log.info(`Proposal ${proposalId} REJECTED`);
      audit('proposal_rejected', proposalId, 'proposal');
      return `❌ Rejected`;
    }

    case 'snooze': {
      const newExpiry = Date.now() + 60 * 60 * 1000; // +1h
      db.prepare(`UPDATE proposals SET expires_at = ? WHERE id = ?`).run(newExpiry, proposalId);
      db.prepare(`UPDATE approvals SET expires_at = ? WHERE proposal_id = ?`).run(newExpiry, proposalId);
      log.info(`Proposal ${proposalId} snoozed 1h`);
      return `⏰ Snoozed — will expire in 1h`;
    }

    case 'details': {
      const actions = JSON.parse(proposalRow.actions as string) as ProposedAction[];
      const detail = actions
        .filter(a => a.risk === 'high')
        .map(a => `🔴 *${a.type.toUpperCase()}*\n${a.description}\n\`${JSON.stringify(a.payload).slice(0, 200)}\``)
        .join('\n\n');
      return `🔴 *High-risk action details*\n\n${detail}`;
    }

    default:
      return `Unknown action: ${action}`;
  }
}

// ─── Expire stale approvals (run by cron every 5min) ─────────────────────────

export function expireStaleApprovals(): void {
  const db = getDb();
  const now = Date.now();

  const result = db.prepare(`
    UPDATE approvals SET status = 'expired'
    WHERE status = 'pending' AND expires_at < ?
  `).run(now);

  if (result.changes > 0) {
    db.prepare(`
      UPDATE proposals SET status = 'expired'
      WHERE status = 'awaiting_approval' AND expires_at < ?
    `).run(now);

    log.info(`Expired ${result.changes} stale approval(s)`);
    audit('approvals_expired', undefined, 'approval', { count: result.changes });
  }
}
