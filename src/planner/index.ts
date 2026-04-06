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
import { buildSystemPrompt } from '../prompts/index.js';
import {
  llmConfigFromConfig,
  callWithTools,
  buildToolResultMessages,
  type LLMContentBlock,
} from '../llm/index.js';
import { llmForRole, buildPrivacyLlmConfig } from '../core/privacy.js';
import type {
  ContextWindow,
  ClassificationResult,
  Proposal,
  ProposedAction,
  WorkerType,
} from '../types.js';
import type { Config } from '../config/schema.js';

const ulid = monotonicFactory();
const log = createLogger('planner');

// ─── Tool definitions (proposals only) ────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'draft_reply',
    description:
      'Prepare a draft reply to send to the partner/client. The message will NOT be sent until approved by the owner.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Partner name or channel' },
        content: { type: 'string', description: 'The draft message content' },
        urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
        notes_for_owner: {
          type: 'string',
          description: 'Internal notes explaining why this reply',
        },
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
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of attendee identifiers',
        },
      },
      required: ['title', 'start_time', 'end_time'],
    },
  },
  {
    name: 'create_notion_entry',
    description:
      "Write a structured entry to the agent's Notion workspace (NOT the main company workspace). Owner can then copy it if useful.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown content for the page' },
        database_type: {
          type: 'string',
          enum: ['task', 'note', 'partner', 'deal', 'tx_review'],
          description: 'Which template to use',
        },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'content', 'database_type'],
    },
  },
  {
    name: 'prepare_tx_pack',
    description:
      'Prepare a crypto transaction review pack. This is READ-ONLY — it collects information for the owner to review before manually executing.',
    input_schema: {
      type: 'object',
      properties: {
        chain: {
          type: 'string',
          description: 'Blockchain (ethereum, arbitrum, base, solana, etc.)',
        },
        operation: {
          type: 'string',
          enum: ['deposit', 'withdrawal', 'swap', 'bridge', 'approve', 'other'],
        },
        vault_ref: { type: 'string', description: 'Vault/contract reference (anonymized)' },
        asset: { type: 'string', description: 'Token/asset name' },
        amount_ref: {
          type: 'string',
          description: 'Amount bucket or reference (e.g. [AMT_10K-100K_USDC])',
        },
        checklist: {
          type: 'array',
          items: { type: 'string' },
          description: 'Due diligence checklist items',
        },
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
    description:
      'Schedule a recurring task that Argos will run automatically. Use when the user asks for something recurring (e.g. "remind me every Monday", "check prices daily", "send me a summary every Friday 5pm"). Requires owner approval before activation.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique name for this job (snake_case, e.g. "weekly_price_check")',
        },
        schedule: {
          type: 'string',
          description:
            'Cron expression (5-field standard). Examples: "0 9 * * 1" = every Monday 9am, "0 17 * * 5" = Fridays 5pm, "0 8 * * 1-5" = weekdays 8am, "*/30 * * * *" = every 30min',
        },
        prompt: {
          type: 'string',
          description:
            'What Argos should do when this job fires — written as a clear instruction (e.g. "Search for ETH price and send me a summary", "Check open tasks older than 48h and remind me", "Send a weekly digest of partner activity")',
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
  {
    name: 'browser_action',
    description:
      'Automate a browser — navigate, fill forms, click, extract data. Use for web logins, form submissions, scraping, or any web interaction. If credentials are needed (password, card), pass a credential_ref (e.g. "vault:BankLogin") — the actual secret is NEVER sent here, only the reference name.',
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'What this automation does (shown to owner in approval)',
        },
        credential_ref: {
          type: 'string',
          description:
            'Optional: reference to a credential in the vault (e.g. "vault:BankLogin", "vault:MyBank/Login", "config:SOME_KEY"). The actual secret is resolved at execution time — never sent to the LLM.',
        },
        steps: {
          type: 'array',
          description: 'Ordered list of browser actions',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['navigate', 'fill', 'click', 'screenshot', 'wait', 'extract', 'submit'],
              },
              selector: {
                type: 'string',
                description: 'CSS selector for fill/click/extract/submit/wait',
              },
              url: { type: 'string', description: 'URL for navigate' },
              value: {
                type: 'string',
                description: 'Static value for fill (use credential_field for secrets)',
              },
              credential_field: {
                type: 'string',
                enum: [
                  'username',
                  'password',
                  'token',
                  'cardNumber',
                  'cardExpiry',
                  'cardCvv',
                  'value',
                ],
                description: 'Which field from the resolved credential to inject',
              },
              wait_for: { description: 'Selector string or ms number for wait action' },
              filename: { type: 'string', description: 'Filename for screenshot (optional)' },
            },
            required: ['action'],
          },
        },
      },
      required: ['description', 'steps'],
    },
  },
  {
    name: 'send_email',
    description:
      'Compose and send an email via SMTP. The email will NOT be sent until the owner approves. Use for replies to email threads, outbound communication, or forwarding summaries.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Recipient email address(es)',
        },
        cc: { type: 'array', items: { type: 'string' }, description: 'CC addresses (optional)' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Plain text email body' },
        reply_to: {
          type: 'string',
          description: 'Message-ID to reply to (for threading, optional)',
        },
        notes_for_owner: {
          type: 'string',
          description: 'Internal notes explaining why this email',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'create_agent',
    description:
      'Propose creating a new user-defined agent. Only the owner can approve this. Use when the owner explicitly asks to create an agent, or when you identify a recurring sub-task that would benefit from a dedicated specialized agent.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name in snake_case (e.g. deal_analyzer)' },
        description: {
          type: 'string',
          description: 'One-line description of what this agent does',
        },
        systemPrompt: {
          type: 'string',
          description: 'Full system prompt defining the agent persona, rules, and domain',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool names: ["web_search","fetch_url","semantic_search"] or ["*"] for all',
        },
        provider: {
          type: 'string',
          description:
            'LLM provider key (e.g. "anthropic", "openai", "ollama") — omit to use global',
        },
        model: { type: 'string', description: 'Model name — omit to use provider default' },
        linkedChannels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Channel refs to route directly to this agent, e.g. ["telegram:-100123"]',
        },
        isolatedWorkspace: {
          type: 'boolean',
          description: 'true = private memory namespace (recommended). false = shared global pool',
        },
        reason: {
          type: 'string',
          description: 'Why this agent is useful — shown to owner in approval request',
        },
      },
      required: ['name', 'description', 'systemPrompt', 'tools', 'reason'],
    },
  },
  {
    name: 'add_knowledge_source',
    description:
      'Index a new knowledge source (URL, raw GitHub file, GitHub repo) so Argos can search it in future replies. Use when you realize you are missing information that could be indexed from a known source.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch and index (https://...)' },
        name: { type: 'string', description: 'Short human-readable name for this source' },
        type: { type: 'string', enum: ['url', 'github'], description: 'Source type — default url' },
        owner: { type: 'string', description: 'GitHub owner (only for type=github)' },
        repo: { type: 'string', description: 'GitHub repo (only for type=github)' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific paths to index in the repo',
        },
      },
      required: ['name'],
    },
  },
];

