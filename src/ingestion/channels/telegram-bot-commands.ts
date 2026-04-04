/**
 * Telegram bot — core DB commands.
 *
 * Extracted from TelegramBot.handleCommand() to keep the bot class lean
 * and make these handlers independently testable / reusable across channels.
 *
 * Each function takes:
 *   - The relevant args / DB inputs
 *   - A `send(text)` callback — channel-agnostic reply mechanism
 */

import { getDb } from '../../db/index.js';

type Send = (text: string) => Promise<void>;

// ─── /proposals ───────────────────────────────────────────────────────────────

export async function cmdProposals(send: Send): Promise<void> {
  try {
    const db = getDb();
    const pending = db.prepare(
      "SELECT id, context_summary, plan, created_at FROM proposals WHERE status IN ('proposed', 'awaiting_approval') ORDER BY created_at DESC LIMIT 10"
    ).all() as Array<{ id: string; context_summary: string; plan: string; created_at: number }>;

    if (pending.length === 0) {
      await send('✅ No pending proposals.');
    } else {
      const list = pending.map(p =>
        `📋 \`${p.id}\`\n${p.plan}\n🔒 Approve in web app`
      ).join('\n\n');
      await send(`📋 Pending proposals (${pending.length}):\n\n${list}\n\n🔒 Open the web app to approve/reject.`);
    }
  } catch (e) {
    await send(`⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── /tasks ───────────────────────────────────────────────────────────────────

export async function cmdTasks(send: Send): Promise<void> {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id, title, status, partner_name, message_url, detected_at FROM tasks WHERE status IN ('open','in_progress','done_inferred') ORDER BY detected_at DESC LIMIT 15"
    ).all() as Array<{ id: string; title: string; status: string; partner_name: string | null; message_url: string | null; detected_at: number }>;

    if (!rows.length) {
      await send('✅ No open tasks.');
    } else {
      const list = rows.map(r => {
        const partner = r.partner_name ? ` _${r.partner_name}_` : '';
        const link = r.message_url ? `\n  [↗ source](${r.message_url})` : '';
        return `• \`${r.id.slice(-6)}\` ${r.title.slice(0, 80)}${partner}${link}\n  /done_${r.id.slice(-6)}`;
      }).join('\n\n');
      await send(`📋 *Open tasks (${rows.length}):*\n\n${list}`);
    }
  } catch (e) {
    await send(`⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── /done <id> | all ────────────────────────────────────────────────────────

export async function cmdDone(arg: string, send: Send): Promise<void> {
  try {
    const db = getDb();
    const now = Date.now();

    if (arg === 'all') {
      const result = db.prepare(
        "UPDATE tasks SET status = 'completed', completed_at = ? WHERE status IN ('open','in_progress')"
      ).run(now) as { changes: number };
      await send(`✅ Marked *${result.changes}* tasks as completed.`);
    } else if (arg) {
      const row = db.prepare(
        "SELECT id, title FROM tasks WHERE id LIKE ? AND status IN ('open','in_progress') LIMIT 1"
      ).get(`%${arg}`) as { id: string; title: string } | null;
      if (!row) {
        await send(`⚠️ Task \`${arg}\` not found.`);
      } else {
        db.prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(now, row.id);
        await send(`✅ *${row.title.slice(0, 80)}* marked as done.`);
      }
    } else {
      await send('⚠️ Usage: `/done <id>` or `/done all`');
    }
  } catch (e) {
    await send(`⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── /done_XXXXXX shortcut ────────────────────────────────────────────────────

export async function cmdDoneShortcut(shortId: string, send: Send): Promise<void> {
  try {
    const db = getDb();
    const row = db.prepare(
      "SELECT id, title FROM tasks WHERE id LIKE ? AND status IN ('open','in_progress','done_inferred') LIMIT 1"
    ).get(`%${shortId}`) as { id: string; title: string } | null;

    if (!row) {
      await send(`⚠️ Task \`${shortId}\` not found or already closed.`);
    } else {
      db.prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(Date.now(), row.id);
      await send(`✅ *${row.title.slice(0, 80)}* marked as done.`);
    }
  } catch (e) {
    await send(`⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── /cancel [proposalId] ─────────────────────────────────────────────────────

export async function cmdCancel(arg: string, send: Send): Promise<void> {
  try {
    const db = getDb();
    if (arg) {
      db.prepare(
        "UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by user' WHERE id = ? AND status IN ('proposed', 'awaiting_approval')"
      ).run(arg);
      await send(`🚫 Proposal ${arg.slice(-8)} cancelled.`);
    } else {
      const result = db.prepare(
        "UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by user' WHERE status IN ('proposed', 'awaiting_approval')"
      ).run() as { changes: number };
      await send(`🚫 ${result.changes} pending proposal(s) cancelled.`);
    }
  } catch (e) {
    await send(`⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
