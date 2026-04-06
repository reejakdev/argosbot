/**
 * Multi-agent orchestrator — spawns N sub-agents in parallel, each with their
 * own context, tool subset, and system prompt.  Results collected via
 * Promise.allSettled so one failing agent never kills the rest.
 *
 * Depth limit: sub-agents cannot spawn more agents (enforced in builtin-tools.ts).
 */

import { monotonicFactory } from 'ulid';
import { createLogger } from '../logger.js';
import type { LLMConfig } from '../llm/index.js';
import type { Config } from '../config/schema.js';

const log = createLogger('orchestrator');
const ulid = monotonicFactory();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentTask {
  name: string; // label for this sub-agent
  systemPrompt: string; // the sub-agent's role/goal
  tools: string[]; // subset of tool names this sub-agent can use
  input: string; // the task description
  maxIterations?: number; // default 4
}

export interface AgentTaskResult {
  name: string;
  output: string;
  success: boolean;
  error?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_AGENTS = 5;
const TIMEOUT_MS = 90_000; // 90 s total — individual timeout = TIMEOUT_MS / MAX_AGENTS

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runOrchestrated(
  tasks: AgentTask[],
  config: Config,
  llmConfig: LLMConfig,
): Promise<AgentTaskResult[]> {
  const capped = tasks.slice(0, MAX_AGENTS);
  log.info(`Spawning ${capped.length} sub-agent(s) in parallel`);

  // Per-agent timeout scales with actual number of agents (not MAX_AGENTS)
  const perAgentTimeoutMs = Math.floor(TIMEOUT_MS / Math.max(capped.length, 1));

  const settled = await Promise.allSettled(
    capped.map((task) => runSubAgent(task, config, llmConfig, perAgentTimeoutMs)),
  );

  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
    log.warn(`Sub-agent "${capped[i].name}" failed: ${err}`);
    return { name: capped[i].name, output: '', success: false, error: err };
  });
}

// ─── Sub-agent runner ─────────────────────────────────────────────────────────

async function runSubAgent(
  task: AgentTask,
  config: Config,
  llmConfig: LLMConfig,
  timeoutMs?: number,
): Promise<AgentTaskResult> {
  // Use a unique run ID so log lines from concurrent agents are distinguishable
  const runId = ulid().slice(-6);
  log.debug(
    `[${runId}] Sub-agent "${task.name}" starting — tools: ${task.tools.join(', ') || 'all'}`,
  );

  const { callWithTools, buildToolResultMessages } = await import('../llm/index.js');
  const { getSkillToolDefinitions, executeSkill } = await import('../skills/registry.js');
  const { BUILTIN_TOOLS, executeBuiltinTool } = await import('../llm/builtin-tools.js');

  const maxIter = Math.min(task.maxIterations ?? 4, 6);

  // ── Tool resolution ───────────────────────────────────────────────────────
  // Sub-agents work on builtin tools + skill tools, filtered to the requested subset.
  // spawn_agent is intentionally excluded (depth limit = 1).
  const allTools = [
    ...BUILTIN_TOOLS.filter((t) => t.name !== 'spawn_agent'),
    ...getSkillToolDefinitions(config.skills),
  ];
  const allowedTools =
    task.tools.length > 0 ? allTools.filter((t) => task.tools.includes(t.name)) : allTools;

  const builtinNames = new Set(BUILTIN_TOOLS.map((t) => t.name));

  // ── Conversation loop ─────────────────────────────────────────────────────
  const messages: unknown[] = [{ role: 'user', content: task.input }];
  let finalText = '';

  const runPromise = (async () => {
    for (let i = 0; i < maxIter; i++) {
      const step = await callWithTools(llmConfig, task.systemPrompt, messages, allowedTools);
      if (step.text) finalText += step.text;

      if (step.done || !step.toolCalls?.length) break;

      const feedbacks: Array<{ id: string; content: string }> = [];
      for (const tc of step.toolCalls) {
        let output: string;
        try {
          if (builtinNames.has(tc.name)) {
            const r = await executeBuiltinTool(tc.name, tc.input as Record<string, unknown>);
            output = r.output;
          } else {
            const r = await executeSkill(
              tc.name,
              tc.input as Record<string, unknown>,
              config.skills,
            );
            output = r.output ?? 'done';
          }
        } catch (e) {
          output = `Error: ${(e as Error).message}`;
        }
        feedbacks.push({ id: tc.id, content: output });
        log.debug(`[${runId}] "${task.name}" tool: ${tc.name} → ${output.slice(0, 80)}`);
      }

      messages.push(...buildToolResultMessages(llmConfig, step._rawAssistant, feedbacks));
    }

    return {
      name: task.name,
      output: finalText.trim() || '(no output)',
      success: true,
    };
  })();

  const resolvedTimeout = timeoutMs ?? Math.floor(TIMEOUT_MS / MAX_AGENTS);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Sub-agent "${task.name}" timed out after ${resolvedTimeout}ms`)),
      resolvedTimeout,
    ),
  );

  return Promise.race([runPromise, timeoutPromise]);
}