// Linear tools — injected only when config.linear.apiKey is set.
const LINEAR_TOOLS: Anthropic.Tool[] = [
  {
    name: 'linear_create_issue',
    description:
      'Create a new issue in Linear. Use when the owner asks to track something in Linear, or when a partner request maps to a concrete engineering/ops task that belongs in the backlog. Requires owner approval.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue title' },
        teamId: {
          type: 'string',
          description: 'Linear team ID (e.g. "ENG", "OPS") — use the team that owns this work',
        },
        description: { type: 'string', description: 'Detailed description in Markdown (optional)' },
        priority: {
          type: 'number',
          enum: [0, 1, 2, 3, 4],
          description: '0=no priority 1=urgent 2=high 3=medium 4=low',
        },
      },
      required: ['title', 'teamId'],
    },
  },
  {
    name: 'linear_update_issue',
    description:
      'Update or close an existing Linear issue. Use when a task is completed, reprioritized, or needs a description update. Pass close=true to mark as done.',
    input_schema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Linear issue ID or identifier (e.g. "ENG-42")' },
        close: { type: 'boolean', description: 'Set true to mark as completed' },
        title: { type: 'string', description: 'New title (optional)' },
        description: { type: 'string', description: 'Updated description (optional)' },
        priority: { type: 'number', enum: [0, 1, 2, 3, 4] },
      },
      required: ['issueId'],
    },
  },
];

