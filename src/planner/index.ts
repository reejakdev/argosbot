/**
 * Argos Planner — the reasoning core.
 *
 * Receives minimized, sanitized context and produces:
 *   - A structured plan with proposed actions
 *   - A draft reply (if relevant)
 *   - A transaction pack (if category = tx_request)
 *
 * Uses Claude tool use (function calling) for agentic behavior.
 * Tools are NEVER executed here — they are proposed and sent to the
 * Approval Gateway. Only after approval does a worker execute them.
 *
 * Supported tools (proposals only, not execution):
 *   - draft_reply: prepare a message to send
 *   - create_calendar_event: schedule a meeting/reminder
 *   - create_notion_entry: write to agent Notion workspace
 *   - prepare_tx_pack: prepare a crypto transaction for review
 *   - create_task: track an internal task
 *   - set_reminder: schedule a follow-up
 */

import Anthropic from '@anthropic-ai/sdk';
import { monotonicFactory } from 'ulid';
import { getDb, audit } from '../db/index.js';
import { createLogger } from '../logger.js';
import { search as memorySearch } from '../memory/store.js';
import { getSkillToolDefinitions, executeSkill } from '../skills/registry.js';
import { buildAnthropicMcpConfig } from '../mcp/index.js';
import { buildSystemPrompt } from '../prompts/index.js';
import type {
  ContextWindow,
  ClassificationResult,
  Proposal,
  ProposedAction,
  WorkerType,
} from '../types.js';
import type { LLMConfig } from '../llm/index.js';
import type { Config } from '../config/schema.js';

const ulid = monotonicFactory();
const log = createLogger('planner');

// ─── Tool definitions (proposals only) ────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'draft_reply',
    description: 'Prepare a draft reply to send to the partner/client. The message will NOT be sent until approved by the owner.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Partner name or channel' },
        content: { type: 'string', description: 'The draft message content' },
        urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
        notes_for_owner: { type: 'string', description: 'Internal notes explaining why this reply' },
      },
      required: ['to', 'content', 'urgency'],
    },
  },
  {
    name: 'create_calendar_event',
    description: 'Create or propose a calendar event. Will be created only after owner approval.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        start_time: { type: 'string', description: 'ISO 8601 datetime' },
        end_time: { type: 'string', description: 'ISO 8601 datetime' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'List of attendee identifiers' },
      },
      required: ['title', 'start_time', 'end_time'],
    },
  },
  {
    name: 'create_notion_entry',
    description: 'Write a structured entry to the agent\'s Notion workspace (NOT the main company workspace). Owner can then copy it if useful.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown content for the page' },
        database_type: { type: 'string', enum: ['task', 'note', 'partner', 'deal', 'tx_review'], description: 'Which template to use' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'content', 'database_type'],
    },
  },
  {
    name: 'prepare_tx_pack',
    description: 'Prepare a crypto transaction review pack. This is READ-ONLY — it collects information for the owner to review before manually executing.',
    input_schema: {
      type: 'object',
      properties: {
        chain: { type: 'string', description: 'Blockchain (ethereum, arbitrum, base, solana, etc.)' },
        operation: { type: 'string', enum: ['deposit', 'withdrawal', 'swap', 'bridge', 'approve', 'other'] },
        vault_ref: { type: 'string', description: 'Vault/contract reference (anonymized)' },
        asset: { type: 'string', description: 'Token/asset name' },
        amount_ref: { type: 'string', description: 'Amount bucket or reference (e.g. [AMT_10K-100K_USDC])' },
        checklist: { type: 'array', items: { type: 'string' }, description: 'Due diligence checklist items' },
        risks: { type: 'array', items: { type: 'string' }, description: 'Identified risks' },
        notes: { type: 'string' },
      },
      required: ['chain', 'operation', 'checklist'],
    },
  },
  {
    name: 'create_task',
    description: 'Track an internal task or follow-up item.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        assigned_team: { type: 'string' },
        due_date: { type: 'string', description: 'ISO 8601 date, optional' },
      },
      required: ['title'],
    },
  },
  {
    name: 'set_reminder',
    description: 'Set a follow-up reminder to be sent via Telegram at a specified time.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Reminder content' },
        fire_at: { type: 'string', description: 'ISO 8601 datetime when to send the reminder' },
        context_ref: { type: 'string', description: 'Reference to what this is about' },
      },
      required: ['message', 'fire_at'],
    },
  },
  {
    name: 'create_cron_job',
    description: 'Schedule a recurring task that Argos will run automatically. Use when the user asks for something recurring (e.g. "remind me every Monday", "check prices daily", "send me a summary every Friday 5pm"). Requires owner approval before activation.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique name for this job (snake_case, e.g. "weekly_price_check")',
        },
        schedule: {
          type: 'string',
          description: 'Cron expression (5-field standard). Examples: "0 9 * * 1" = every Monday 9am, "0 17 * * 5" = Fridays 5pm, "0 8 * * 1-5" = weekdays 8am, "*/30 * * * *" = every 30min',
        },
        prompt: {
          type: 'string',
          description: 'What Argos should do when this job fires — written as a clear instruction (e.g. "Search for ETH price and send me a summary", "Check open tasks older than 48h and remind me", "Send a weekly digest of partner activity")',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of what this job does',
        },
      },
      required: ['name', 'schedule', 'prompt', 'description'],
    },
  },
  {
    name: 'delete_cron_job',
    description: 'Cancel and delete a recurring job that was previously created.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the cron job to delete',
        },
        reason: {
          type: 'string',
          description: 'Why this job is being deleted',
        },
      },
      required: ['name'],
    },
  },
];

