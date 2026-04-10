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

type Send = (text: string, opts?: { html?: boolean }) => Promise<void>;

/** Truncate at word boundary, appending ellipsis if cut. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(tsMs: number): string {
  const diff = Date.now() - tsMs;
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  const d = Math.floor(diff / 86_400_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d === 1) return 'yesterday';
  return `${d}d ago`;
}

function telegramLink(messageUrl: string | null | undefined): string {
  if (!messageUrl) return '';
  if (messageUrl.includes('t.me/')) return messageUrl;
  const webMatch = messageUrl.match(/web\.telegram\.org\/[a-z]\/#(-?\d+)(?:_(\d+))?/);
  if (webMatch) {
    const numericId = webMatch[1].replace(/^-100/, '');
    const msgId = webMatch[2];
    return msgId ? `https://t.me/c/${numericId}/${msgId}` : '';
  }
  return messageUrl;
}

function notionLink(pageId: string | null | undefined): string {
  if (!pageId) return '';
  return `https://notion.so/${pageId.replace(/-/g, '')}`;
}

function taskSourceLine(row: { message_url?: string | null; notion_page_id?: string | null }): string {
  const tg = telegramLink(row.message_url);
  const notion = notionLink(row.notion_page_id);
  const parts: string[] = [];
  if (tg) parts.push(`[↗ Message](${tg})`);
  if (notion) parts.push(`[↗ Notion](${notion})`);
  return parts.join('  ·  ');
}

// ─── /proposals ───────────────────────────────────────────────────────────────

export async function cmdProposals(send: Send): Promise<void> {
  try {
    const db = getDb();
    const pending = db
      .prepare(
        "SELECT id, context_summary, plan, created_at FROM proposals WHERE status IN ('proposed', 'awaiting_approval') ORDER BY created_at DESC LIMIT 10",
      )
      .all() as Array<{ id: string; context_summary: string; plan: string; created_at: number }>;

    if (pending.length === 0) {
      await send('✅ No pending proposals.');
    } else {
      const list = pending
        .map((p) => `📋 \`${p.id}\`\n${p.plan}\n🔒 Approve in web app`)
        .join('\n\n');
      await send(
        `📋 Pending proposals (${pending.length}):\n\n${list}\n\n🔒 Open the web app to approve/reject.`,
      );
    }
  } catch (e) {
    await send(`⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── /tasks (/t) ──────────────────────────────────────────────────────────────

export async function cmdTasks(send: Send, arg?: string): Promise<void> {
  try {
    const db = getDb();
    const filter = (arg ?? '').trim().toLowerCase();

    let where = "status IN ('open','in_progress','done_inferred')";
    const params: unknown[] = [];

    if (filter === 'all') {
      // show everything
    } else if (!filter || filter === 'me' || filter === 'mine') {
      where += ' AND is_my_task = 1';
    } else {
      where += ' AND assigned_team = ?';
      params.push(filter);
    }

    const rows = db
      .prepare(
        `SELECT id, title, status, partner_name, message_url, notion_page_id, assigned_team, is_my_task, detected_at
         FROM tasks WHERE ${where}
         ORDER BY is_my_task DESC, detected_at DESC LIMIT 20`,
      )
      .all(...params) as Array<{
      id: string;
      title: string;
      status: string;
      partner_name: string | null;
      message_url: string | null;
      notion_page_id: string | null;
      assigned_team: string | null;
      is_my_task: number;
      detected_at: number;
    }>;

    if (!rows.length) {
      await send(filter === 'all' ? '✅ Aucune tâche ouverte.' : '✅ Aucune tâche pour toi.\n\n/t all — voir les tâches équipe');
      return;
    }

    const mine = rows.filter((r) => r.is_my_task);
    const team = rows.filter((r) => !r.is_my_task);

    const statusIcon = (s: string) => s === 'in_progress' ? '🔄' : '⬜';

    const formatRow = (r: typeof rows[0]): string => {
      const id = r.id.slice(-6);
      const age = relativeTime(r.detected_at);
      const partner = r.partner_name ? `_${r.partner_name}_` : '';
      const sources = taskSourceLine(r);
      const sourceLine = sources ? `\n${sources}` : '';
      const partnerLine = partner ? `\n${partner}` : '';
      return `${statusIcon(r.status)} *${truncate(r.title, 80)}*${partnerLine}\n_${age}_${sourceLine}\n/done_${id}`;
    };

    const parts: string[] = [];

    if (mine.length) {
      parts.push(`📋 *À traiter — ${mine.length} tâche${mine.length > 1 ? 's' : ''}*\n\n${mine.map(formatRow).join('\n\n')}`);
    }

    if (team.length && filter === 'all') {
      const teamGroups = new Map<string, typeof rows>();
      for (const r of team) {
        const k = r.assigned_team ?? '?';
        if (!teamGroups.has(k)) teamGroups.set(k, []);
        teamGroups.get(k)!.push(r);
      }
      for (const [t, items] of teamGroups) {
        parts.push(`👥 *${t} — ${items.length} tâche${items.length > 1 ? 's' : ''}*\n\n${items.map(formatRow).join('\n\n')}`);
      }
    } else if (team.length) {
      parts.push(`_+ ${team.length} tâche(s) équipe — /tasks all pour voir_`);
    }

    await send(parts.join('\n\n────\n\n'));
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
      const result = db
        .prepare(
          "UPDATE tasks SET status = 'completed', completed_at = ? WHERE status IN ('open','in_progress') AND is_my_task = 1",
        )
        .run(now) as { changes: number };
      await send(`✅ ${result.changes} tâche(s) marquées done.`);
    } else if (arg) {
      const row = db
        .prepare(
          "SELECT id, title FROM tasks WHERE id LIKE ? AND status IN ('open','in_progress') LIMIT 1",
        )
        .get(`%${arg}`) as { id: string; title: string } | null;
      if (!row) {
        await send(`⚠️ Task \`${arg}\` introuvable.`);
      } else {
        db.prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(
          now,
          row.id,
        );
        await send(`✅ Done — *${truncate(row.title, 80)}*`);
      }
    } else {
      await send('Usage: `/done <id>` ou `/done all` (mes tâches seulement)');
    }
  } catch (e) {
    await send(`⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── /done_XXXXXX shortcut ────────────────────────────────────────────────────

export async function cmdDoneShortcut(shortId: string, send: Send): Promise<void> {
  try {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT id, title FROM tasks WHERE id LIKE ? AND status IN ('open','in_progress','done_inferred') LIMIT 1",
      )
      .get(`%${shortId}`) as { id: string; title: string } | null;

    if (!row) {
      await send(`⚠️ Task \`${shortId}\` introuvable ou déjà fermée.`);
    } else {
      db.prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(
        Date.now(),
        row.id,
      );
      await send(`✅ Done — *${truncate(row.title, 80)}*`);
    }
  } catch (e) {
    await send(`⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── /notifs ──────────────────────────────────────────────────────────────────

export async function cmdNotifs(send: Send): Promise<void> {
  try {
    const { listUnreadNotifications } = await import('../../core/notifications.js');
    const notifs = listUnreadNotifications(20);

    if (!notifs.length) {
      await send('✅ Aucune notification non lue.');
      return;
    }

    const lines = notifs.map((n) => {
      const id = n.id.slice(-6);
      const icon = n.urgency === 'high' ? '🔴' : '🟡';
      const partner = n.partner_name ?? '';
      const age = relativeTime(n.created_at);
      const link = telegramLink(n.message_url);
      const linkLine = link ? `\n${link}` : '';
      return `${icon} *${truncate(n.title, 90)}*\n${partner} · ${age}${linkLine}\n/seen_${id}`;
    });

    await send(`🔔 *Notifications (${notifs.length})*\n\n${lines.join('\n\n')}`);
  } catch (e) {
    await send(`⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── /seen <id> | all ────────────────────────────────────────────────────────

export async function cmdSeen(arg: string, send: Send): Promise<void> {
  try {
    const { markNotificationSeen } = await import('../../core/notifications.js');
    if (!arg.trim()) {
      await send('Usage: `/seen <id>` ou `/seen all`');
      return;
    }
    const n = markNotificationSeen(arg.trim());
    await send(n > 0 ? `👁 ${n} notification(s) marquée(s) vue(s).` : '⚠️ Aucune notification correspondante.');
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
        "UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by user' WHERE id = ? AND status IN ('proposed', 'awaiting_approval')",
      ).run(arg);
      await send(`🚫 Proposal ${arg.slice(-8)} cancelled.`);
    } else {
      const result = db
        .prepare(
          "UPDATE proposals SET status = 'rejected', rejection_reason = 'Cancelled by user' WHERE status IN ('proposed', 'awaiting_approval')",
        )
        .run() as { changes: number };
      await send(`🚫 ${result.changes} pending proposal(s) cancelled.`);
    }
  } catch (e) {
    await send(`⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