// Shell exec tool — injected only when config.shellExec.enabled is true.
const SHELL_EXEC_TOOL: Anthropic.Tool[] = [
  {
    name: 'shell_exec',
    description:
      'Run a whitelisted shell command on the owner\'s machine. ALWAYS set requiresApproval=true and risk="high". ' +
      'Allowed commands: git, ls, cat, grep, find, node, npm, npx, curl (HTTPS only), jq, ps, df. ' +
      'Never propose: rm, sudo, chmod, kill, or commands with shell metacharacters (;|&`). ' +
      'Always provide a clear reason.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The command name (no path, no args)' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments as separate strings',
        },
        workingDir: { type: 'string', description: 'Working directory (must be within HOME)' },
        timeoutSeconds: { type: 'number', description: 'Max seconds to wait (1-60)' },
        reason: { type: 'string', description: 'Why this command is needed' },
      },
      required: ['command', 'args', 'reason'],
    },
  },
];

// Injected at call-time when wallet is enabled — kept separate to avoid leaking
// chain/address info when wallet is disabled.
const PROPOSE_TX_TOOL: Anthropic.Tool = {
  name: 'sign_tx',
  description:
    "Propose signing and broadcasting a transaction from the bot's hot wallet. REQUIRES human approval before execution. Use only when the owner explicitly asks to send funds or execute an on-chain action.",
  input_schema: {
    type: 'object',
    properties: {
      chain: {
        type: 'string',
        description:
          'Chain name as configured (e.g. "ethereum", "base", "solana"). Use the name the owner used.',
      },
      to: {
        type: 'string',
        description:
          'Recipient address. Use the REAL address as provided by the owner (not an anonymized placeholder — the owner provides this directly).',
      },
      value: {
        type: 'string',
        description:
          'Amount in native token, human-readable (e.g. "0.1" for 0.1 ETH). DO NOT use anonymized buckets here.',
      },
      data: {
        type: 'string',
        description: 'Optional calldata for contract interactions (hex string starting with 0x).',
      },
      note: {
        type: 'string',
        description: 'Reason for this transaction — shown to owner in approval UI.',
      },
    },
    required: ['chain', 'to', 'value'],
  },
};

// buildSystemPrompt is now imported from src/prompts/index.ts

// ─── Build context for planner ────────────────────────────────────────────────

function buildUserPrompt(
  window: ContextWindow,
  result: ClassificationResult,
  relevantMemories: string,
): string {
  const messages = window.messages
    .map((m, i) => `[${i + 1}] ${new Date(m.receivedAt).toISOString()}\n${m.content}`)
    .join('\n\n');

  const agentSection = window.agentContext
    ? `\n=== AGENT PRE-ANALYSIS ===\n${window.agentContext}\n`
    : '';

  const duplicateNote = result.isDuplicate
    ? `\n⚠️  DUPLICATE FLAG: This is a repeat of a previous request. The partner has NOT received a reply yet — draft a reply to acknowledge and handle it, or escalate to the owner.`
    : '';

  return `=== INCOMING MESSAGES (${window.messages.length} in batch) ===
Partner: ${window.partnerName ?? 'unknown'} | Chat: ${window.chatId}${window.threadName ? ` | Topic: ${window.threadName}` : ''}
Category: ${result.category} | Urgency: ${result.urgency} | Importance: ${result.importance}/10
Is my task: ${result.isMyTask} | Team: ${result.assignedTeam ?? 'none'}
Tags: ${result.tags.join(', ') || 'none'}
${duplicateNote}
Classification summary: ${result.summary}

${messages}

=== RELEVANT MEMORY CONTEXT ===
${relevantMemories || '(no relevant previous context)'}
${agentSection}
Based on this, propose the appropriate actions using the available tools.${window.agentContext ? '\nAgent pre-analysis is provided above — use it directly, do not re-run the same analysis.' : ''}
If this is category "ignore" or importance < 3, you may propose nothing.
For client_request or task categories with requiresAction=true, ALWAYS propose at minimum a draft_reply — even if it's to acknowledge receipt and say you'll follow up.`;
}

// ─── Tool call → ProposedAction ───────────────────────────────────────────────