// buildSystemPrompt is now imported from src/prompts/index.ts

// ─── Build context for planner ────────────────────────────────────────────────

function buildUserPrompt(
  window: ContextWindow,
  result: ClassificationResult,
  relevantMemories: string,
): string {
  const messages = window.messages.map((m, i) =>
    `[${i + 1}] ${new Date(m.receivedAt).toISOString()}\n${m.content}`
  ).join('\n\n');

  return `=== INCOMING MESSAGES (${window.messages.length} in batch) ===
Partner: ${window.partnerName ?? 'unknown'} | Chat: ${window.chatId}
Category: ${result.category} | Urgency: ${result.urgency} | Importance: ${result.importance}/10
Is my task: ${result.isMyTask} | Team: ${result.assignedTeam ?? 'none'}
Tags: ${result.tags.join(', ') || 'none'}

Classification summary: ${result.summary}

${messages}

=== RELEVANT MEMORY CONTEXT ===
${relevantMemories || '(no relevant previous context)'}

Based on this, propose the appropriate actions using the available tools.
If this is category "ignore" or importance < 3, you may propose nothing.`;
}

// ─── Tool call → ProposedAction ───────────────────────────────────────────────

function toolCallToAction(
  name: string,
  input: Record<string, unknown>,
): ProposedAction {
  const riskMap: Record<string, 'low' | 'medium' | 'high'> = {
    draft_reply: 'low',
    create_calendar_event: 'low',
    create_notion_entry: 'low',
    prepare_tx_pack: 'medium',
    create_task: 'low',
    set_reminder: 'low',
    create_cron_job: 'low',
    delete_cron_job: 'medium',
  };

  const workerMap: Record<string, WorkerType> = {
    draft_reply: 'reply',
    create_calendar_event: 'calendar',
    create_notion_entry: 'notion',
    prepare_tx_pack: 'reply',
    create_task: 'notion',
    set_reminder: 'reply',
    create_cron_job: 'scheduler',
    delete_cron_job: 'scheduler',
  };

  // Actions on the owner's own workspace don't need approval
  const autoApprove = new Set(['create_notion_entry', 'create_task', 'set_reminder']);

  return {
    type: workerMap[name] ?? 'reply',
    description: humanizeAction(name, input),
    risk: riskMap[name] ?? 'medium',
    payload: { tool: name, input },
    requiresApproval: !autoApprove.has(name),
  };
}

function humanizeAction(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'draft_reply':
      return `Draft reply to ${input.to}: "${String(input.content ?? '').slice(0, 80)}…"`;
    case 'create_calendar_event':
      return `Schedule: ${input.title} at ${input.start_time}`;
    case 'create_notion_entry':
      return `Notion entry [${input.database_type}]: ${input.title}`;
    case 'prepare_tx_pack':
      return `Tx review pack: ${input.operation} on ${input.chain} — ${input.asset ?? '?'} ${input.amount_ref ?? ''}`;
    case 'create_task':
      return `Track task: ${input.title}`;
    case 'set_reminder':
      return `Reminder at ${input.fire_at}: ${String(input.message ?? '').slice(0, 60)}`;
    case 'create_cron_job':
      return `Schedule recurring job "${input.name}" [${input.schedule}]: ${input.description}`;
    case 'delete_cron_job':
      return `Delete scheduled job "${input.name}"${input.reason ? ` — ${input.reason}` : ''}`;
    default:
      return `${name}: ${JSON.stringify(input).slice(0, 100)}`;
  }
}

