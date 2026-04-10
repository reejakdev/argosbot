/**
 * Notifications — real-time owner alerts.
 *
 * Triggered from triage sink alongside task creation. Smart-filtered through an
 * LLM second opinion (privacy LLM if available) to avoid noise. Dedup per chat:
 * if an unread notification already exists for the same chat, update it in place.
 *
 * Privacy: only the anonymized title/body are sent to any LLM.
 */

import { monotonicFactory } from 'ulid';
import { getDb, audit } from '../db/index.js';
import { createLogger } from '../logger.js';
import type { Config } from '../config/schema.js';
import type { LLMConfig } from '../llm/index.js';
import type { TriageResult } from './triage.js';

const log = createLogger('notifications');
const ulid = monotonicFactory();

export interface NotificationRow {
  id: string;
  chat_id: string | null;
  partner_name: string | null;
  channel: string | null;
  title: string;
  body: string | null;
  urgency: string | null;
  message_url: string | null;
  source_ref: string | null;
  status: string;
  created_at: number;
  seen_at: number | null;
}

async function smartFilter(
  result: TriageResult,
  config: Config,
  llmConfig?: LLMConfig,
): Promise<{ keep: boolean; reason: string }> {
  if (!config.triage.notificationsLlmFilter || !llmConfig) {
    return { keep: true, reason: 'regex-only (no LLM filter)' };
  }
  try {
    const { llmCall, extractJson } = await import('../llm/index.js');
    const { buildPrivacyLlmConfig } = await import('./privacy.js');
    const privacy = buildPrivacyLlmConfig(config, { maxTokens: 256 });
    const cfg = privacy ?? llmConfig;

    const resp = await llmCall(cfg, [
      {
        role: 'system',
        content:
          'You filter notifications for a busy operator. Reply ONLY with strict JSON: {"keep": boolean, "reason": string}. Keep=true only if the message is genuinely worth interrupting the owner right now (action needed, urgent, decision required). Routine status updates, FYI, chit-chat → keep=false.',
      },
      {
        role: 'user',
        content: `Partner: ${result.partner}\nUrgency: ${result.urgency}\nTitle: ${result.title}\nBody: ${result.body.slice(0, 800)}`,
      },
    ]);
    const parsed = extractJson<{ keep: boolean; reason: string }>(resp.content);
    return { keep: !!parsed.keep, reason: String(parsed.reason ?? '') };
  } catch (e) {
    log.warn(`Notification LLM filter failed, defaulting keep=true: ${e}`);
    return { keep: true, reason: 'filter-error-fallback' };
  }
}

export async function createNotification(
  result: TriageResult,
  config: Config,
  llmConfig?: LLMConfig,
): Promise<string | null> {
  // Master toggle
  if (config.notifications?.enabled === false) {
    return null;
  }

  // Urgency gate — configurable floor (low < medium < high)
  const minUrgency = config.notifications?.minUrgency ?? 'high';
  const rank: Record<string, number> = { low: 0, medium: 1, high: 2 };
  const floor = rank[minUrgency] ?? 2;
  const current = rank[result.urgency ?? 'low'] ?? 0;
  if (current < floor) {
    log.debug(
      `Notification gated (urgency=${result.urgency} < min=${minUrgency}) — task created silently for "${result.title.slice(0, 60)}"`,
    );
    return null;
  }

  const filter = await smartFilter(result, config, llmConfig);
  if (!filter.keep) {
    log.info(`Notification skipped by filter: ${filter.reason} — "${result.title.slice(0, 60)}"`);
    audit('notification_skipped', undefined, 'notification', {
      reason: filter.reason,
      partner: result.partner,
      title: result.title.slice(0, 120),
    });
    return null;
  }

  const db = getDb();
  const now = Date.now();

  // Dedup: if an unread notification already exists for this chat, update it
  const existing = db
    .prepare(
      `SELECT id FROM notifications WHERE chat_id = ? AND status = 'unread' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(result.chatId) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE notifications SET title = ?, body = ?, urgency = ?, message_url = ?, source_ref = ?, created_at = ? WHERE id = ?`,
    ).run(
      result.title,
      result.body,
      result.urgency,
      result.messageUrl ?? null,
      `triage:${result.rawRef}`,
      now,
      existing.id,
    );
    audit('notification_created', existing.id, 'notification', {
      partner: result.partner,
      updated: true,
    });
    return existing.id;
  }

  const id = ulid();
  db.prepare(
    `INSERT INTO notifications (id, chat_id, partner_name, channel, title, body, urgency, message_url, source_ref, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?)`,
  ).run(
    id,
    result.chatId,
    result.partner,
    result.channel,
    result.title,
    result.body,
    result.urgency,
    result.messageUrl ?? null,
    `triage:${result.rawRef}`,
    now,
  );
  audit('notification_created', id, 'notification', {
    partner: result.partner,
    title: result.title.slice(0, 120),
  });
  return id;
}

export function listUnreadNotifications(limit = 20): NotificationRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM notifications WHERE status = 'unread' ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as NotificationRow[];
}

export function markNotificationSeen(idOrSuffix: string): number {
  const db = getDb();
  const now = Date.now();
  if (idOrSuffix === 'all') {
    const r = db
      .prepare(`UPDATE notifications SET status = 'seen', seen_at = ? WHERE status = 'unread'`)
      .run(now);
    audit('notification_seen_all', undefined, 'notification', { count: r.changes });
    return r.changes;
  }
  // Match by full id or trailing suffix
  const r = db
    .prepare(
      `UPDATE notifications SET status = 'seen', seen_at = ? WHERE status = 'unread' AND (id = ? OR id LIKE ?)`,
    )
    .run(now, idOrSuffix, `%${idOrSuffix}`);
  if (r.changes > 0) {
    audit('notification_seen', idOrSuffix, 'notification', { count: r.changes });
  }
  return r.changes;
}
