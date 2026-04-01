/**
 * Argos Scheduler — cron jobs + multi-step event chaining.
 *
 * Cron: standard cron expressions via node-cron, persisted to SQLite.
 * Event chains: jobs can declare `waitFor` conditions that must all be
 * emitted before the job fires.
 *
 * Example: "send reply only after approval_abc AND calendar_confirmed"
 *
 * Built-in cron jobs (registered on startup):
 *   - memory_purge: daily TTL cleanup
 *   - approval_expiry: expire stale approvals
 *   - daily_briefing: morning summary sent to owner
 */

import cron from 'node-cron';
import { monotonicFactory } from 'ulid';
import { getDb, audit } from '../db/index.js';
import { createLogger } from '../logger.js';
import type { CronJob, ChainEvent } from '../types.js';

const ulid = monotonicFactory();
const log = createLogger('scheduler');

// ─── Handler registry ─────────────────────────────────────────────────────────
// Handlers are registered at runtime — cron rows in DB reference them by name

type CronHandler = (config: Record<string, unknown>) => Promise<void>;
const handlers = new Map<string, CronHandler>();

export function registerHandler(name: string, handler: CronHandler): void {
  handlers.set(name, handler);
  log.debug(`Registered cron handler: ${name}`);
}

export function validateCronSchedule(schedule: string): boolean {
  return cron.validate(schedule);
}

// ─── Active cron tasks ────────────────────────────────────────────────────────

const activeTasks = new Map<string, cron.ScheduledTask>();

// ─── Start all enabled cron jobs ──────────────────────────────────────────────

export function startAll(): void {
  const db = getDb();
  const jobs = db.prepare(`SELECT * FROM cron_jobs WHERE enabled = 1`).all() as Array<Record<string, unknown>>;

  log.info(`Starting ${jobs.length} cron job(s)`);

  for (const row of jobs) {
    startJob(rowToJob(row));
  }
}

function startJob(job: CronJob): void {
  if (activeTasks.has(job.id)) {
    activeTasks.get(job.id)!.stop();
  }

  if (!cron.validate(job.schedule)) {
    log.warn(`Invalid cron schedule for ${job.name}: ${job.schedule}`);
    return;
  }

  const task = cron.schedule(job.schedule, async () => {
    await runJob(job);
  }, { timezone: 'Europe/Paris' });

  activeTasks.set(job.id, task);
  log.info(`Scheduled: ${job.name} [${job.schedule}]`);
}

async function runJob(job: CronJob): Promise<void> {
  const handler = handlers.get(job.handler);
  if (!handler) {
    log.error(`No handler registered for: ${job.handler}`);
    return;
  }

  log.info(`Running cron job: ${job.name}`);
  const start = Date.now();

  try {
    await handler(job.config);

    const db = getDb();
    db.prepare(`UPDATE cron_jobs SET last_run = ? WHERE id = ?`).run(Date.now(), job.id);

    audit('cron_job_run', job.id, 'cron_job', { name: job.name, durationMs: Date.now() - start });
  } catch (e) {
    log.error(`Cron job ${job.name} failed`, e);
    audit('cron_job_error', job.id, 'cron_job', { name: job.name, error: String(e) });
  }
}

// ─── Upsert a cron job ────────────────────────────────────────────────────────

