/**
 * Argos Status — live system snapshot
 *
 * Run:  npm run status
 * Flags:
 *   --watch   Refresh every 5s
 *   --json    Machine-readable JSON
 *
 * Shows at a glance:
 *   - Pending proposals requiring your attention
 *   - Open tasks
 *   - Memory store stats
 *   - Last 5 audit events
 *   - Secrets backend + key counts
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initSecretsStoreSync, getAllSecretsSync, getSecretsBackend } from '../secrets/store.js';

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  gray:    '\x1b[90m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
};

const W = Math.min(process.stdout.columns || 80, 100);

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function rule(label = '', char = '─'): string {
  if (!label) return c.gray + char.repeat(W) + c.reset;
  const side = Math.floor((W - stripAnsi(label).length - 2) / 2);
  return `${c.gray}${char.repeat(side)}${c.reset} ${label} ${c.gray}${char.repeat(side)}${c.reset}`;
}

function badge(text: string, color: string): string {
  return `${color}${c.bold}${text}${c.reset}`;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function resolvePath(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function readConfigFile(): Record<string, unknown> | null {
  try {
    const p = resolvePath(process.env.CONFIG_PATH ?? '~/.argos/config.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Status data ───────────────────────────────────────────────────────────────

interface StatusSnapshot {
  ts:           number;
  db:           'ok' | 'missing' | 'error';
  proposals:    { pending: number; items: Array<{ id: string; plan: string; risk: string; created_at: number }> };
  tasks:        { open: number; inProgress: number; items: Array<{ id: string; title: string; status: string; partner: string | null }> };
  memories:     { total: number; archived: number };
  messages:     { total: number; lastAt: number | null };
  auditLog:     { total: number; recent: Array<{ event: string; entity_type: string | null; created_at: number }> };
  secrets:      { backend: string; count: number };
  config:       { provider: string | null; model: string | null; channel: string | null; owner: string | null };
  webApp:       { port: number; origin: string | null };
}

async function gatherStatus(): Promise<StatusSnapshot> {
  const dataDir = resolvePath(process.env.DATA_DIR ?? '~/.argos');
  const dbPath  = path.join(dataDir, 'argos.db');
  const secrets = getAllSecretsSync();
  const cfg     = readConfigFile();
  const llm     = (cfg?.llm ?? {}) as Record<string, unknown>;
  const webapp  = (cfg?.webapp ?? {}) as Record<string, unknown>;

  const snap: StatusSnapshot = {
    ts:        Date.now(),
    db:        'missing',
    proposals: { pending: 0, items: [] },
    tasks:     { open: 0, inProgress: 0, items: [] },
    memories:  { total: 0, archived: 0 },
    messages:  { total: 0, lastAt: null },
    auditLog:  { total: 0, recent: [] },
    secrets:   { backend: getSecretsBackend(), count: Object.keys(secrets).length },
    config: {
      provider: llm.activeProvider ? String(llm.activeProvider) : null,
      model:    llm.activeModel    ? String(llm.activeModel) : null,
      channel:  cfg?.channel       ? String(cfg.channel) : null,
      owner:    (cfg?.owner as Record<string, unknown> | undefined)?.name
                  ? String((cfg?.owner as Record<string, unknown>).name) : null,
    },
    webApp: {
      port:   (webapp.port as number | undefined) ?? 3000,
      origin: (webapp.webauthnOrigin as string | undefined) ?? null,
    },
  };

  if (!fs.existsSync(dbPath)) return snap;

  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });

    snap.db = 'ok';

    // Proposals
    const proposals = db.prepare(`
      SELECT id, plan, actions, created_at FROM proposals
      WHERE status IN ('proposed','awaiting_approval')
      ORDER BY created_at DESC LIMIT 5
    `).all() as Array<{ id: string; plan: string; actions: string; created_at: number }>;

    snap.proposals.pending = (db.prepare(
      "SELECT count(*) as n FROM proposals WHERE status IN ('proposed','awaiting_approval')"
    ).get() as { n: number }).n;

    snap.proposals.items = proposals.map(p => {
      let risk = 'low';
      try {
        const acts = JSON.parse(p.actions) as Array<{ risk?: string }>;
        const risks = acts.map(a => a.risk ?? 'low');
        if (risks.includes('high')) risk = 'high';
        else if (risks.includes('medium')) risk = 'medium';
      } catch {}
      return { id: p.id, plan: p.plan.slice(0, 80), risk, created_at: p.created_at };
    });

    // Tasks
    snap.tasks.open = (db.prepare(
      "SELECT count(*) as n FROM tasks WHERE status = 'open'"
    ).get() as { n: number }).n;
    snap.tasks.inProgress = (db.prepare(
      "SELECT count(*) as n FROM tasks WHERE status = 'in_progress'"
    ).get() as { n: number }).n;

    snap.tasks.items = (db.prepare(`
      SELECT id, title, status, partner_name FROM tasks
      WHERE status IN ('open','in_progress')
      ORDER BY detected_at DESC LIMIT 5
    `).all() as Array<{ id: string; title: string; status: string; partner_name: string | null }>)
      .map(r => ({ id: r.id, title: r.title, status: r.status, partner: r.partner_name }));

    // Memories
    try {
      snap.memories.total    = (db.prepare("SELECT count(*) as n FROM memories").get() as { n: number }).n;
      snap.memories.archived = (db.prepare("SELECT count(*) as n FROM memories WHERE archived = 1").get() as { n: number }).n;
    } catch {}

    // Messages
    try {
      snap.messages.total = (db.prepare("SELECT count(*) as n FROM messages").get() as { n: number }).n;
      const lastMsg = db.prepare("SELECT ingested_at FROM messages ORDER BY ingested_at DESC LIMIT 1").get() as { ingested_at: number } | null;
      snap.messages.lastAt = lastMsg?.ingested_at ?? null;
    } catch {}

    // Audit log
    snap.auditLog.total = (db.prepare("SELECT count(*) as n FROM audit_log").get() as { n: number }).n;
    snap.auditLog.recent = (db.prepare(`
      SELECT event, entity_type, created_at FROM audit_log
      ORDER BY created_at DESC LIMIT 5
    `).all() as Array<{ event: string; entity_type: string | null; created_at: number }>);

    db.close();
  } catch (e) {
    snap.db = 'error';
  }

  return snap;
}

// ─── Render ────────────────────────────────────────────────────────────────────

function renderStatus(snap: StatusSnapshot): void {
  // Clear screen if watching
  process.stdout.write('\x1b[H\x1b[2J');

  const now = new Date(snap.ts);
  console.log();
  console.log(rule(`${c.bold}${c.cyan}Argos Status${c.reset}  ${c.gray}${now.toLocaleTimeString()}${c.reset}`));
  console.log();

  // ── Config ──────────────────────────────────────────────────────────────
  const owner   = snap.config.owner ?? c.yellow + 'not set' + c.reset;
  const provider = snap.config.provider
    ? `${snap.config.provider}  ${c.gray}${snap.config.model ?? ''}${c.reset}`
    : badge('not configured', c.red);
  const channel = snap.config.channel ?? badge('not configured', c.yellow);
  console.log(`  ${c.bold}Owner:${c.reset}   ${owner}   ${c.bold}LLM:${c.reset}  ${provider}   ${c.bold}Channel:${c.reset}  ${channel}`);

  const secretsLabel = snap.secrets.backend === 'keychain' ? 'keychain' : 'file';
  console.log(`  ${c.bold}Secrets:${c.reset} ${secretsLabel}  ${c.gray}(${snap.secrets.count} stored)${c.reset}   ${c.bold}DB:${c.reset}  ${snap.db === 'ok' ? c.green + 'ok' + c.reset : snap.db === 'missing' ? c.yellow + 'not initialized' + c.reset : c.red + 'error' + c.reset}`);
  console.log();

  // ── Proposals ────────────────────────────────────────────────────────────
  const propCount = snap.proposals.pending;
  const propLabel = propCount === 0
    ? `${c.green}0 pending${c.reset}`
    : badge(`${propCount} pending approval`, c.yellow);
  console.log(rule(`Proposals  ${propLabel}`));

  if (snap.proposals.items.length === 0) {
    console.log(`  ${c.gray}No pending proposals — nothing needs your attention.${c.reset}`);
  } else {
    for (const p of snap.proposals.items) {
      const riskColor = p.risk === 'high' ? c.red : p.risk === 'medium' ? c.yellow : c.green;
      const riskBadge = `${riskColor}${p.risk}${c.reset}`;
      console.log(`  ${c.gray}${p.id.slice(-8)}${c.reset}  [${riskBadge}]  ${p.plan}  ${c.gray}${timeAgo(p.created_at)}${c.reset}`);
    }
    if (snap.proposals.pending > snap.proposals.items.length) {
      console.log(`  ${c.gray}… and ${snap.proposals.pending - snap.proposals.items.length} more${c.reset}`);
    }
  }
  console.log();

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const taskCount = snap.tasks.open + snap.tasks.inProgress;
  const taskLabel = taskCount === 0
    ? `${c.green}0 open${c.reset}`
    : badge(`${snap.tasks.open} open  ${snap.tasks.inProgress} in progress`, c.cyan);
  console.log(rule(`Tasks  ${taskLabel}`));

  if (snap.tasks.items.length === 0) {
    console.log(`  ${c.gray}No open tasks.${c.reset}`);
  } else {
    for (const t of snap.tasks.items) {
      const statusColor = t.status === 'in_progress' ? c.cyan : c.reset;
      const partner = t.partner ? `  ${c.gray}(${t.partner})${c.reset}` : '';
      console.log(`  ${statusColor}${t.status.padEnd(12)}${c.reset}  ${t.title.slice(0, 60)}${partner}`);
    }
    if (taskCount > snap.tasks.items.length) {
      console.log(`  ${c.gray}… and ${taskCount - snap.tasks.items.length} more — open web app to see all${c.reset}`);
    }
  }
  console.log();

  // ── Memory + Messages ─────────────────────────────────────────────────────
  console.log(rule('Knowledge'));
  console.log(`  ${c.bold}Memories:${c.reset}  ${snap.memories.total}  ${c.gray}(${snap.memories.archived} archived)${c.reset}`);
  if (snap.messages.total > 0) {
    const lastSeen = snap.messages.lastAt ? `  last: ${timeAgo(snap.messages.lastAt)}` : '';
    console.log(`  ${c.bold}Messages:${c.reset}  ${snap.messages.total}${c.gray}${lastSeen}${c.reset}`);
  }
  console.log();

  // ── Recent activity ────────────────────────────────────────────────────────
  if (snap.auditLog.recent.length > 0) {
    console.log(rule(`Audit log  ${c.gray}(${snap.auditLog.total} total)${c.reset}`));
    for (const entry of snap.auditLog.recent) {
      const entity = entry.entity_type ? `  ${c.gray}[${entry.entity_type}]${c.reset}` : '';
      console.log(`  ${c.gray}${timeAgo(entry.created_at).padEnd(8)}${c.reset}  ${entry.event}${entity}`);
    }
    console.log();
  }

  // ── Web app ────────────────────────────────────────────────────────────────
  const appUrl = snap.webApp.origin ?? `http://localhost:${snap.webApp.port}`;
  console.log(`  ${c.gray}Web app:  ${appUrl}  ·  npm run doctor --fix  for full health check${c.reset}`);
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args       = process.argv.slice(2);
  const watchMode  = args.includes('--watch');
  const jsonOutput = args.includes('--json');

  const dataDir = resolvePath(process.env.DATA_DIR ?? '~/.argos');
  initSecretsStoreSync(dataDir);

  const run = async () => {
    const snap = await gatherStatus();
    if (jsonOutput) {
      console.log(JSON.stringify(snap, null, 2));
    } else {
      renderStatus(snap);
    }
  };

  await run();

  if (watchMode && !jsonOutput) {
    console.log(`  ${c.gray}Watching — Ctrl+C to exit${c.reset}\n`);
    setInterval(run, 5000);
  }
}

main().catch(e => { console.error('Status failed:', e); process.exit(1); });
