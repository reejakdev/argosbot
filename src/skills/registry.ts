/**
 * Skills registry — internal tools Argos can use in the planner.
 *
 * A skill is:
 *   - A tool definition (name, description, input_schema) → given to Claude
 *   - A handler function → called when Claude invokes the tool
 *   - An optional config (API keys, options)
 *
 * Skills are enabled per-user in config.json:
 * {
 *   "skills": [
 *     { "name": "web_search",   "enabled": true, "config": { "engine": "brave" } },
 *     { "name": "crypto_price", "enabled": true },
 *     { "name": "fetch_url",    "enabled": true }
 *   ]
 * }
 *
 * Built-in skills:
 *   web_search     — search the web (DuckDuckGo instant or Brave API)
 *   crypto_price   — get token price from CoinGecko (free, no key)
 *   fetch_url      — fetch and extract text from any URL
 *   notion_search  — search Notion workspace (requires NOTION_API_KEY)
 *   memory_search  — explicit semantic search in Argos memory
 *   calendar_check — check calendar availability
 */

import { createLogger } from '../logger.js';
import type { SkillConfig } from '../config/schema.js';

const log = createLogger('skills');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

export interface SkillResult {
  success: boolean;
  output: string;
  data?: unknown;
}

export interface Skill {
  name: string;
  description: string;
  tool: ToolDefinition;
  handler: (input: Record<string, unknown>, cfg: Record<string, unknown>) => Promise<SkillResult>;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const _registry = new Map<string, Skill>();

export function registerSkill(skill: Skill): void {
  _registry.set(skill.name, skill);
  log.debug(`Skill registered: ${skill.name}`);
}

export function getEnabledSkills(configs: SkillConfig[]): Skill[] {
  return configs
    .filter((c) => c.enabled !== false)
    .map((c) => _registry.get(c.name))
    .filter((s): s is Skill => !!s);
}

export function getSkillToolDefinitions(configs: SkillConfig[]): ToolDefinition[] {
  return getEnabledSkills(configs).map((s) => s.tool);
}

export async function executeSkill(
  name: string,
  input: Record<string, unknown>,
  configs: SkillConfig[],
): Promise<SkillResult> {
  const skill = _registry.get(name);
  if (!skill) return { success: false, output: `Unknown skill: ${name}` };

  const cfg = configs.find((c) => c.name === name)?.config ?? {};
  try {
    return await skill.handler(input, cfg);
  } catch (e) {
    log.error(`Skill "${name}" failed`, e);
    return { success: false, output: String(e) };
  }
}

// ─── Load all built-in skills ─────────────────────────────────────────────────

export async function loadBuiltinSkills(): Promise<void> {
  const modules = [
    import('./builtins/web-search.js'),
    import('./builtins/crypto-price.js'),
    import('./builtins/fetch-url.js'),
    import('./builtins/notion-search.js'),
    import('./builtins/memory-search.js'),
    import('./builtins/verify-address.js'),
    import('./builtins/graph-search.js'),
  ];

  const results = await Promise.allSettled(modules);
  for (const r of results) {
    if (r.status === 'rejected') {
      log.warn(`Skill module failed to load: ${r.reason}`);
    }
  }

  log.info(`${_registry.size} built-in skill(s) loaded`);
}

// ─── Skill catalog (for setup wizard display) ─────────────────────────────────

export const SKILL_CATALOG: Array<{
  name: string;
  description: string;
  requiresEnv?: string[];
  requiresConfig?: string[];
}> = [
  {
    name: 'web_search',
    description: 'Search the web — DuckDuckGo (free, no key) or Brave Search API',
    requiresConfig: ['engine: "duckduckgo" | "brave"'],
  },
  {
    name: 'crypto_price',
    description: 'Get token prices from CoinGecko — free, no API key needed',
  },
  {
    name: 'fetch_url',
    description: 'Fetch and extract text content from any public URL',
  },
  {
    name: 'notion_search',
    description: 'Search your Notion workspace',
    requiresEnv: ['NOTION_API_KEY', 'NOTION_AGENT_DATABASE_ID'],
  },
  {
    name: 'memory_search',
    description: 'Explicitly search Argos memory (FTS) for past context',
  },
  {
    name: 'verify_protocol_address',
    description:
      'Verify a partner-provided crypto address against official protocol documentation — DOCS FIRST, returns APPROVE / MANUAL REVIEW / REJECT with score',
  },
  {
    name: 'graph_search',
    description:
      'Search the knowledge graph for everything known about a person, company, or entity. Returns related entities and relationships.',
  },
];