export function upsertCronJob(
  name: string,
  schedule: string,
  handler: string,
  config: Record<string, unknown> = {},
): CronJob {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM cron_jobs WHERE name = ?`).get(name) as Record<string, unknown> | null;

  if (existing) {
    db.prepare(`
      UPDATE cron_jobs SET schedule = ?, handler = ?, config = ?, enabled = 1 WHERE name = ?
    `).run(schedule, handler, JSON.stringify(config), name);
    const updated = db.prepare(`SELECT * FROM cron_jobs WHERE name = ?`).get(name) as Record<string, unknown>;
    const job = rowToJob(updated);
    startJob(job);
    return job;
  }

  const id = ulid();
  db.prepare(`
    INSERT INTO cron_jobs (id, name, schedule, handler, config, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(id, name, schedule, handler, JSON.stringify(config), Date.now());

  const job: CronJob = { id, name, schedule, handler, config, enabled: true, createdAt: Date.now() };
  startJob(job);
  return job;
}

export function disableCronJob(name: string): void {
  const db = getDb();
  const job = db.prepare(`SELECT * FROM cron_jobs WHERE name = ?`).get(name) as Record<string, unknown> | null;
  if (!job) return;
  db.prepare(`UPDATE cron_jobs SET enabled = 0 WHERE name = ?`).run(name);
  const task = activeTasks.get(job.id as string);
  if (task) { task.stop(); activeTasks.delete(job.id as string); }
  log.info(`Disabled cron job: ${name}`);
}

// ─── Event chaining ───────────────────────────────────────────────────────────

export function emitEvent(key: string, payload?: Record<string, unknown>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO chain_events (id, event_key, payload, emitted_at, consumed)
    VALUES (?, ?, ?, ?, 0)
  `).run(ulid(), key, payload ? JSON.stringify(payload) : null, Date.now());

  log.debug(`Event emitted: ${key}`, payload);
}

// Check if ALL required event keys have been emitted (unconsumed)
export function checkConditions(keys: string[]): boolean {
  if (keys.length === 0) return true;
  const db = getDb();

  for (const key of keys) {
    const event = db.prepare(`
      SELECT id FROM chain_events WHERE event_key = ? AND consumed = 0 LIMIT 1
    `).get(key);
    if (!event) return false;
  }
  return true;
}

// Consume events (mark as used after a chained action fires)
export function consumeEvents(keys: string[]): void {
  const db = getDb();
  for (const key of keys) {
    db.prepare(`UPDATE chain_events SET consumed = 1 WHERE event_key = ? AND consumed = 0`).run(key);
  }
}

// ─── Multi-step action trigger ────────────────────────────────────────────────
// Register a callback that fires when ALL conditions are met

interface ConditionalTrigger {
  id: string;
  conditions: string[];
  handler: () => Promise<void>;
  expiresAt: number;
}

const conditionalTriggers: ConditionalTrigger[] = [];

export function addConditionalTrigger(
  conditions: string[],
  handler: () => Promise<void>,
  expiryMs = 24 * 60 * 60 * 1000, // default: 24h
): string {
  const id = ulid();
  conditionalTriggers.push({
    id,
    conditions,
    handler,
    expiresAt: Date.now() + expiryMs,
  });
  log.debug(`Conditional trigger ${id} registered`, { conditions });
  return id;
}

// Poll and fire ready triggers — called by a cron every minute
export async function checkConditionalTriggers(): Promise<void> {
  const now = Date.now();

  // Remove expired
  const expired = conditionalTriggers.filter(t => t.expiresAt < now);
  for (const t of expired) {
    log.warn(`Conditional trigger ${t.id} expired`);
    conditionalTriggers.splice(conditionalTriggers.indexOf(t), 1);
  }

  // Check ready
  const ready = conditionalTriggers.filter(t => t.expiresAt >= now && checkConditions(t.conditions));

  for (const trigger of ready) {
    log.info(`Firing conditional trigger ${trigger.id}`, { conditions: trigger.conditions });
    conditionalTriggers.splice(conditionalTriggers.indexOf(trigger), 1);

    try {
      consumeEvents(trigger.conditions);
      await trigger.handler();
    } catch (e) {
      log.error(`Conditional trigger ${trigger.id} failed`, e);
    }
  }
}

// ─── Register built-in cron jobs ──────────────────────────────────────────────

export function registerBuiltinJobs(
  purgeExpiredMemory: () => void,
  expireApprovals: () => void,
  sendDailyBriefing: () => Promise<void>,
  refreshContext?: () => Promise<void>,
): void {
  registerHandler('memory_purge',    async () => { purgeExpiredMemory(); });
  registerHandler('approval_expiry', async () => { expireApprovals(); });
  registerHandler('daily_briefing',  async () => { await sendDailyBriefing(); });
  registerHandler('check_triggers',  async () => { await checkConditionalTriggers(); });
  if (refreshContext) {
    registerHandler('context_refresh', async () => { await refreshContext(); });
  }

  upsertCronJob('memory_purge',    '0 3 * * *',  'memory_purge');       // 03:00 daily
  upsertCronJob('approval_expiry', '*/5 * * * *', 'approval_expiry');    // every 5min
  upsertCronJob('daily_briefing',  '0 8 * * 1-5', 'daily_briefing');     // 08:00 weekdays
  upsertCronJob('check_triggers',  '* * * * *',   'check_triggers');     // every minute
  if (refreshContext) {
    upsertCronJob('context_refresh', '0 4 * * *', 'context_refresh');    // 04:00 daily
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToJob(row: Record<string, unknown>): CronJob {
  return {
    id: row.id as string,
    name: row.name as string,
    schedule: row.schedule as string,
    handler: row.handler as string,
    config: JSON.parse(row.config as string ?? '{}') as Record<string, unknown>,
    enabled: Boolean(row.enabled),
    lastRun: row.last_run as number | undefined,
    nextRun: row.next_run as number | undefined,
    createdAt: row.created_at as number,
  };
}

export function stopAll(): void {
  for (const [, task] of activeTasks) {
    task.stop();
  }
  activeTasks.clear();
  log.info('All cron jobs stopped');
}
