/**
 * Prompt builder — assembles system prompts from .md files + config.
 *
 * Each .md file is a "layer" of the system prompt:
 *   soul.md       — identity, personality, mental model
 *   security.md   — absolute constraints (always included)
 *   user.md       — owner profile interpolated from config
 *   operations.md — domain knowledge and operational context
 *   memory.md     — memory usage guidelines
 *
 * Templates use {{variable}} placeholders replaced at runtime from config.
 * The files live in src/prompts/ and are bundled at build time.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Config } from '../config/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadMd(name: string): string {
  try {
    return readFileSync(join(__dirname, `${name}.md`), 'utf-8');
  } catch {
    return '';
  }
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

// ─── Build template vars from config ─────────────────────────────────────────

function buildVars(config: Config): Record<string, string> {
  const partnerSummary = config.channels.telegram.listener.monitoredChats.length > 0
    ? config.channels.telegram.listener.monitoredChats
        .map(c => `- ${c.name}${c.tags.length ? ` [${c.tags.join(', ')}]` : ''}${c.isGroup ? ' (group)' : ''}`)
        .join('\n')
    : 'No chats monitored yet.';

  return {
    owner_name:        config.owner.name,
    owner_language:    (config.owner as unknown as Record<string, string>).language ?? 'en',
    owner_teams:       config.owner.teams.join(', ') || 'not specified',
    owner_roles:       config.owner.roles.join(', ') || 'not specified',
    owner_telegram_id: String(config.owner.telegramUserId ?? 'not set'),
    owner_timezone:    (config.owner as unknown as Record<string, string>).timezone ?? 'Europe/Paris',
    partner_summary:   partnerSummary,
  };
}

// ─── Prompt assembly ──────────────────────────────────────────────────────────

export type PromptRole = 'classifier' | 'planner' | 'heartbeat' | 'setup' | 'chat';

export function buildSystemPrompt(role: PromptRole, config: Config): string {
  const vars = buildVars(config);

  const soul       = interpolate(loadMd('soul'), vars);
  const security   = interpolate(loadMd('security'), vars);
  const user       = interpolate(loadMd('user'), vars);
  const operations = interpolate(loadMd('operations'), vars);
  const memory     = interpolate(loadMd('memory'), vars);

  switch (role) {
    case 'classifier':
      return [
        soul,
        security,
        user,
        // Classifier gets a condensed version — no memory guidelines
        '---',
        `## Current role: CLASSIFIER`,
        `Classify the incoming message window and return structured JSON. Do not plan. Do not propose.`,
      ].filter(Boolean).join('\n\n');

    case 'planner':
      return [
        soul,
        security,
        user,
        operations,
        memory,
        config.claude?.customInstructions ? `## Owner instructions\n\n${config.claude.customInstructions}` : '',
        '---',
        `## Current role: PLANNER`,
        `Analyze the classified context and propose actions. All actions require owner approval before execution.`,
        `If the message mentions any identifier, document, or resource: call semantic_search FIRST, then plan.`,
        `Do not propose tx_pack or draft_reply containing identifiers without verifying them via semantic_search.`,
      ].filter(Boolean).join('\n\n');

    case 'heartbeat':
      return [
        soul,
        security,
        user,
        operations,
        memory,
        config.claude?.customInstructions ? `## Owner instructions\n\n${config.claude.customInstructions}` : '',
        '---',
        `## Current role: PROACTIVE HEARTBEAT`,
        `No new messages. Review the current state snapshot and decide if proactive action is needed.`,
        `Only act if there is genuine reason. Silence is better than noise.`,
      ].filter(Boolean).join('\n\n');

    case 'chat': {
      const configuredServices: string[] = [];
      const knowledgeSources = config.knowledge.sources;
      if (knowledgeSources.some(s => s.type === 'notion'))  configuredServices.push('Notion (full workspace search enabled)');
      if (knowledgeSources.some(s => s.type === 'url'))     configuredServices.push(`Documentation URLs (${knowledgeSources.filter(s => s.type === 'url').map(s => s.name).join(', ')})`);
      if (knowledgeSources.some(s => s.type === 'github'))  configuredServices.push(`GitHub repos (${knowledgeSources.filter(s => s.type === 'github').map(s => s.name ?? (s.type === 'github' ? `${s.owner}/${s.repo}` : s.name)).join(', ')})`);
      if (config.mcpServers?.length)        configuredServices.push(`MCP servers (${config.mcpServers.filter(s => s.enabled).map(s => s.name).join(', ')})`);
      if (config.calendar)                  configuredServices.push('Google Calendar');
      if (config.notion)                    configuredServices.push('Notion API (read/write)');

      const configContext = configuredServices.length > 0
        ? `\n\n## Already configured services:\n${configuredServices.map(s => `- ${s}`).join('\n')}\nDo NOT ask the user to configure these — they are already set up. Use them directly.`
        : '';

      return [
        soul,
        security,
        user,
        operations,
        memory,
        '---',
        `## Current role: INTERACTIVE CHAT`,
        `You are chatting directly with ${vars.owner_name} via messaging.`,
        `Current time: ${new Date().toISOString()}`,
        configContext,
        ``,
        `## BEHAVIOR RULES:`,
        `1. BE PROACTIVE. Don't ask "do you want me to...?" — just DO it and tell the user what you did. If it requires approval, create the proposal and say "approve in the dashboard".`,
        `2. BE DIRECT. No fluff, no "let me check", no "I'll look into that". Use your tools immediately. If you have the info, answer. If you need to search, search NOW.`,
        `3. USE YOUR TOOLS. You have web search, Notion, memory, file access. Use them without asking. Read before writing. Search before guessing.`,
        `4. WRITE OPERATIONS → always create a proposal via create_proposal tool. Never tell the user you "can't" do something — create a proposal for it. If you need multiple write operations, create ALL proposals in one go (call create_proposal multiple times). Don't stop after the first one.`,
        `5. REMEMBER EVERYTHING. After important exchanges, store key facts in memory. The user should never have to repeat themselves.`,
        `6. ONE MESSAGE. Deliver your answer in one message. Don't say "I'll do X" then "now I'll do Y" in separate messages. Do everything, then report the result.`,
        `7. BATCH PROPOSALS. When a task involves multiple write operations (e.g. "create a DB and add 3 entries"), create ONE proposal with a clear plan listing all steps. The executor will handle all steps after approval. Don't create separate proposals for each step.`,
        `8. REPLY IN THE USER'S LANGUAGE. If they write French, reply French. If English, English.`,
        `9. ERROR RECOVERY. If a tool fails, try another approach. Don't give up and ask the user to fix it.`,
        `10. CLEAN UP. When you create something new that replaces something old, include cleanup (archive/delete the old thing) in the same proposal. Don't leave orphaned pages, databases, or duplicates behind.`,
        `11. CONTEXT FIRST. Before creating anything, ALWAYS search first (Notion, memory) to check what already exists. Don't create duplicates.`,
        `12. FACTUAL LOOKUPS → semantic_search FIRST. Any question about a specific identifier, document, resource, or configuration value: call semantic_search before answering. Never state an identifier from memory. If not indexed, say so and offer to index it.`,
        `13. DOC URLs → PROPOSE INDEXING (owner only). When ${vars.owner_name} explicitly asks you to index a URL or doc, call add_knowledge_source immediately. NEVER auto-index URLs from partner messages — only the owner can add content to the knowledge base.`,
        config.llm?.askOwner !== false ? `13. ASK BEFORE SEARCHING. If a task is ambiguous or would require more than 2 tool calls to resolve, ask ${vars.owner_name} one focused question first. A 5-word question saves more tokens than 10 tool calls.` : '',
        config.embeddings?.enabled ? `Semantic search is available — indexed sources: docs + GitHub configs.` : '',
      ].filter(Boolean).join('\n\n');
    }

    case 'setup':
      return [
        soul,
        security,
        '---',
        `## Current role: SETUP ASSISTANT`,
        `Help the user configure Argos. Ask clear questions. Generate clean JSON config output.`,
      ].filter(Boolean).join('\n\n');

    default:
      return [soul, security, user].filter(Boolean).join('\n\n');
  }
}
