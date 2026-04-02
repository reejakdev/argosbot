/**
 * User-defined agents — programmable sub-agents registered from config.
 *
 * Each agent in config.agents is registered as a skill (callable by the planner)
 * and can optionally be linked to specific communication channels.
 *
 * Interaction modes:
 *   1. Planner tool   — planner calls the agent's name as a tool during planning
 *   2. Web app        — POST /api/agents/:name { input }
 *   3. Channel link   — messages from linkedChannels route directly to this agent
 *
 * Per-agent model: each agent can use a different LLM provider + model.
 *   provider: "anthropic" | "openai" | "ollama" | any key in config.llm.providers
 *   model:    "claude-opus-4-6" | "gpt-4o" | "llama3:8b" | …
 *
 * Workspace isolation: memories stored/searched by the agent are scoped to
 *   its own namespace (tag: agent:<name>). Set isolatedWorkspace: false to
 *   share the global pool.
 */

import { createLogger } from '../logger.js';
import type { Config } from '../config/schema.js';
import type { SkillResult } from '../skills/registry.js';
import type { LLMConfig, AuthMode } from '../llm/index.js';

const log = createLogger('agents');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentDefinition {
  name:              string;
  description:       string;
  systemPrompt:      string;
  tools:             string[];
  linkedChannels?:   string[];
  maxIterations:     number;
  temperature:       number;
  maxTokens:         number;
  enabled:           boolean;
  provider?:         string;
  model?:            string;
  isolatedWorkspace: boolean;
}

// ─── Channel routing index ────────────────────────────────────────────────────

const _channelIndex = new Map<string, string>();

export function getAgentForChannel(channelType: string, chatId: string): string | undefined {
  return _channelIndex.get(`${channelType}:${chatId}`);
}

// ─── Per-agent LLM config ─────────────────────────────────────────────────────

function buildAgentLlmConfig(def: AgentDefinition, config: Config): LLMConfig {
  const { llmConfigFromConfig } = require('../llm/index.js') as typeof import('../llm/index.js');
  const base = llmConfigFromConfig(config);

  // No override — use global config
  if (!def.provider && !def.model) {
    return { ...base, temperature: def.temperature, maxTokens: def.maxTokens };
  }

  const providerKey = def.provider ?? config.llm.activeProvider;
  const model       = def.model ?? config.llm.activeModel;
  const providerDef = config.llm.providers[providerKey];

  if (!providerDef) {
    log.warn(`Agent "${def.name}": provider "${providerKey}" not found — using global config`);
    return { ...base, temperature: def.temperature, maxTokens: def.maxTokens };
  }

  const provider  = providerDef.api === 'anthropic' ? 'anthropic' as const : 'compatible' as const;
  const authMode  = (providerDef.auth as AuthMode) ?? 'api-key';

  return {
    provider,
    model,
    apiKey:      providerDef.apiKey ?? '',
    authMode,
    baseUrl:     providerDef.baseUrl,
    temperature: def.temperature,
    maxTokens:   def.maxTokens,
  };
}

// ─── Workspace-aware tool executor ───────────────────────────────────────────
// Intercepts memory_store / memory_search calls to scope them to the agent namespace.

async function executeWithWorkspace(
  toolName: string,
  toolInput: Record<string, unknown>,
  def: AgentDefinition,
  builtinNames: Set<string>,
  skillNames: Set<string>,
  config: Config,
): Promise<string> {
  const { executeBuiltinTool } = await import('../llm/builtin-tools.js');
  const { executeSkill }       = await import('../skills/registry.js');

  let input = toolInput;

  if (def.isolatedWorkspace) {
    // memory_store — auto-tag with agent namespace
    if (toolName === 'memory_store') {
      const existingTags = (input.tags as string[] | undefined) ?? [];
      input = {
        ...input,
        tags: [...new Set([...existingTags, `agent:${def.name}`])],
      };
    }

    // memory_search / semantic_search — inject namespace filter into query
    if (toolName === 'memory_search' || toolName === 'semantic_search') {
      const q = String(input.query ?? input.q ?? '');
      input = {
        ...input,
        query: q,
        // Pass agent tag as filter hint — builtin tools pick this up if supported
        agentNamespace: def.name,
      };
    }
  }

  if (builtinNames.has(toolName)) {
    const r = await executeBuiltinTool(toolName, input);
    return r.output;
  }
  if (skillNames.has(toolName)) {
    const r = await executeSkill(toolName, input, config.skills);
    return r.output;
  }
  return `Unknown tool: ${toolName}`;
}

// ─── Tool resolution ──────────────────────────────────────────────────────────

type ToolDef = { name: string; description: string; input_schema: unknown };

