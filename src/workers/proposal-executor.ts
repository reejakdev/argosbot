/**
 * Proposal executor — executes approved proposals.
 *
 * When a proposal is approved:
 * 1. write_file → write directly
 * 2. Other actions → build a prompt from the action details and run an LLM agent
 *    with tools (Notion API, web search, etc.) to execute the plan
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../logger.js';
import { getDb } from '../db/index.js';
import { validateAndConsumeToken } from '../gateway/approval.js';
import type { LLMConfig } from '../llm/index.js';

const log = createLogger('executor');

function getDataDir(): string {
  const dir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
  return dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : dir;
}

export interface ExecutionResult {
  success: boolean;
  results: string[];
  errors: string[];
}

/**
 * Execute all actions in an approved proposal.
 */
export async function executeApprovedProposal(
  proposalId: string,
  llmConfig: LLMConfig,
  notifyUser: (text: string) => Promise<void>,
  executionToken: string,
): Promise<ExecutionResult> {
  // ── SECURITY GATE ─────────────────────────────────────────────────────────
  // Layer 2: validate ephemeral token — independent of DB status check.
  if (!validateAndConsumeToken(proposalId, executionToken)) {
    log.error(`SECURITY: Execution of proposal ${proposalId} blocked — invalid or missing token`);
    await notifyUser(
      `🚫 *Execution blocked* — proposal \`${proposalId.slice(-8)}\` rejected by security gate.\nThe approval token was invalid, expired, or already used.`
    ).catch(() => {});
    return { success: false, results: [], errors: ['Blocked: invalid execution token'] };
  }
  // ──────────────────────────────────────────────────────────────────────────

  const db = getDb();
  const proposal = db.prepare(
    "SELECT id, plan, actions, context_summary FROM proposals WHERE id = ?"
  ).get(proposalId) as { id: string; plan: string; actions: string; context_summary: string } | undefined;

  if (!proposal) {
    return { success: false, results: [], errors: ['Proposal not found'] };
  }

  const actions = JSON.parse(proposal.actions) as Array<Record<string, unknown>>;
  const results: string[] = [];
  const errors: string[] = [];

  for (const action of actions) {
    const tool = (action.tool ?? action.action) as string;
    const details = (action.details ?? '') as string;
    const input = (action.input ?? {}) as Record<string, unknown>;

    log.info(`Executing action: ${tool}`, { proposalId });

    try {
      switch (tool) {
        case 'write_file': {
          const relPath = input.path as string;
          const content = input.content as string;
          const normalized = path.normalize(relPath);
          if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
            errors.push(`Security: path traversal blocked for ${relPath}`);
            break;
          }
          const fullPath = path.join(getDataDir(), normalized);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, content, 'utf8');
          results.push(`✅ File written: ${relPath}`);
          log.info(`File written: ${fullPath}`);
          break;
        }

        case 'Create Notion database':
        case 'Create Notion page':
        case 'notion': {
          const result = await executeWithAgent(
            `Execute this Notion action:\n${details}\n\nUse the available tools to complete this task.`,
            llmConfig,
          );
          results.push(`✅ Notion: ${result}`);
          break;
        }

        case 'draft_reply': {
          // Route through workers/index.ts which has _sendDirectMessage bound
          const { sendDirectReply } = await import('./index.js');
          const { loadConfig } = await import('../config/index.js');
          const cfg = loadConfig();
          const r = await sendDirectReply(
            String(input.to ?? ''),
            String(input.chatId ?? input.to ?? ''),
            String(input.content ?? ''),
            cfg,
          );
          results.push(r.success ? `✅ ${r.output}` : `❌ ${r.output}`);
          if (r.dryRun) log.warn('draft_reply: dryRun=true — MTProto not ready or readOnly');
          break;
        }

        default: {
          // Generic action — use LLM agent to figure out how to execute
          const result = await executeWithAgent(
            `Execute this action: ${tool}\nDetails: ${details}\n\nContext: ${proposal.context_summary}`,
            llmConfig,
          );
          results.push(`✅ ${tool}: ${result}`);
          break;
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      errors.push(`❌ ${tool}: ${errMsg}`);
      log.error(`Action failed: ${tool}`, { error: errMsg, proposalId });
    }
  }

  // Update proposal status
  const finalStatus = errors.length === 0 ? 'executed' : 'partial';
  db.prepare("UPDATE proposals SET status = ?, executed_at = ? WHERE id = ?")
    .run(finalStatus, Date.now(), proposalId);

  // Notify user
  const summary = [
    `📋 Proposal executed: ${proposal.plan}`,
    '',
    ...results,
    ...errors,
  ].join('\n');

  await notifyUser(summary).catch(() => {});

  return { success: errors.length === 0, results, errors };
}

/**
 * Use an LLM agent with tools to execute a complex action.
 */
async function executeWithAgent(prompt: string, llmConfig: LLMConfig): Promise<string> {
  const { runToolLoop } = await import('../llm/tool-loop.js');
  const { callAnthropicBearerRaw } = await import('../llm/index.js');
  const { BUILTIN_TOOLS, executeBuiltinTool } = await import('../llm/builtin-tools.js');
  const { getMcpTools, executeMcpTool } = await import('../mcp/client.js');

  const tools = [...BUILTIN_TOOLS, ...getMcpTools()];

  // Executor: approved actions execute DIRECTLY — no more proposals!
  const executor = async (name: string, input: Record<string, unknown>) => {
    // write_file — execute directly (already approved)
    if (name === 'write_file') {
      const relPath = path.normalize(input.path as string);
      if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
        return { output: 'Security: path traversal blocked', error: true };
      }
      const fullPath = path.join(getDataDir(), relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, input.content as string, 'utf8');
      return { output: `File written: ${relPath}` };
    }

    // create_proposal — BLOCK in executor (prevents infinite proposal loop)
    if (name === 'create_proposal') {
      return { output: 'Already executing an approved proposal — no need to create another one. Use the available tools directly.', error: true };
    }

    // MCP tools — execute directly (all Notion etc. goes through MCP)
    if (name.startsWith('mcp_')) {
      return executeMcpTool(name, input);
    }

    // All other builtin tools (search, memory, etc.)
    return executeBuiltinTool(name, input);
  };

  const messages = [
    { role: 'system' as const, content: 'You are an execution agent. Complete the requested action using available tools. Be precise and report what you did.' },
    { role: 'user' as const, content: prompt },
  ];

  const response = await runToolLoop(llmConfig, messages[0].content, messages, tools, executor, callAnthropicBearerRaw);
  return response.content || 'Action completed (no output)';
}