function toolCallToAction(name: string, input: Record<string, unknown>): ProposedAction {
  const riskMap: Record<string, 'low' | 'medium' | 'high'> = {
    draft_reply: 'low',
    create_calendar_event: 'low',
    create_notion_entry: 'low',
    prepare_tx_pack: 'medium',
    create_task: 'low',
    set_reminder: 'low',
    create_cron_job: 'low',
    delete_cron_job: 'medium',
    add_knowledge_source: 'low',
    linear_create_issue: 'medium',
    linear_update_issue: 'low',
    sign_tx: 'high',
    create_agent: 'medium',
    shell_exec: 'high',
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
    add_knowledge_source: 'notion',
    linear_create_issue: 'notion',
    linear_update_issue: 'notion',
    sign_tx: 'tx_sign',
    create_agent: 'agent',
    shell_exec: 'shell_exec',
  };

  // Actions on the owner's own workspace don't need approval
  const autoApprove = new Set([
    'create_notion_entry',
    'create_task',
    'set_reminder',
    'add_knowledge_source',
  ]);

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
    case 'add_knowledge_source':
      return `Index knowledge source: ${input.name} (${input.url ?? `github:${input.owner}/${input.repo}`})`;
    case 'linear_create_issue':
      return `Create Linear issue: "${input.title}" in team ${input.teamId}${input.priority !== undefined ? ` (priority ${input.priority})` : ''}`;
    case 'linear_update_issue':
      return `${input.close ? 'Close' : 'Update'} Linear issue ${input.issueId}${input.title ? ` → "${input.title}"` : ''}`;
    case 'sign_tx':
      return `Sign tx on ${input.chain}: ${input.value} → ${input.to}${input.note ? ` (${input.note})` : ''}`;
    case 'create_agent':
      return `Create agent "${input.name}" — ${input.description}${input.reason ? ` (${input.reason})` : ''}`;
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
    log.debug(
      `Skipping plan for window ${window.id} — category: ${result.category}, importance: ${result.importance}`,
    );
    return null;
  }

  // Pull relevant memory context — strictly scoped to this chatId.
  // field1 = chatId in both conversation and memory vectors — no cross-chat bleed.
  let memoryContext = '';
  const embCfg = (
    config as unknown as {
      embeddings?: { enabled?: boolean; baseUrl?: string; model?: string; apiKey?: string };
    }
  ).embeddings;
  if (embCfg?.enabled) {
    try {
      const { hybridSearch } = await import('../vector/store.js');
      const hits = await hybridSearch(
        result.summary,
        embCfg as import('../config/schema.js').EmbeddingsConfig,
        {
          topK: 8,
          minSimilarity: 0.25,
          field1: window.chatId, // strict chatId scope — never mix chats
        },
      );
      if (hits.length > 0) {
        memoryContext = hits
          .map((h) => `[${h.chunk.sourceRef.split(':')[0]}] ${h.chunk.content.slice(0, 300)}`)
          .join('\n');
      }
    } catch {
      /* fall through to FTS5 */
    }
  }

  // FTS5 fallback — scoped to same chatId/partner
  const ftsMemories = memorySearch({
    query: result.summary,
    chatId: window.chatId,
    partnerName: window.partnerName,
    limit: 5,
  });
  if (ftsMemories.length > 0) {
    const ftsCtx = ftsMemories
      .map((m) => `[${new Date(m.createdAt).toLocaleDateString()}] ${m.content}`)
      .join('\n');
    memoryContext = memoryContext ? `${memoryContext}\n---\n${ftsCtx}` : ftsCtx;
  }

  // ─── Provider-agnostic tool use loop ─────────────────────────────────────────
  // Works with any provider that supports tool use: Anthropic, OpenAI, Groq,
  // Ollama (with function-calling models like Qwen 2.5, Llama 3.3), etc.
  // Respects privacy.roles.plan — routes to local model if configured.
  const primaryLlm = llmConfigFromConfig(config);
  const privacyLlm = buildPrivacyLlmConfig(config);
  const llmCfg = llmForRole('plan', primaryLlm, privacyLlm, config);

  const systemPrompt = buildSystemPrompt('planner', config);
  const userPrompt = buildUserPrompt(window, result, memoryContext);

  // Skill tools + proposal tools. MCP excluded — too many tokens per call.
  type ToolDef = { name: string; description: string; input_schema: unknown };
  const skillTools = getSkillToolDefinitions(config.skills) as ToolDef[];
  const walletTools: ToolDef[] = config.wallet?.enabled
    ? [PROPOSE_TX_TOOL as unknown as ToolDef]
    : [];
  const linearTools: ToolDef[] = config.linear?.apiKey
    ? (LINEAR_TOOLS as unknown as ToolDef[])
    : [];
  const shellTools: ToolDef[] = (config as unknown as { shellExec?: { enabled?: boolean } })
    .shellExec?.enabled
    ? (SHELL_EXEC_TOOL as unknown as ToolDef[])
    : [];
  const allTools: ToolDef[] = [
    ...(TOOLS as unknown as ToolDef[]),
    ...walletTools,
    ...linearTools,
    ...shellTools,
    ...skillTools,
  ];

  let planText = '';
  const actions: ProposedAction[] = [];
  let draftReply: string | undefined;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // For Anthropic only: extended thinking (OpenAI providers ignore this)
  const useThinking = llmCfg.provider === 'anthropic' && (config.llm?.thinking?.planner ?? false);
  const effectiveCfg = useThinking
    ? { ...llmCfg, temperature: undefined, thinking: { enabled: true, budgetTokens: 1024 } }
    : { ...llmCfg, temperature: llmCfg.temperature ?? config.claude.planningTemperature };

  // Build multimodal user content if any message in the window carries image data
  const imgMsg = window.messages.find((m) => m.imageData);
  const userContent: LLMContentBlock[] | string = imgMsg?.imageData
    ? [
        { type: 'text' as const, text: userPrompt },
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: imgMsg.imageMimeType ?? 'image/jpeg',
            data: imgMsg.imageData,
          },
        },
      ]
    : userPrompt;

  const messages: unknown[] = [{ role: 'user', content: userContent }];

  let iterations = 0;
  const MAX_ITERATIONS = 5;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const step = await callWithTools(effectiveCfg, systemPrompt, messages, allTools);
    totalInputTokens += step.inputTokens;
    totalOutputTokens += step.outputTokens;

    if (step.text) planText += (planText ? '\n' : '') + step.text;

    const feedbacks: Array<{ id: string; content: string }> = [];

    for (const call of step.toolCalls) {
      // Skill — execute immediately
      if (skillTools.some((t) => t.name === call.name)) {
        log.debug(`Executing skill: ${call.name}`, call.input);
        const skillResult = await executeSkill(call.name, call.input, config.skills);
        feedbacks.push({ id: call.id, content: skillResult.output });
        continue;
      }

      // Proposal — queue for approval
      const action = toolCallToAction(call.name, call.input);
      actions.push(action);
      log.debug(`Tool proposed: ${call.name}`, call.input);
      if (call.name === 'draft_reply') draftReply = (call.input as { content?: string }).content;
      feedbacks.push({ id: call.id, content: JSON.stringify({ status: 'queued_for_approval' }) });
    }

    if (step.done) break;

    messages.push(...buildToolResultMessages(effectiveCfg, step._rawAssistant, feedbacks));
  }

  log.info(
    `Planner tokens: ${totalInputTokens}in / ${totalOutputTokens}out (${iterations} iteration${iterations > 1 ? 's' : ''})`,
  );

  if (actions.length === 0 && !planText) {
    log.info(`Planner produced no actions for window ${window.id}`);
    return null;
  }

  // ─── Persist proposal ──────────────────────────────────────────────────────
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

  // Merge anon lookups from all messages in the window so workers can de-anonymize at execution time.
  // Never sent to any LLM — resolved locally only.
  const db = getDb();
  const mergedLookup: Record<string, string> = {};
  const messageIds = window.messages.map((m) => m.id);
  if (messageIds.length > 0) {
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT anon_lookup FROM messages WHERE id IN (${placeholders}) AND anon_lookup IS NOT NULL`,
      )
      .all(...messageIds) as Array<{ anon_lookup: string }>;
    for (const row of rows) {
      try {
        Object.assign(mergedLookup, JSON.parse(row.anon_lookup) as Record<string, string>);
      } catch {
        /* skip malformed */
      }
    }
  }

  db.prepare(
    `
    INSERT INTO proposals (id, context_summary, plan, actions, draft_reply, status, created_at, expires_at, anon_lookup)
    VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)
  `,
  ).run(
    proposal.id,
    proposal.contextSummary,
    proposal.plan,
    JSON.stringify(proposal.actions),
    proposal.draftReply ?? null,
    proposal.createdAt,
    proposal.expiresAt,
    Object.keys(mergedLookup).length > 0 ? JSON.stringify(mergedLookup) : null,
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