// ─── Main planner function ────────────────────────────────────────────────────

export async function plan(
  window: ContextWindow,
  result: ClassificationResult,
  config: Config,
): Promise<Proposal | null> {
  // Skip low-importance ignore signals
  if (result.category === 'ignore' || (result.importance < 3 && !result.requiresAction)) {
    log.debug(`Skipping plan for window ${window.id} — category: ${result.category}, importance: ${result.importance}`);
    return null;
  }

  // Pull relevant memory context
  const memories = memorySearch({
    query: result.summary,
    partnerName: window.partnerName,
    limit: 5,
  });
  const memoryContext = memories.map(m =>
    `[${new Date(m.createdAt).toLocaleDateString()}] ${m.content}`
  ).join('\n');

  // ─── Anthropic tool use loop ───────────────────────────────────────────────
  // Only supports Anthropic for tool use in v1 (OpenAI tool use: coming)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const client = new Anthropic({ apiKey });

  const systemPrompt = buildSystemPrompt('planner', config);
  const userPrompt = buildUserPrompt(window, result, memoryContext);

  // Merge proposal tools + enabled skill tools
  const skillTools = getSkillToolDefinitions(config.skills) as unknown as Anthropic.Tool[];
  const allTools: Anthropic.Tool[] = [...TOOLS, ...skillTools];

  // MCP servers for the Anthropic beta API
  const mcpServers = buildAnthropicMcpConfig(config.mcpServers ?? []);
  const useMcp = mcpServers.length > 0;

  let planText = '';
  const actions: ProposedAction[] = [];
  let draftReply: string | undefined;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  // Agentic loop — Claude may use multiple tools in sequence
  let iterations = 0;
  const MAX_ITERATIONS = 8;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Use beta API when MCP servers are configured
    const response = useMcp
      ? await (client.beta.messages.create as Function)({
          model: config.claude.model,
          max_tokens: config.claude.maxTokens,
          temperature: config.claude.planningTemperature,
          system: systemPrompt,
          tools: allTools,
          mcp_servers: mcpServers,
          messages,
          betas: ['mcp-client-2025-04-04'],
        })
      : await client.messages.create({
          model: config.claude.model,
          max_tokens: config.claude.maxTokens,
          temperature: config.claude.planningTemperature,
          system: systemPrompt,
          tools: allTools,
          messages,
        });

    // Collect text from this turn
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        planText += (planText ? '\n' : '') + block.text;
        continue;
      }

      if (block.type === 'tool_use') {
        const toolName = block.name;
        const toolInput = block.input as Record<string, unknown>;

        // Skill tool — execute immediately (read-only by design)
        if (skillTools.some((t) => t.name === toolName)) {
          log.debug(`Executing skill: ${toolName}`, toolInput);
          const skillResult = await executeSkill(toolName, toolInput, config.skills);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: skillResult.output,
          });
          continue;
        }

        // Proposal tool — queue for approval
        const action = toolCallToAction(toolName, toolInput);
        actions.push(action);
        log.debug(`Tool proposed: ${toolName}`, toolInput);

        if (toolName === 'draft_reply') {
          draftReply = (toolInput as { content?: string }).content;
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ status: 'queued_for_approval', message: 'Action added to proposal — awaiting owner approval before execution' }),
        });
      }
    }

    // If Claude didn't use tools or said stop, we're done
    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
      break;
    }
    if (response.stop_reason !== 'tool_use') {
      break;
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  if (actions.length === 0 && !planText) {
    log.info(`Planner produced no actions for window ${window.id}`);
    return null;
  }

  // ─── Persist proposal ──────────────────────────────────────────────────────
  const llmConfig = { provider: 'anthropic', model: config.claude.model, apiKey } as LLMConfig;
  void llmConfig; // used above via Anthropic SDK directly

  const now = Date.now();
  const expiresAt = now + config.approval.defaultExpiryMs;

  const proposal: Proposal = {
    id: ulid(),
    contextSummary: result.summary,
    plan: planText,
    actions,
    draftReply,
    status: 'proposed',
    createdAt: now,
    expiresAt,
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
    proposal.draftReply ?? null,
    proposal.createdAt,
    proposal.expiresAt,
  );

  log.info(`Proposal ${proposal.id} created`, {
    actions: actions.length,
    hasDraft: !!draftReply,
    partner: window.partnerName,
  });

  audit('proposal_created', proposal.id, 'proposal', {
    category: result.category,
    actionCount: actions.length,
    partner: window.partnerName,
  });

  return proposal;
}
