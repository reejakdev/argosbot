/**
 * Argos local web app — mobile-friendly UI accessible on your LAN.
 *
 * Access from phone: http://<your-mac-ip>:3000
 * Find your IP: System Settings → Wi-Fi → Details
 *
 * SECURITY:
 *   - YubiKey / WebAuthn FIDO2 authentication (no passwords)
 *   - Session token in httpOnly cookie (30min standard, 10min elevated)
 *   - Elevated auth per high-risk approval (YubiKey signs the specific action)
 *   - Binds to 0.0.0.0 — LAN only (add firewall rule if needed)
 *   - All data stays local — never leaves your machine
 *
 * SETUP (first run):
 *   1. Visit http://your-ip:3000/setup
 *   2. Register your YubiKey (name it, tap the key)
 *   3. Done — future visits require a key tap to log in
 *
 * IMPORTANT — rpID config:
 *   Set WEBAUTHN_RP_ID in .env to the hostname/IP you use to access the app.
 *   If accessing from phone via IP: WEBAUTHN_RP_ID=192.168.x.x
 *   For mDNS hostname:            WEBAUTHN_RP_ID=argos.local
 *   WebAuthn requires HTTPS for non-localhost — use a local cert or Tailscale HTTPS.
 */

import express, { type Request, type Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { createLogger } from '../logger.js';
import { getDb } from '../db/index.js';
import { handleCallback } from '../gateway/approval.js';
import { executeProposal } from '../workers/index.js';
import {
  hasRegisteredKeys,
  requireAuth,
  beginRegistration,
  completeRegistration,
  beginAuthentication,
  completeAuthentication,
  beginElevatedAuth,
  completeElevatedAuth,
  listCredentials,
  revokeSession,
  revokeAll,
  pruneExpiredChallenges,
  pruneExpiredSessions,
} from './webauthn.js';
import type { Proposal, ProposedAction } from '../types.js';

const log = createLogger('webapp');

// ─── WebSocket broadcast ──────────────────────────────────────────────────────

const wsClients = new Set<WebSocket>();

export function broadcastEvent(event: string, data?: unknown): void {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// ─── API routes ───────────────────────────────────────────────────────────────

function buildApi(
  sendToApprovalChat: (text: string) => Promise<void>,
  getConfig: () => { owner: { name: string; teams: string[] }; readOnly: boolean },
) {
  const router = express.Router();

  // ── TOTP routes (no auth required — these ARE the auth) ──────────────────

  router.post('/auth/totp/setup', async (_req, res) => {
    try {
      const { ensureTotpTable, generateTotpSecret, generateQRCode, storeTotpSecret } = await import('./totp.js');
      ensureTotpTable();
      const { secret, uri } = generateTotpSecret();
      const qrDataUrl = await generateQRCode(uri);
      const secretId = storeTotpSecret(secret);
      res.json({ success: true, qrDataUrl, secretId });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/auth/totp/verify', async (req, res) => {
    try {
      const { secretId, code } = req.body as { secretId: number; code: string };
      const { ensureTotpTable, verifyAndActivateTotp, createSession } = await import('./totp.js');
      ensureTotpTable();
      const valid = verifyAndActivateTotp(secretId, code);
      if (!valid) {
        res.json({ success: false, message: 'Invalid code' });
        return;
      }
      const token = createSession('totp');
      res.cookie('argos_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.WEBAUTHN_ORIGIN?.startsWith('https') ?? false, maxAge: 13 * 60 * 60 * 1000 });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/auth/totp/login', async (req, res) => {
    try {
      const { code } = req.body as { code: string };
      const { ensureTotpTable, validateTotpCode, createSession } = await import('./totp.js');
      ensureTotpTable();
      const valid = validateTotpCode(code);
      if (!valid) {
        res.json({ success: false, message: 'Invalid code' });
        return;
      }
      const token = createSession('totp');
      res.cookie('argos_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.WEBAUTHN_ORIGIN?.startsWith('https') ?? false, maxAge: 13 * 60 * 60 * 1000 });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  // ── WebAuthn routes (no auth required — these ARE the auth) ───────────────

  // Setup check — are any keys registered?
  router.get('/auth/status', async (_req, res) => {
    let totpConfigured = false;
    try {
      const { ensureTotpTable, hasTotpConfigured } = await import('./totp.js');
      ensureTotpTable();
      totpConfigured = hasTotpConfigured();
    } catch { /* totp module not loaded yet */ }
    res.json({ registered: hasRegisteredKeys() || totpConfigured, keys: listCredentials(), totp: totpConfigured });
  });

  // Registration: step 1 — generate challenge
  router.post('/auth/register/begin', async (req, res) => {
    const { deviceName = 'YubiKey' } = req.body as { deviceName?: string };
    try {
      const result = await beginRegistration(deviceName);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  // Registration: step 2 — verify response and save credential
  router.post('/auth/register/complete', async (req, res) => {
    const { challengeId, response, deviceName } = req.body as {
      challengeId: string; response: unknown; deviceName: string;
    };
    const result = await completeRegistration(challengeId, response as Parameters<typeof completeRegistration>[1], deviceName);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  });

  // Authentication: step 1 — generate challenge
  router.post('/auth/login/begin', async (_req, res) => {
    try {
      const result = await beginAuthentication();
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  // Authentication: step 2 — verify and issue session
  router.post('/auth/login/complete', async (req, res) => {
    const { challengeId, response } = req.body as { challengeId: string; response: unknown };
    const result = await completeAuthentication(challengeId, response as Parameters<typeof completeAuthentication>[1]);
    if (result.success && result.sessionToken) {
      // Set httpOnly cookie — 30min, SameSite=Strict
      res.setHeader('Set-Cookie',
        `argos_session=${result.sessionToken}; HttpOnly; SameSite=Strict; Max-Age=1800; Path=/`
      );
      res.json({ success: true, message: result.message });
    } else {
      res.status(401).json(result);
    }
  });

  // Logout
  router.post('/auth/logout', (req, res) => {
    const token = extractSessionToken(req);
    if (token) revokeSession(token);
    res.setHeader('Set-Cookie', 'argos_session=; HttpOnly; Max-Age=0; Path=/');
    res.json({ success: true });
  });

  // ── All routes below require authentication ──────────────────────────────

  router.use(requireAuth('standard'));

  // Status
  router.get('/status', (_req, res) => {
    const db = getDb();
    const config = getConfig();
    res.json({
      owner: config.owner.name,
      teams: config.owner.teams,
      readOnly: config.readOnly,
      tasks: {
        open: (db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE status='open'`).get() as { c: number }).c,
        mine: (db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE status='open' AND is_my_task=1`).get() as { c: number }).c,
      },
      proposals: {
        pending: (db.prepare(`SELECT COUNT(*) as c FROM proposals WHERE status='proposed'`).get() as { c: number }).c,
      },
      memories: {
        active: (db.prepare(`SELECT COUNT(*) as c FROM memories WHERE expires_at IS NULL OR expires_at > ?`).get(Date.now()) as { c: number }).c,
      },
    });
  });

  // Proposals
  router.get('/proposals', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT p.id, p.context_summary, p.plan, p.actions, p.draft_reply,
             p.status, p.created_at, p.expires_at
      FROM proposals p
      WHERE p.status = 'proposed'
      ORDER BY p.created_at DESC
      LIMIT 20
    `).all() as Array<Record<string, unknown>>;

    res.json(rows.map(r => {
      const rawActions = JSON.parse(r.actions as string) as Array<Record<string, unknown>>;
      // Normalize action format for frontend
      const actions = rawActions.map(a => ({
        description: a.description ?? a.action ?? a.tool ?? 'Unknown action',
        details: a.details ?? JSON.stringify(a.input ?? {}).slice(0, 200),
        risk: a.risk ?? 'low',
        tool: a.tool ?? a.action,
      }));
      return {
        ...r,
        actions,
        expiresInMin: Math.max(0, Math.round(((r.expires_at as number) - Date.now()) / 60_000)),
      };
    }));
  });

  // Elevated auth: begin (for high-risk proposals)
  router.post('/proposals/:id/elevate/begin', async (req, res) => {
    try {
      const result = await beginElevatedAuth(req.params.id);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  // Elevated auth: complete (YubiKey signs the specific proposal ID)
  router.post('/proposals/:id/elevate/complete', async (req, res) => {
    const { challengeId, response } = req.body as { challengeId: string; response: unknown };
    const result = await completeElevatedAuth(
      challengeId,
      response as Parameters<typeof completeElevatedAuth>[1],
    );
    if (result.success && result.sessionToken) {
      res.setHeader('Set-Cookie',
        `argos_session=${result.sessionToken}; HttpOnly; SameSite=Strict; Max-Age=600; Path=/`
      );
      res.json({ success: true, proposalId: result.proposalId });
    } else {
      res.status(401).json(result);
    }
  });

  // Approve — requires elevated clearance for high-risk actions
  // Approve a proposal — TOTP sessions can approve low/medium risk
  router.post('/proposals/:id/approve', requireAuth('standard'), async (req, res) => {
    const proposalId = req.params.id;

    try {
      const db = getDb();
      const proposal = db.prepare(
        "SELECT id, context_summary, plan, actions, status FROM proposals WHERE id = ?"
      ).get(proposalId) as { id: string; context_summary: string; plan: string; actions: string; status: string } | undefined;

      if (!proposal) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }
      if (proposal.status !== 'proposed') {
        res.status(400).json({ error: `Proposal already ${proposal.status}` });
        return;
      }

      // Execute the actions
      // Mark as approved first
      db.prepare("UPDATE proposals SET status = 'approved', approved_at = ? WHERE id = ?").run(Date.now(), proposalId);
      broadcastEvent('proposal_updated', { id: proposalId, status: 'approved' });

      // Execute asynchronously — don't block the HTTP response
      res.json({ ok: true, message: 'Approved — executing…' });

      // Execute in background
      import('../workers/proposal-executor.js').then(async ({ executeApprovedProposal }) => {
        const { llmConfigFromEnv } = await import('../llm/index.js');
        const llmConfig = llmConfigFromEnv();
        const notify = async (text: string) => { await sendToApprovalChat(text); };
        const result = await executeApprovedProposal(String(proposalId), llmConfig, notify);

        // Inject execution result into the bot's conversation so it has context
        try {
          const db = getDb();
          const allConvs = db.prepare("SELECT user_id, messages FROM conversations").all() as Array<{ user_id: string; messages: string }>;
          for (const conv of allConvs) {
            const msgs = JSON.parse(conv.messages) as Array<{ role: string; content: string }>;
            const summary = result.success
              ? `[Proposal ${String(proposalId).slice(-8)} executed successfully]\n${result.results.join('\n')}`
              : `[Proposal ${String(proposalId).slice(-8)} execution had errors]\n${result.results.join('\n')}\n${result.errors.join('\n')}`;
            msgs.push({ role: 'assistant', content: summary });
            db.prepare("UPDATE conversations SET messages = ?, updated_at = ? WHERE user_id = ?")
              .run(JSON.stringify(msgs), Date.now(), conv.user_id);
          }
        } catch { /* non-blocking */ }

        if (!result.success) {
          log.error(`Proposal execution had errors: ${result.errors.join(', ')}`);
        }
      }).catch(e => {
        log.error(`Proposal execution failed: ${e}`);
        sendToApprovalChat(`⚠️ Proposal execution failed: ${e instanceof Error ? e.message : String(e)}`).catch(() => {});
      });

      return; // response already sent
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Reject
  router.post('/proposals/:id/reject', requireAuth('standard'), async (req, res) => {
    const proposalId = req.params.id;
    try {
      const db = getDb();
      const { reason } = req.body as { reason?: string };
      const proposal = db.prepare("SELECT plan FROM proposals WHERE id = ?").get(proposalId) as { plan: string } | undefined;
      db.prepare("UPDATE proposals SET status = 'rejected', rejection_reason = ? WHERE id = ? AND status = 'proposed'")
        .run(reason ?? null, proposalId);
      broadcastEvent('proposal_updated', { id: proposalId, status: 'rejected' });

      // Notify via messaging channel
      try {
        await sendToApprovalChat(`❌ Proposal rejected:\n${proposal?.plan ?? proposalId}${reason ? `\nReason: ${reason}` : ''}`);
      } catch { /* non-blocking */ }

      res.json({ ok: true, message: 'Rejected' });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Tasks
  router.get('/tasks', (req, res) => {
    const db = getDb();
    const filter = req.query.filter as string | undefined; // 'mine' | 'all' | 'history'

    // Combine real tasks + approved/executed proposals
    const tasks = db.prepare(`
      SELECT id, title, description, category, partner_name, chat_id,
             assigned_team, is_my_task, status, detected_at as created_at, 'task' as source
      FROM tasks
      WHERE status IN ('open', 'in_progress')
      ${filter === 'mine' ? 'AND is_my_task = 1' : ''}
    `).all() as Array<Record<string, unknown>>;

    const proposals = db.prepare(`
      SELECT id, plan as title, context_summary as description, status,
             created_at, approved_at, executed_at, 'proposal' as source
      FROM proposals
      ORDER BY created_at DESC
      LIMIT 50
    `).all() as Array<Record<string, unknown>>;

    // Merge and sort by date
    const all = [
      ...tasks.map(t => ({ ...t, statusLabel: t.status as string })),
      ...proposals.map(p => ({
        ...p,
        statusLabel: p.status === 'proposed' ? '⏳ pending approval'
          : p.status === 'approved' ? '🔄 executing…'
          : p.status === 'executed' ? '✅ done'
          : p.status === 'partial' ? '⚠️ partially done'
          : p.status === 'rejected' ? '❌ rejected'
          : String(p.status),
      })),
    ].sort((a, b) => ((b as Record<string, unknown>).created_at as number ?? 0) - ((a as Record<string, unknown>).created_at as number ?? 0));

    res.json(all);
  });

  // Complete task
  router.post('/tasks/:id/complete', (req, res) => {
    const db = getDb();
    db.prepare(`UPDATE tasks SET status='completed', completed_at=? WHERE id=?`).run(Date.now(), req.params.id);
    broadcastEvent('task_updated', { id: req.params.id, status: 'completed' });
    res.json({ ok: true });
  });

  // History — completed/cancelled tasks + executed/rejected proposals
  router.get('/history', (_req, res) => {
    const db = getDb();
    const tasks = db.prepare(`
      SELECT id, title, description, category, partner_name, assigned_team,
             is_my_task, status, detected_at, completed_at
      FROM tasks
      WHERE status IN ('completed', 'cancelled', 'follow_up')
      ORDER BY COALESCE(completed_at, detected_at) DESC
      LIMIT 50
    `).all();

    const proposals = db.prepare(`
      SELECT id, task_id, context_summary, plan, actions, draft_reply,
             status, created_at, approved_at, executed_at, rejection_reason
      FROM proposals
      WHERE status IN ('executed', 'rejected', 'expired')
      ORDER BY COALESCE(executed_at, created_at) DESC
      LIMIT 50
    `).all() as Array<Record<string, unknown>>;

    res.json({
      tasks,
      proposals: proposals.map(p => ({ ...p, actions: JSON.parse(p.actions as string) })),
    });
  });

  // Plugins catalog — MCP catalog + enabled state from config
  router.get('/plugins', (_req, res) => {
    const cfg = getConfig() as unknown as import('../config/schema.js').Config;
    const enabled = new Set((cfg.mcpServers ?? []).filter(s => s.enabled).map(s => s.name));
    const skillEnabled = new Set((cfg.skills ?? []).filter(s => s.enabled !== false).map(s => s.name));

    const { MCP_CATALOG: catalog }   = require('../mcp/index.js') as typeof import('../mcp/index.js');
    const { SKILL_CATALOG: skills }  = require('../skills/registry.js') as typeof import('../skills/registry.js');

    res.json({
      mcpServers: catalog.map(s => ({ ...s, enabled: enabled.has(s.name) })),
      skills:     skills.map(s => ({ ...s, enabled: skillEnabled.has(s.name) })),
    });
  });

  // Memories
  router.get('/memories', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, content, tags, category, partner_name, importance, archived, expires_at, created_at
      FROM memories
      WHERE expires_at IS NULL OR expires_at > ?
      ORDER BY importance DESC, created_at DESC
      LIMIT 30
    `).all(Date.now()) as Array<Record<string, unknown>>;
    res.json(rows.map(r => ({ ...r, tags: JSON.parse(r.tags as string) })));
  });

  return router;
}

// ─── Session token extraction helper ─────────────────────────────────────────

function extractSessionToken(req: Request): string | null {
  const cookieHeader = req.headers.cookie ?? '';
  const match = cookieHeader.match(/argos_session=([^;]+)/);
  if (match?.[1]) return match[1];
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// ─── HTML app (single-file, no bundler) ──────────────────────────────────────

const HTML_APP = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Argos</title>
  <script src="https://unpkg.com/@simplewebauthn/browser@13/dist/bundle/index.umd.min.js"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    :root {
      --bg: #ffffff;
      --surface: #f8f9fc;
      --border: #e2e5f0;
      --text: #1a1d2e;
      --muted: #6b7280;
      --accent: #2563eb;
      --green: #059669;
      --red: #dc2626;
      --yellow: #d97706;
      --radius: 12px;
      --safe-top: env(safe-area-inset-top, 0px);
      --safe-bottom: env(safe-area-inset-bottom, 0px);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg); color: var(--text);
      min-height: 100dvh; padding-bottom: calc(80px + var(--safe-bottom));
    }
    header {
      position: sticky; top: 0; z-index: 10;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: calc(12px + var(--safe-top)) 16px 12px;
      display: flex; align-items: center; justify-content: space-between;
    }
    header h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.3px; }
    .status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--green); box-shadow: 0 0 6px var(--green);
    }
    nav {
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 10;
      background: var(--surface); border-top: 1px solid var(--border);
      display: flex; padding-bottom: var(--safe-bottom);
    }
    nav button {
      flex: 1; padding: 12px 8px 10px; background: none; border: none;
      color: var(--muted); font-size: 11px; cursor: pointer;
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      transition: color 0.15s;
    }
    nav button.active { color: var(--accent); }
    nav button svg { width: 22px; height: 22px; }
    .page { display: none; padding: 12px 16px; }
    .page.active { display: block; }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 14px; margin-bottom: 10px;
    }
    .card-header { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
    .badge {
      font-size: 10px; font-weight: 600; padding: 2px 6px;
      border-radius: 4px; white-space: nowrap;
    }
    .badge-red { background: #7f1d1d; color: #fca5a5; }
    .badge-yellow { background: #713f12; color: #fde68a; }
    .badge-green { background: #14532d; color: #86efac; }
    .card-title { font-size: 14px; font-weight: 500; line-height: 1.4; flex: 1; }
    .card-meta { font-size: 12px; color: var(--muted); margin-bottom: 10px; }
    .card-plan { font-size: 13px; color: #a0a0bc; line-height: 1.5; margin-bottom: 10px;
      max-height: 80px; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent); }
    .draft-reply { background: #0f172a; border-radius: 8px; padding: 10px;
      font-size: 12px; color: #94a3b8; margin-bottom: 10px; font-style: italic; }
    .actions-list { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
    .actions-list li { padding: 3px 0; list-style: none; }
    .btn-row { display: flex; gap: 8px; }
    .btn {
      flex: 1; padding: 10px; border-radius: 8px; border: none; cursor: pointer;
      font-size: 14px; font-weight: 500; transition: opacity 0.15s;
    }
    .btn:active { opacity: 0.7; }
    .btn-approve { background: var(--green); color: #fff; }
    .btn-reject { background: var(--surface); color: var(--red); border: 1px solid var(--red); }
    .expiry { font-size: 11px; color: var(--muted); margin-top: 8px; }
    .task-item { display: flex; align-items: flex-start; gap: 10px; padding: 12px 0; border-bottom: 1px solid var(--border); }
    .task-item:last-child { border-bottom: none; }
    .task-check { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--border);
      background: none; cursor: pointer; flex-shrink: 0; transition: background 0.15s, border-color 0.15s; }
    .task-check:active { background: var(--green); border-color: var(--green); }
    .task-info { flex: 1; }
    .task-title { font-size: 14px; line-height: 1.4; }
    .task-title.mine { color: var(--accent); }
    .task-partner { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .memory-item { padding: 12px 0; border-bottom: 1px solid var(--border); }
    .memory-item:last-child { border-bottom: none; }
    .memory-content { font-size: 13px; line-height: 1.5; }
    .memory-meta { font-size: 11px; color: var(--muted); margin-top: 4px; display: flex; gap: 8px; }
    .importance-bar {
      height: 2px; background: var(--border); border-radius: 1px; margin-top: 6px;
    }
    .importance-fill { height: 100%; border-radius: 1px; background: var(--accent); }
    .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
    .stat-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 14px;
    }
    .stat-value { font-size: 28px; font-weight: 700; margin-bottom: 4px; }
    .stat-label { font-size: 12px; color: var(--muted); }
    .empty { text-align: center; padding: 40px 20px; color: var(--muted); font-size: 14px; }
    .toast {
      position: fixed; bottom: calc(90px + var(--safe-bottom)); left: 16px; right: 16px;
      background: var(--accent); color: #fff; padding: 12px 16px; border-radius: var(--radius);
      font-size: 14px; font-weight: 500; z-index: 100; opacity: 0;
      transition: opacity 0.2s; pointer-events: none;
    }
    .toast.show { opacity: 1; }
    .filter-row { display: flex; gap: 8px; margin-bottom: 12px; }
    .filter-btn {
      padding: 6px 12px; border-radius: 20px; border: 1px solid var(--border);
      background: none; color: var(--muted); font-size: 12px; cursor: pointer;
    }
    .filter-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .history-section { margin-bottom: 20px; }
    .history-section h3 { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px; }
    .history-item { padding: 10px 0; border-bottom: 1px solid var(--border); }
    .history-item:last-child { border-bottom: none; }
    .history-title { font-size: 13px; line-height: 1.4; }
    .history-meta { font-size: 11px; color: var(--muted); margin-top: 3px; display: flex; gap: 8px; flex-wrap: wrap; }
    .status-pill { display: inline-block; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; }
    .pill-completed { background: #14532d; color: #86efac; }
    .pill-executed { background: #1e3a5f; color: #93c5fd; }
    .pill-rejected { background: #7f1d1d; color: #fca5a5; }
    .pill-expired { background: #292524; color: #a8a29e; }
    .pill-follow_up { background: #713f12; color: #fde68a; }
    .pill-cancelled { background: #292524; color: #a8a29e; }
  </style>
</head>
<body>

<header>
  <h1>🔭 Argos</h1>
  <div class="status-dot" id="status-dot" title="Live"></div>
</header>

<div id="page-approvals" class="page active">
  <div id="proposals-list"></div>
</div>

<div id="page-tasks" class="page">
  <div class="filter-row">
    <button class="filter-btn active" onclick="setTaskFilter('all', this)">All</button>
    <button class="filter-btn" onclick="setTaskFilter('mine', this)">Mine 👤</button>
    <button class="filter-btn" onclick="setTaskFilter('history', this)">History 📜</button>
  </div>
  <div id="tasks-list"></div>
</div>

<div id="page-memory" class="page">
  <div id="memory-list"></div>
</div>

<div id="page-history" class="page">
  <div class="history-section">
    <h3>Completed Tasks</h3>
    <div class="card" id="history-tasks-list"></div>
  </div>
  <div class="history-section">
    <h3>Executed Proposals</h3>
    <div class="card" id="history-proposals-list"></div>
  </div>
</div>

<div id="page-status" class="page">
  <div class="stat-grid" id="stat-grid"></div>
</div>

<nav>
  <button class="active" onclick="showPage('approvals', this)">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
    Approvals
  </button>
  <button onclick="showPage('tasks', this)">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
    Tasks
  </button>
  <button onclick="showPage('memory', this)">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
    Memory
  </button>
  <button onclick="showPage('history', this)">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
    History
  </button>
  <button onclick="showPage('status', this)">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
    Status
  </button>
</nav>

<div class="toast" id="toast"></div>

<script>

// ─── Navigation ───────────────────────────────────────────────────────────────
function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  btn.classList.add('active');
  refresh(name);
}

function toast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch('/api' + path, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const e = new Error(err.error || res.statusText);
    e.code = err.code;
    throw e;
  }
  return res.json();
}

async function post(path) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
}

// ─── Approvals page ───────────────────────────────────────────────────────────
async function loadProposals() {
  const proposals = await api('/proposals');
  const el = document.getElementById('proposals-list');
  if (!proposals.length) {
    el.innerHTML = '<div class="empty">✅ No pending approvals</div>';
    return;
  }
  el.innerHTML = proposals.map(p => {
    const risk = p.actions.some(a => a.risk === 'high') ? 'high'
      : p.actions.some(a => a.risk === 'medium') ? 'medium' : 'low';
    const riskBadge = risk === 'high' ? '<span class="badge badge-red">🔴 HIGH RISK</span>'
      : risk === 'medium' ? '<span class="badge badge-yellow">🟡 MEDIUM</span>'
      : '<span class="badge badge-green">🟢 LOW</span>';
    const actions = p.actions.map(a => \`<li><strong>\${a.description}</strong>\${a.details ? \`<pre style="white-space:pre-wrap;font-size:12px;color:var(--muted);margin:4px 0;max-height:200px;overflow:auto">\${a.details.slice(0, 500)}</pre>\` : ''}</li>\`).join('');
    const draft = p.draft_reply
      ? \`<div class="draft-reply">💬 "\${p.draft_reply.slice(0, 150)}\${p.draft_reply.length > 150 ? '…' : ''}"</div>\`
      : '';
    return \`
      <div class="card" id="proposal-\${p.id}">
        <div class="card-header">\${riskBadge}<span class="card-title">\${p.context_summary.slice(0, 100)}</span></div>
        <div class="card-plan">\${p.plan.slice(0, 200)}</div>
        \${draft}
        <ul class="actions-list">\${actions}</ul>
        <div class="btn-row" id="btns-\${p.id}"></div>
        <div id="otp-input-\${p.id}" style="display:none;margin-top:8px">
          <input type="text" inputmode="numeric" maxlength="6" placeholder="000000"
            style="padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:16px;text-align:center;letter-spacing:4px;width:140px"
            onkeyup="if(this.value.length===6)confirmOtpApprove('\${p.id}',this.value)">
        </div>
        <div class="expiry">⏱ Expires in \${p.expiresInMin}min · ID \${p.id.slice(-8)}</div>
      </div>
    \`;
  }).join('');

  // Render approve buttons based on auth methods available
  renderApproveButtons(proposals);
}

async function renderApproveButtons(proposals) {
  const status = await fetch('/api/auth/status').then(r => r.json());
  const hasYubikey = status.keys?.length > 0;

  for (const p of proposals) {
    const el = document.getElementById('btns-' + p.id);
    if (!el) continue;

    const isHighRisk = p.actions?.some(a => a.risk === 'high');

    if (isHighRisk) {
      // High risk → require re-auth (OTP or YubiKey)
      if (hasYubikey) {
        el.innerHTML = \`
          <button class="btn btn-approve" onclick="approveWithYubikey('\${p.id}')">🔑 Approve (YubiKey)</button>
          <button class="btn btn-reject" onclick="reject('\${p.id}')">❌ Reject</button>
        \`;
      } else {
        el.innerHTML = \`
          <button class="btn btn-approve" onclick="approveWithOtp('\${p.id}')">📱 Approve (OTP)</button>
          <button class="btn btn-reject" onclick="reject('\${p.id}')">❌ Reject</button>
        \`;
      }
    } else {
      // Low/medium risk → one-click approve (session already authenticated)
      el.innerHTML = \`
        <button class="btn btn-approve" onclick="approveDirectly('\${p.id}')">✅ Approve</button>
        <button class="btn btn-reject" onclick="reject('\${p.id}')">❌ Reject</button>
      \`;
    }
  }
}

async function reject(id) {
  try {
    await api(\`/proposals/\${id}/reject\`, { method: 'POST', body: JSON.stringify({}) });
    document.getElementById('proposal-' + id)?.remove();
    toast('❌ Rejected');
    loadStatus();
  } catch(e) { toast('Error: ' + e.message); }
}

// ─── Tasks page ───────────────────────────────────────────────────────────────
let taskFilter = 'all';
function setTaskFilter(f, btn) {
  taskFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadTasks();
}

async function loadTasks() {
  const tasks = await api('/tasks?filter=' + taskFilter);
  const el = document.getElementById('tasks-list');
  if (!tasks.length) {
    el.innerHTML = '<div class="empty">✅ No tasks yet</div>';
    return;
  }
  el.innerHTML = '<div class="card">' + tasks.map(t => {
    const statusIcon = t.statusLabel?.includes('approved') ? '✅'
      : t.statusLabel?.includes('rejected') ? '❌'
      : t.statusLabel?.includes('pending') ? '⏳'
      : t.source === 'task' ? '📋' : '📄';
    const isCompleted = t.statusLabel?.includes('approved') || t.statusLabel?.includes('rejected');
    return \`
    <div class="task-item" id="task-\${t.id}" style="\${isCompleted ? 'opacity:0.6' : ''}">
      \${t.source === 'task' ? \`<button class="task-check" onclick="completeTask('\${t.id}')" title="Mark done"></button>\` : \`<span style="font-size:20px;margin-right:8px">\${statusIcon}</span>\`}
      <div class="task-info">
        <div class="task-title">\${t.title}</div>
        <div class="task-partner" style="font-size:12px;color:var(--muted)">
          \${t.statusLabel ?? t.status}
          \${t.partner_name ? ' · 🤝 ' + t.partner_name : ''}
          \${t.source === 'proposal' ? ' · 📋 proposal' : ''}
        </div>
      </div>
    </div>
  \`}).join('') + '</div>';
}

async function completeTask(id) {
  const el = document.getElementById('task-' + id);
  if (el) el.style.opacity = '0.4';
  try {
    await post(\`/tasks/\${id}/complete\`);
    setTimeout(() => el?.remove(), 400);
    toast('✅ Task completed');
  } catch(e) {
    if (el) el.style.opacity = '1';
    toast('Error: ' + e.message);
  }
}

// ─── Memory page ──────────────────────────────────────────────────────────────
async function loadMemory() {
  const memories = await api('/memories');
  const el = document.getElementById('memory-list');
  if (!memories.length) {
    el.innerHTML = '<div class="empty">🧠 No active memories</div>';
    return;
  }
  el.innerHTML = '<div class="card">' + memories.map(m => \`
    <div class="memory-item">
      <div class="memory-content">\${m.content.slice(0, 200)}</div>
      <div class="memory-meta">
        <span>\${m.partner_name || 'general'}</span>
        <span>[\${m.category}]</span>
        <span>\${m.archived ? '📌 archived' : (m.expires_at ? new Date(m.expires_at).toLocaleDateString('fr-FR') : '∞')}</span>
      </div>
      <div class="importance-bar"><div class="importance-fill" style="width:\${m.importance*10}%"></div></div>
    </div>
  \`).join('') + '</div>';
}

// ─── Status page ──────────────────────────────────────────────────────────────
async function loadStatus() {
  const s = await api('/status');
  document.getElementById('stat-grid').innerHTML = \`
    <div class="stat-card"><div class="stat-value" style="color:var(--yellow)">\${s.proposals.pending}</div><div class="stat-label">Pending approvals</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--accent)">\${s.tasks.open}</div><div class="stat-label">Open tasks</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--green)">\${s.tasks.mine}</div><div class="stat-label">My tasks</div></div>
    <div class="stat-card"><div class="stat-value">\${s.memories.active}</div><div class="stat-label">Active memories</div></div>
    <div class="stat-card" style="grid-column: span 2">
      <div class="stat-label" style="margin-bottom:6px">Owner</div>
      <div style="font-size:14px">\${s.owner} · \${s.teams.join(', ')}</div>
      <div style="font-size:12px; color:var(--muted); margin-top:4px">Read-only: \${s.readOnly ? '🔒 ON' : '🔓 OFF'}</div>
    </div>
  \`;
}

// ─── History page ─────────────────────────────────────────────────────────────
async function loadHistory() {
  const { tasks, proposals } = await api('/history');

  const tasksEl = document.getElementById('history-tasks-list');
  if (!tasks.length) {
    tasksEl.innerHTML = '<div class="empty" style="padding:20px">No completed tasks yet</div>';
  } else {
    tasksEl.innerHTML = tasks.map(t => {
      const pill = \`<span class="status-pill pill-\${t.status}">\${t.status.replace('_',' ')}</span>\`;
      const date = new Date(t.completed_at || t.detected_at).toLocaleDateString('fr-FR');
      return \`
        <div class="history-item">
          <div class="history-title">\${t.title}</div>
          <div class="history-meta">
            \${pill}
            \${t.partner_name ? '<span>🤝 ' + t.partner_name + '</span>' : ''}
            \${t.assigned_team ? '<span>' + t.assigned_team + '</span>' : ''}
            <span>\${date}</span>
          </div>
        </div>
      \`;
    }).join('');
  }

  const proposalsEl = document.getElementById('history-proposals-list');
  if (!proposals.length) {
    proposalsEl.innerHTML = '<div class="empty" style="padding:20px">No executed proposals yet</div>';
  } else {
    proposalsEl.innerHTML = proposals.map(p => {
      const pill = \`<span class="status-pill pill-\${p.status}">\${p.status}</span>\`;
      const date = new Date(p.executed_at || p.created_at).toLocaleDateString('fr-FR');
      const reason = p.rejection_reason ? \`<span>❌ \${p.rejection_reason.slice(0,60)}</span>\` : '';
      return \`
        <div class="history-item">
          <div class="history-title">\${p.context_summary.slice(0,100)}</div>
          <div class="history-meta">
            \${pill}
            <span>\${p.actions.length} action\${p.actions.length > 1 ? 's' : ''}</span>
            \${reason}
            <span>\${date}</span>
          </div>
        </div>
      \`;
    }).join('');
  }
}

// ─── Routing ──────────────────────────────────────────────────────────────────
function refresh(page) {
  switch(page) {
    case 'approvals': loadProposals(); break;
    case 'tasks': loadTasks(); break;
    case 'memory': loadMemory(); break;
    case 'history': loadHistory(); break;
    case 'status': loadStatus(); break;
  }
}

// ─── WebSocket (real-time updates) ───────────────────────────────────────────
function connectWS() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onmessage = (e) => {
    const { event, data } = JSON.parse(e.data);
    const active = document.querySelector('.page.active');
    if (!active) return;
    const activePage = active.id.replace('page-', '');

    if (event === 'proposal_created' || event === 'proposal_updated') {
      if (activePage === 'approvals') loadProposals();
      document.getElementById('status-dot').style.boxShadow = '0 0 10px var(--yellow)';
      setTimeout(() => document.getElementById('status-dot').style.boxShadow = '0 0 6px var(--green)', 2000);
    }
    if (event === 'task_updated') {
      if (activePage === 'tasks') loadTasks();
    }
  };
  ws.onclose = () => {
    document.getElementById('status-dot').style.background = 'var(--red)';
    setTimeout(connectWS, 3000);
  };
  ws.onopen = () => {
    document.getElementById('status-dot').style.background = 'var(--green)';
  };
}

// ─── Login (TOTP + optional YubiKey) ─────────────────────────────────────────
let loginChallengeId = null;

async function showLogin() {
  // Check what auth methods are available
  const status = await fetch('/api/auth/status').then(r => r.json());
  const hasTotp = status.totp;
  const hasKeys = status.registered && status.keys?.length > 0;

  let loginHtml = \`
    <div style="min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:32px;max-width:340px;width:100%;text-align:center">
        <div style="font-size:48px;margin-bottom:16px">🔐</div>
        <h2 style="font-size:20px;margin-bottom:8px">Argos</h2>
  \`;

  if (hasTotp) {
    loginHtml += \`
        <p style="font-size:14px;color:var(--muted);margin-bottom:16px">Enter your 2FA code to log in</p>
        <input id="login-code" type="text" inputmode="numeric" maxlength="6" placeholder="000000"
          style="width:100%;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:18px;text-align:center;letter-spacing:6px;margin-bottom:12px"
          autocomplete="one-time-code">
        <button onclick="loginTotp()" style="width:100%;padding:14px;background:var(--accent);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:8px">
          📱 Verify Code
        </button>
    \`;
  }

  if (hasKeys) {
    if (hasTotp) {
      loginHtml += \`<div style="display:flex;align-items:center;gap:12px;margin:12px 0;color:var(--muted);font-size:12px"><div style="flex:1;height:1px;background:var(--border)"></div>or<div style="flex:1;height:1px;background:var(--border)"></div></div>\`;
    }
    loginHtml += \`
        <button onclick="loginYubikey()" style="width:100%;padding:14px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:10px;font-size:15px;font-weight:500;cursor:pointer">
          🔑 YubiKey
        </button>
    \`;
  }

  if (!hasTotp && !hasKeys) {
    loginHtml += \`<p style="font-size:14px;color:var(--muted)">No auth configured — <a href="/setup" style="color:var(--accent)">set up 2FA</a></p>\`;
  }

  loginHtml += \`
        <div id="login-status" style="margin-top:12px;font-size:13px;color:var(--muted)"></div>
      </div>
    </div>
  \`;

  document.body.innerHTML = loginHtml;

  // Auto-submit on 6 digits
  const codeInput = document.getElementById('login-code');
  if (codeInput) {
    codeInput.focus();
    codeInput.addEventListener('input', () => {
      if (codeInput.value.length === 6) loginTotp();
    });
  }
}

async function loginTotp() {
  const code = document.getElementById('login-code')?.value?.trim();
  if (!code || code.length !== 6) return;
  const statusEl = document.getElementById('login-status');
  if (statusEl) statusEl.textContent = 'Verifying…';
  try {
    const result = await fetch('/api/auth/totp/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ code })
    }).then(r => r.json());
    if (result.success) {
      location.reload();
    } else {
      if (statusEl) { statusEl.style.color = '#ef4444'; statusEl.textContent = '❌ Invalid code'; }
    }
  } catch(e) {
    if (statusEl) { statusEl.style.color = '#ef4444'; statusEl.textContent = '❌ ' + e.message; }
  }
}

async function loginYubikey() {
  const statusEl = document.getElementById('login-status');
  if (statusEl) statusEl.textContent = 'Touch your YubiKey…';
  try {
    const { options, challengeId } = await fetch('/api/auth/login/begin', { method:'POST' }).then(r => r.json());
    loginChallengeId = challengeId;
    const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
    const result = await fetch('/api/auth/login/complete', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ challengeId, response })
    }).then(r => r.json());
    if (result.success) {
      location.reload();
    } else {
      if (statusEl) { statusEl.style.color = '#ef4444'; statusEl.textContent = '❌ ' + result.message; }
    }
  } catch(e) {
    if (statusEl) { statusEl.style.color = '#ef4444'; statusEl.textContent = '❌ ' + (e.message || 'Auth failed'); }
  }
}

// ─── Approve with YubiKey (elevated auth — key signs the specific proposal) ───

// Direct approve (low/medium risk — session already authenticated)
async function approveDirectly(id) {
  try {
    const result = await api(\`/proposals/\${id}/approve\`, { method: 'POST' });
    if (result.ok) {
      document.getElementById('proposal-' + id)?.remove();
      toast('✅ ' + (result.message || 'Approved'));
      loadStatus();
    } else {
      toast('❌ ' + (result.error || 'Failed'));
    }
  } catch(e) {
    if (e.code === 'SESSION_EXPIRED') { toast('🔒 Session expired'); showLogin(); }
    else toast('❌ ' + (e.message || 'Failed'));
  }
}

// OTP approve: show code input (high risk only)
function approveWithOtp(id) {
  const el = document.getElementById('otp-input-' + id);
  if (el) {
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
    if (el.style.display === 'block') el.querySelector('input')?.focus();
  }
}

// Confirm OTP and approve
async function confirmOtpApprove(id, code) {
  try {
    // Verify OTP first
    const otpResult = await fetch('/api/auth/totp/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    }).then(r => r.json());

    if (!otpResult.success) {
      toast('❌ Invalid OTP code');
      return;
    }

    // Now approve with fresh session
    const result = await api(\`/proposals/\${id}/approve\`, { method: 'POST' });
    if (result.ok) {
      document.getElementById('proposal-' + id)?.remove();
      toast('✅ ' + (result.message || 'Approved'));
      loadStatus();
    } else {
      toast('❌ ' + (result.error || 'Approval failed'));
    }
  } catch(e) {
    toast('❌ ' + (e.message || 'Approval failed'));
  }
}

// YubiKey approve: elevated auth flow
async function approveWithYubikey(id) {
  try {
    const { options, challengeId } = await api(\`/proposals/\${id}/elevate/begin\`, { method: 'POST' });
    toast('Touch your YubiKey to approve…', 10000);
    const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
    const elevateResult = await fetch(\`/api/proposals/\${id}/elevate/complete\`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, response })
    }).then(r => r.json());

    if (!elevateResult.success) {
      toast('❌ Key verification failed');
      return;
    }

    const result = await api(\`/proposals/\${id}/approve\`, { method: 'POST' });
    if (result.ok) {
      document.getElementById('proposal-' + id)?.remove();
      toast('✅ ' + (result.message || 'Approved'));
      loadStatus();
    } else {
      toast('❌ ' + (result.error || 'Approval failed'));
    }
  } catch(e) {
    if (e.name === 'NotAllowedError') {
      toast('⏰ Key tap timed out or cancelled');
    } else {
      toast('❌ ' + (e.message || 'Approval failed'));
    }
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
// Check auth status on load
fetch('/api/status').then(r => {
  if (r.status === 401) { showLogin(); return; }
  loadProposals();
  connectWS();
}).catch(() => showLogin());
</script>
</body>
</html>`;

// ─── Setup page (first-run YubiKey registration) ─────────────────────────────

const SETUP_PAGE = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Argos Setup</title>
  <script src="https://unpkg.com/@simplewebauthn/browser@13/dist/bundle/index.umd.min.js"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    :root { --bg:#ffffff; --surface:#f8f9fc; --border:#e2e5f0; --text:#1a1d2e; --muted:#6b7280; --accent:#2563eb; --green:#059669; --red:#dc2626; --yellow:#d97706; }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'Inter',-apple-system,sans-serif; background:var(--bg); color:var(--text); min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:24px; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:32px; max-width:400px; width:100%; }
    h1 { font-size:24px; margin-bottom:8px; text-align:center; }
    .subtitle { font-size:14px; color:var(--muted); margin-bottom:24px; line-height:1.5; text-align:center; }
    .methods { display:flex; gap:8px; margin-bottom:20px; }
    .methods button { flex:1; padding:12px 8px; background:var(--bg); border:1px solid var(--border); border-radius:10px; color:var(--muted); font-size:13px; font-weight:500; cursor:pointer; transition:all .15s; }
    .methods button.active { border-color:var(--accent); color:var(--text); background:rgba(99,102,241,.1); }
    .method-panel { display:none; }
    .method-panel.active { display:block; }
    input { width:100%; padding:12px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:15px; margin-bottom:12px; text-align:center; letter-spacing:4px; }
    input.name-input { text-align:left; letter-spacing:normal; }
    .btn { width:100%; padding:14px; background:var(--accent); color:#fff; border:none; border-radius:10px; font-size:15px; font-weight:600; cursor:pointer; transition:opacity .15s; }
    .btn:active { opacity:.7; }
    .btn:disabled { opacity:.4; cursor:not-allowed; }
    .qr-container { text-align:center; margin:16px 0; }
    .qr-container img { border-radius:12px; }
    .qr-hint { font-size:12px; color:var(--muted); text-align:center; margin:8px 0 16px; }
    .status { margin-top:16px; padding:12px; border-radius:8px; font-size:13px; display:none; }
    .status.ok { background:#14532d; color:#86efac; display:block; }
    .status.err { background:#7f1d1d; color:#fca5a5; display:block; }
    .status.info { background:#f0f4ff; color:#4b5563; display:block; }
    .divider { display:flex; align-items:center; gap:12px; margin:20px 0; color:var(--muted); font-size:12px; }
    .divider::before, .divider::after { content:''; flex:1; height:1px; background:var(--border); }
  </style>
</head>
<body>
<div class="card">
  <h1>🔭 Argos Setup</h1>
  <p class="subtitle">Set up 2FA to secure your Argos dashboard.<br>Sessions expire after 8 hours.</p>

  <div class="methods">
    <button class="active" onclick="switchMethod('totp')">📱 Authenticator</button>
    <button onclick="switchMethod('yubikey')">🔑 YubiKey</button>
  </div>

  <!-- TOTP panel -->
  <div id="panel-totp" class="method-panel active">
    <div id="qr-step-1">
      <p class="qr-hint">Loading QR code…</p>
      <div class="btn" onclick="initTotp()">Generate QR Code</div>
    </div>
    <div id="qr-step-2" style="display:none">
      <div class="qr-container"><img id="qr-img" alt="TOTP QR Code"></div>
      <p class="qr-hint">Scan with Google Authenticator, Microsoft Authenticator, Authy, or any TOTP app.</p>
      <input id="totp-code" type="text" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code">
      <div class="btn" onclick="verifyTotp()">Verify Code</div>
    </div>
  </div>

  <!-- YubiKey panel -->
  <div id="panel-yubikey" class="method-panel">
    <input id="key-name" class="name-input" placeholder="Device name (e.g. YubiKey 5C)" value="YubiKey">
    <div class="btn" onclick="registerYubikey()">🔐 Register YubiKey</div>
  </div>

  <div id="status" class="status"></div>
</div>

<script>
let totpSecretId = null;

function switchMethod(method) {
  document.querySelectorAll('.methods button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.method-panel').forEach(p => p.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('panel-' + method).classList.add('active');
  document.getElementById('status').className = 'status';
}

async function initTotp() {
  const status = document.getElementById('status');
  status.className = 'status info';
  status.textContent = 'Generating secret…';
  try {
    const res = await fetch('/api/auth/totp/setup', { method:'POST' }).then(r => r.json());
    if (!res.success) throw new Error(res.message);
    totpSecretId = res.secretId;
    document.getElementById('qr-img').src = res.qrDataUrl;
    document.getElementById('qr-step-1').style.display = 'none';
    document.getElementById('qr-step-2').style.display = 'block';
    status.className = 'status';
  } catch(e) {
    status.className = 'status err';
    status.textContent = e.message;
  }
}

async function verifyTotp() {
  const code = document.getElementById('totp-code').value.trim();
  if (code.length !== 6) return;
  const status = document.getElementById('status');
  status.className = 'status info';
  status.textContent = 'Verifying…';
  try {
    const res = await fetch('/api/auth/totp/verify', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ secretId: totpSecretId, code })
    }).then(r => r.json());
    if (res.success) {
      status.className = 'status ok';
      status.textContent = '✅ 2FA enabled — redirecting…';
      setTimeout(() => location.href = '/', 1500);
    } else {
      status.className = 'status err';
      status.textContent = '❌ Invalid code — try again';
    }
  } catch(e) {
    status.className = 'status err';
    status.textContent = e.message;
  }
}

async function registerYubikey() {
  const deviceName = document.getElementById('key-name').value.trim() || 'YubiKey';
  const status = document.getElementById('status');
  status.className = 'status info';
  status.textContent = 'Touch your YubiKey when it blinks…';
  try {
    const { options, challengeId } = await fetch('/api/auth/register/begin', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ deviceName })
    }).then(r => r.json());
    const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
    const result = await fetch('/api/auth/register/complete', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ challengeId, response, deviceName })
    }).then(r => r.json());
    if (result.success) {
      status.className = 'status ok';
      status.textContent = '✅ ' + result.message + ' — redirecting…';
      setTimeout(() => location.href = '/', 1500);
    } else {
      status.className = 'status err';
      status.textContent = '❌ ' + result.message;
    }
  } catch(e) {
    status.className = 'status err';
    status.textContent = e.message;
  }
}

// Auto-focus code input
document.getElementById('totp-code')?.addEventListener('input', e => {
  if (e.target.value.length === 6) verifyTotp();
});
</script>
</body>
</html>`;

// ─── Start server ─────────────────────────────────────────────────────────────

export interface WebAppOptions {
  port?: number;
  sendToApprovalChat: (text: string) => Promise<void>;
  getConfig: () => { owner: { name: string; teams: string[] }; readOnly: boolean };
}

export function startWebApp(options: WebAppOptions): void {
  const port = options.port ?? parseInt(process.env.APP_PORT ?? '3000', 10);

  const app = express();

  // ── Security headers ──────────────────────────────────────────────────────
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // ── CORS — restrict to configured origin ──────────────────────────────────
  const allowedOrigin = process.env.WEBAUTHN_ORIGIN ?? `http://localhost:${port}`;
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) {
      res.status(403).json({ error: 'CORS: origin not allowed' });
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // ── Rate limiting for auth routes ─────────────────────────────────────────
  const authAttempts = new Map<string, { count: number; resetAt: number }>();
  const AUTH_RATE_WINDOW = 60_000;  // 1 minute
  const AUTH_RATE_LIMIT = 10;       // max attempts per window

  function rateLimitAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const entry = authAttempts.get(ip);
    if (entry && entry.resetAt > now) {
      if (entry.count >= AUTH_RATE_LIMIT) {
        res.status(429).json({ error: 'Too many auth attempts — try again later' });
        return;
      }
      entry.count++;
    } else {
      authAttempts.set(ip, { count: 1, resetAt: now + AUTH_RATE_WINDOW });
    }
    // Cleanup old entries periodically
    if (authAttempts.size > 1000) {
      for (const [key, val] of authAttempts) {
        if (val.resetAt < now) authAttempts.delete(key);
      }
    }
    next();
  }

  app.use(express.json());

  // Rate limit auth endpoints
  app.use('/api/auth/login', rateLimitAuth);
  app.use('/api/auth/register', rateLimitAuth);
  app.use('/api/auth/totp', rateLimitAuth);

  // WebAuthn routes + authenticated API
  app.use('/api', buildApi(options.sendToApprovalChat, options.getConfig));

  // Setup page — served without auth (needed to register first key)
  app.get('/setup', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(SETUP_PAGE);
  });

  // Main app — redirect to /setup if no auth configured yet
  app.get('/', async (_req, res) => {
    let totpConfigured = false;
    try {
      const { hasTotpConfigured } = await import('./totp.js');
      totpConfigured = hasTotpConfigured();
    } catch { /* */ }
    if (!hasRegisteredKeys() && !totpConfigured) {
      res.redirect('/setup');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(HTML_APP);
  });

  const server = http.createServer(app);

  // WebSocket — requires valid session cookie
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    // Basic session check on WS upgrade
    const cookieHeader = req.headers.cookie ?? '';
    const tokenMatch = cookieHeader.match(/argos_session=([^;]+)/);
    if (!tokenMatch?.[1]) {
      ws.close(4401, 'Unauthenticated');
      return;
    }
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });

  // Cleanup cron — every 10min prune expired challenges + sessions
  setInterval(() => {
    pruneExpiredChallenges();
    pruneExpiredSessions();
  }, 10 * 60 * 1000);

  server.listen(port, '0.0.0.0', async () => {
    const { networkInterfaces } = await import('os');
    const localIp = Object.values(networkInterfaces())
      .flat()
      .find(i => i?.family === 'IPv4' && !i.internal)
      ?.address ?? 'your-mac-ip';

    log.info(`📱 Web app running:`);
    log.info(`   Local:    http://localhost:${port}`);
    log.info(`   Network:  http://${localIp}:${port}`);
    if (!hasRegisteredKeys()) {
      log.info(`   ⚠️  No YubiKey registered — visit http://${localIp}:${port}/setup`);
    }
    log.info(`   RP ID: ${process.env.WEBAUTHN_RP_ID ?? 'localhost'} (set WEBAUTHN_RP_ID to match your access URL)`);
  });
}
