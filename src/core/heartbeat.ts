/**
 * Argos Heartbeat — proactive reasoning without incoming messages.
 *
 * On each tick, Claude:
 *   1. Reads recent memory, open tasks, pending approvals
 *   2. Checks agent-created cron triggers
 *   3. Produces proposals if something actionable is found
 *
 * Two entry points:
 *   runHeartbeat(config)     — the regular pulse (every N minutes)
 *   runProactivePlan(prompt) — fired by agent-created cron jobs
 *
 * Proposals produced here still go through the normal approval gateway.
 */

import Anthropic from '@anthropic-ai/sdk';
import { monotonicFactory } from 'ulid';
import { getDb, audit } from '../db/index.js';
import { createLogger } from '../logger.js';
import { getSkillToolDefinitions, executeSkill } from '../skills/registry.js';
import { buildAnthropicMcpConfig } from '../mcp/index.js';
import { requestApproval } from '../gateway/approval.js';
import type { Config } from '../config/schema.js';
import type { Proposal, ProposedAction, WorkerType } from '../types.js';

const ulid = monotonicFactory();
const log = createLogger('heartbeat');

// ─── Snapshot of current Argos state (anonymized) ────────────────────────────

function buildStateSnapshot(): string {
  const db = getDb();
  const now = Date.now();

  const openTasks = db.prepare(`
    SELECT title, assigned_team, detected_at FROM tasks
    WHERE status IN ('open', 'in_progress')
    ORDER BY detected_at DESC LIMIT 10
  `).all() as Array<{ title: string; assigned_team: string | null; detected_at: number }>;

  const pendingApprovals = db.prepare(`
    SELECT id, context_summary, expires_at FROM approvals
    WHERE status = 'pending' AND expires_at > ?
    ORDER BY created_at DESC LIMIT 5
  `).all(now) as Array<{ id: string; context_summary: string; expires_at: number }>;

  const recentMemories = db.prepare(`
    SELECT content, partner_name, importance, created_at FROM memories
    WHERE (expires_at IS NULL OR expires_at > ?) AND archived = 0
    ORDER BY importance DESC, created_at DESC LIMIT 8
  `).all(now) as Array<{ content: string; partner_name: string | null; importance: number; created_at: number }>;

  const agentCrons = db.prepare(`
    SELECT name, schedule, last_run FROM cron_jobs
    WHERE enabled = 1 AND name LIKE 'agent:%'
    ORDER BY name
  `).all() as Array<{ name: string; schedule: string; last_run: number | null }>;

  const lines: string[] = [];

  lines.push(`=== CURRENT TIME: ${new Date().toISOString()} ===\n`);

  if (openTasks.length) {
    lines.push(`OPEN/IN-PROGRESS TASKS (${openTasks.length}):`);
    for (const t of openTasks) {
      const age = Math.round((now - t.detected_at) / 3600000);
      lines.push(`  • [${age}h old] ${t.title}${t.assigned_team ? ` (team: ${t.assigned_team})` : ''}`);
    }
    lines.push('');
  } else {
    lines.push('OPEN TASKS: none\n');
  }

  if (pendingApprovals.length) {
    lines.push(`PENDING APPROVALS (${pendingApprovals.length}):`);
    for (const a of pendingApprovals) {
      const expiresIn = Math.round((a.expires_at - now) / 60000);
      lines.push(`  • ${a.context_summary?.slice(0, 80) ?? '?'} (expires in ${expiresIn}min)`);
    }
    lines.push('');
  }

  if (recentMemories.length) {
    lines.push('RECENT MEMORY CONTEXT:');
    for (const m of recentMemories) {
      const partner = m.partner_name ? ` [${m.partner_name}]` : '';
      lines.push(`  • [imp:${m.importance}${partner}] ${m.content.slice(0, 120)}`);
    }
    lines.push('');
  }

  if (agentCrons.length) {
    lines.push('AGENT SCHEDULED JOBS:');
    for (const j of agentCrons) {
      const lastRun = j.last_run ? `last ran ${new Date(j.last_run).toISOString()}` : 'never ran';
      lines.push(`  • ${j.name} [${j.schedule}] — ${lastRun}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── System prompt for proactive mode ────────────────────────────────────────

function buildHeartbeatSystemPrompt(config: Config, customPrompt?: string): string {
  return `You are Argos, a proactive AI assistant for ${config.owner.name}.
You work with ${config.owner.teams.join(', ')} teams.

You are running in PROACTIVE MODE — there are no new incoming messages.
Your job is to review the current state and decide if any actions are needed.

RULES:
1. Only propose actions if there is a real reason — don't create noise.
2. You STILL propose, not execute. All actions go through the owner's approval gateway.
3. Be specific: reference actual tasks, partners, or memory entries.
4. If nothing needs attention: respond with a short text summary only (no tool calls).

${customPrompt ? `CUSTOM INSTRUCTIONS FOR THIS RUN:\n${customPrompt}\n` : ''}
Use available tools to gather more context if needed (web_search, memory_search, fetch_url, crypto_price), then propose any relevant actions.`;
}

// ─── Proactive planner ────────────────────────────────────────────────────────

export async function runProactivePlan(
  config: Config,
  opts: {
    /** Custom prompt / focus for this run (from agent cron config) */
    prompt?: string;
    /** Human-readable label for audit trail */
    label?: string;
    sendToApprovalChat: (text: string) => Promise<void>;
  },
): Promise<void> {
  const label = opts.label ?? 'heartbeat';
  log.info(`Proactive plan: ${label}`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { log.warn('No ANTHROPIC_API_KEY — skipping heartbeat'); return; }

  const client = new Anthropic({ apiKey });
  const stateSnapshot = buildStateSnapshot();

  const skillTools = getSkillToolDefinitions(config.skills) as unknown as Anthropic.Tool[];
  const mcpServers = buildAnthropicMcpConfig(config.mcpServers ?? []);
  const useMcp = mcpServers.length > 0;

  // Proposal tools — same subset as the planner (no create_cron_job here to avoid recursion)
  const PROPOSAL_TOOLS: Anthropic.Tool[] = [
    {
      name: 'draft_reply',
      description: 'Prepare a draft reply or message for the owner to review and send',
      input_schema: {
        type: 'object',
        properties: {
          to:       { type: 'string', description: 'Recipient' },
          content:  { type: 'string', description: 'Message content' },
          urgency:  { type: 'string', enum: ['low', 'medium', 'high'] },
          notes_for_owner: { type: 'string', description: 'Why this reply is needed' },
        },
        required: ['to', 'content', 'urgency'],
      },
    },
    {
      name: 'create_notion_entry',
      description: 'Write a note, task, or summary to Notion',
      input_schema: {
        type: 'object',
        properties: {
          title:         { type: 'string' },
          content:       { type: 'string' },
          database_type: { type: 'string', enum: ['task', 'note', 'partner', 'deal', 'tx_review'] },
          tags:          { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'content', 'database_type'],
      },
    },
    {
      name: 'set_reminder',
      description: 'Set a follow-up reminder via Telegram',
      input_schema: {
        type: 'object',
        properties: {
          message:     { type: 'string' },
          fire_at:     { type: 'string', description: 'ISO 8601 datetime' },
          context_ref: { type: 'string' },
        },
        required: ['message', 'fire_at'],
      },
    },
  ];

  const allTools = [...PROPOSAL_TOOLS, ...skillTools];
  const systemPrompt = buildHeartbeatSystemPrompt(config, opts.prompt);
  const userMsg = `${stateSnapshot}\n\nReview the above and decide if any proactive action is needed. If yes, use the tools. If not, say so briefly.`;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMsg }];
  const actions: ProposedAction[] = [];
  let planText = '';
  let iterations = 0;

  while (iterations++ < 5) {
    const response = useMcp
      ? await (client.beta.messages.create as Function)({
          model:       config.claude.model,
          max_tokens:  2048,
          temperature: 0.2,
          system:      systemPrompt,
          tools:       allTools,
          mcp_servers: mcpServers,
          messages,
          betas:       ['mcp-client-2025-04-04'],
        })
      : await client.messages.create({
          model:       config.claude.model,
          max_tokens:  2048,
          temperature: 0.2,
          system:      systemPrompt,
          tools:       allTools,
          messages,
        });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        planText += (planText ? '\n' : '') + block.text;
        continue;
      }
      if (block.type === 'tool_use') {
        // Skill → execute immediately
        if (skillTools.some(t => t.name === block.name)) {
          const result = await executeSkill(block.name, block.input as Record<string, unknown>, config.skills);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result.output });
          continue;
        }
        // Proposal → queue
        const workerType: WorkerType =
          block.name.includes('calendar') ? 'calendar' :
          block.name.includes('notion')   ? 'notion'   :
          block.name.includes('reminder') || block.name.includes('cron') ? 'scheduler' :
          'reply';
        actions.push({
          type: workerType,
          description: `[${label}] ${block.name}: ${JSON.stringify(block.input).slice(0, 80)}`,
          risk: 'low',
          payload: { tool: block.name, input: block.input as Record<string, unknown> },
          requiresApproval: true,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ status: 'queued_for_approval' }),
        });
      }
    }

    if (response.stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  // Nothing actionable → log and move on
  if (actions.length === 0) {
    log.info(`Heartbeat [${label}]: no actions needed — "${planText.slice(0, 120)}"`);
    audit('heartbeat_idle', undefined, 'heartbeat', { label, summary: planText.slice(0, 200) });
    return;
  }

  // Persist proposal and request approval
  const now = Date.now();
  const proposal: Proposal = {
    id: ulid(),
    contextSummary: `[${label}] ${planText.slice(0, 200) || 'Proactive action'}`,
    plan: planText,
    actions,
    status: 'proposed',
    createdAt: now,
    expiresAt: now + config.approval.defaultExpiryMs,
  };

  const db = getDb();
  db.prepare(`
    INSERT INTO proposals (id, context_summary, plan, actions, draft_reply, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)
  `).run(
    proposal.id,
    proposal.contextSummary,
    proposal.plan,
    JSON.stringify(proposal.actions),
    null,
    proposal.createdAt,
    proposal.expiresAt,
  );

  log.info(`Heartbeat [${label}]: ${actions.length} action(s) proposed → ${proposal.id}`);
  audit('heartbeat_proposal', proposal.id, 'heartbeat', { label, actions: actions.length });

  await requestApproval(proposal);
}

// ─── Regular heartbeat (called by cron) ──────────────────────────────────────

export async function runHeartbeat(
  config: Config,
  sendToApprovalChat: (text: string) => Promise<void>,
): Promise<void> {
  if (!config.heartbeat?.enabled) return;
  await runProactivePlan(config, {
    prompt:              config.heartbeat.prompt,
    label:               'heartbeat',
    sendToApprovalChat,
  });
}