async function resolveTools(toolNames: string[], config: Config): Promise<ToolDef[]> {
  const { BUILTIN_TOOLS } = await import('../llm/builtin-tools.js');
  const { getEnabledSkills } = await import('../skills/registry.js');

  const builtinMap = new Map(BUILTIN_TOOLS.map(t => [t.name, t as ToolDef]));
  const skillMap   = new Map(
    getEnabledSkills(config.skills).map(s => [s.name, s.tool as ToolDef]),
  );

  if (toolNames.includes('*')) return BUILTIN_TOOLS as ToolDef[];

  const resolved: ToolDef[] = [];
  for (const name of toolNames) {
    const tool = builtinMap.get(name) ?? skillMap.get(name);
    if (tool) resolved.push(tool);
    else log.warn(`Agent tool "${name}" not found — skipped`);
  }
  return resolved;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runAgent(
  def: AgentDefinition,
  input: string,
  config: Config,
): Promise<SkillResult> {
  const { callWithTools, buildToolResultMessages } = await import('../llm/index.js');
  const { BUILTIN_TOOLS }       = await import('../llm/builtin-tools.js');
  const { getEnabledSkills }    = await import('../skills/registry.js');

  const llmCfg = buildAgentLlmConfig(def, config);
  const tools  = await resolveTools(def.tools, config);

  const builtinNames = new Set(BUILTIN_TOOLS.map(t => t.name));
  const skillNames   = new Set(getEnabledSkills(config.skills).map(s => s.name));

  // System prompt + workspace context injected automatically
  const systemPrompt = def.isolatedWorkspace
    ? `${def.systemPrompt}\n\n---\nWorkspace: you are operating in your private namespace "agent:${def.name}". When storing memories, always include the tag "agent:${def.name}". When searching, prefer results tagged "agent:${def.name}" unless the user explicitly asks for global context.`
    : def.systemPrompt;

  const messages: unknown[] = [{ role: 'user', content: input }];

  let output     = '';
  let iterations = 0;

  while (iterations < def.maxIterations) {
    iterations++;
    const step = await callWithTools(llmCfg, systemPrompt, messages, tools);

    if (step.text) output = step.text;
    if (step.done || step.toolCalls.length === 0) break;

    const feedbacks: Array<{ id: string; content: string }> = [];

    for (const call of step.toolCalls) {
      log.debug(`Agent "${def.name}" [${providerLabel(def, config)}] tool: ${call.name}`);
      const result = await executeWithWorkspace(
        call.name, call.input as Record<string, unknown>, def, builtinNames, skillNames, config,
      );
      feedbacks.push({ id: call.id, content: result });
    }

    messages.push(...buildToolResultMessages(llmCfg, step._rawAssistant, feedbacks));
  }

  if (!output) return { success: false, output: `Agent "${def.name}" returned no output.` };

  log.info(`Agent "${def.name}" [${providerLabel(def, config)}] done in ${iterations} iteration(s)`);
  return { success: true, output };
}

function providerLabel(def: AgentDefinition, config: Config): string {
  const p = def.provider ?? config.llm.activeProvider;
  const m = def.model    ?? config.llm.activeModel;
  return `${p}/${m}`;
}

// ─── Trigger evaluation ───────────────────────────────────────────────────────

interface TriggerCondition {
  keywords?:     string[];
  categories?:   string[];
  channels?:     string[];
  minImportance?: number;
}

function matchesTrigger(
  condition: TriggerCondition,
  text: string,
  channel: string,
  category?: string,
  importance?: number,
): boolean {
  // keywords — any match (OR)
  if (condition.keywords?.length) {
    const lower = text.toLowerCase();
    if (!condition.keywords.some(k => lower.includes(k.toLowerCase()))) return false;
  }
  // categories — any match (OR)
  if (condition.categories?.length) {
    if (!category || !condition.categories.includes(category)) return false;
  }
  // channels — any match (OR)
  if (condition.channels?.length) {
    if (!condition.channels.includes(channel)) return false;
  }
  // minImportance
  if (condition.minImportance && (importance ?? 0) < condition.minImportance) return false;

  return true;
}

/**
 * Evaluate all agent triggers against a message.
 * Returns a list of agent definitions whose triggers matched.
 * Multiple trigger objects per agent are ORed.
 */
export function getTriggeredAgents(
  config: Config,
  text: string,
  channel: string,
  category?: string,
  importance?: number,
): AgentDefinition[] {
  const triggered: AgentDefinition[] = [];

  for (const agent of config.agents ?? []) {
    if (agent.enabled === false) continue;
    const triggers = agent.triggers ?? [];
    if (!triggers.length) continue;

    const matched = triggers.some(t =>
      matchesTrigger(t, text, channel, category, importance),
    );

    if (matched) triggered.push(agent as AgentDefinition);
  }

  return triggered;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loadUserAgents(config: Config): Promise<void> {
  const agents = (config.agents ?? []).filter(a => a.enabled !== false);
  if (!agents.length) { log.debug('No user agents configured'); return; }

  const { registerSkill } = await import('../skills/registry.js');

  for (const agent of agents) {
    const def = agent as AgentDefinition;

    registerSkill({
      name:        def.name,
      description: def.description,
      tool: {
        name:        def.name,
        description: def.description,
        input_schema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Task, question, or context to pass to this agent' },
          },
          required: ['input'],
        },
      },
      handler: async (skillInput) => runAgent(def, String(skillInput.input ?? ''), config),
    });

    const alreadyInSkills = config.skills.some(s => s.name === def.name);
    if (!alreadyInSkills) config.skills.push({ name: def.name, enabled: true, config: {} });

    for (const channelRef of def.linkedChannels ?? []) {
      _channelIndex.set(channelRef, def.name);
    }

    const provLabel = def.provider ? `${def.provider}/${def.model ?? 'default'}` : 'global';
    log.info(`Agent "${def.name}" registered — model: ${provLabel}, workspace: ${def.isolatedWorkspace ? 'isolated' : 'shared'}`);
  }

  log.info(`${agents.length} user agent(s) loaded`);
}
