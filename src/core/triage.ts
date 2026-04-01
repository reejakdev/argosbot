/**
 * Triage engine — smart inbox routing for partner messages.
 *
 * Runs on every inbound partner message BEFORE the context-window.
 * Does NOT block the normal pipeline — fires in parallel (non-blocking).
 *
 * Flow:
 *   1. Fast regex pre-screen (zero LLM cost)
 *      - @me mentioned?        → candidate my_task / my_reply
 *      - @team mentioned?      → candidate team_task
 *      - whitelist keywords?   → candidate tx_whitelist
 *      - Nothing matched       → skip entirely (100+ channels at scale)
 *
 *   2. LLM extraction (only when pre-screen matched)
 *      - privacy role  → local model, raw text (no anonymisation)
 *      - primary role  → cloud model, anonymised text
 *      - Output: { route, title, body, assignee?, urgency }
 *
 *   3. Sink
 *      - my_task / team_task → Notion todo + SQLite tasks row
 *      - my_reply            → draft reply proposal (approval gateway)
 *      - tx_whitelist        → tx review pack proposal
 *      - skip                → nothing
 */

import { createLogger } from '../logger.js';
import { audit } from '../db/index.js';
import type { RawMessage } from '../types.js';
import type { Config } from '../config/schema.js';
import type { LLMConfig } from '../llm/index.js';

const log = createLogger('triage');

// ─── Types ─────────────────────────────────────────────────────────────────────

export type TriageRoute =
  | 'my_task'      // tagged me, action needed → my Notion todo
  | 'my_reply'     // tagged me, reply needed  → draft reply proposal
  | 'team_task'    // tagged my team           → Notion todo + team tag
  | 'tx_whitelist' // whitelist address request → tx review pack
  | 'skip';        // nothing actionable

export interface TriageResult {
  route:     TriageRoute;
  title:     string;
  body:      string;
  assignee?: string;   // team name or 'me'
  urgency:   'low' | 'medium' | 'high';
  partner:   string;
  chatId:    string;
  channel:   string;   // source channel (telegram, whatsapp, email…)
  rawRef:    string;   // source message ID for traceability
}

// ─── Pre-screen ────────────────────────────────────────────────────────────────
// Cheap regex pass — returns candidate routes without any LLM call.

interface PreScreenResult {
  mentionsMe:       boolean;
  mentionedTeams:   string[];   // team names
  isWhitelistReq:   boolean;
  isExternal:       boolean;    // message from a monitored partner chat (always triage)
  isFromOwnTeam:    boolean;    // sender is a member of an internal team
}

function preScreen(text: string, config: Config, msg?: import('../types.js').RawMessage): PreScreenResult {
  const triage = config.triage;
  const lower  = text.toLowerCase();

  const mentionsMe = triage.myHandles.some((h: string) => {
    const needle = h.startsWith('@') ? h.toLowerCase() : `@${h.toLowerCase()}`;
    return lower.includes(needle) || lower.includes(h.toLowerCase());
  });

  const mentionedTeams = triage.watchedTeams
    .filter((team: { handles: string[]; keywords: string[] }) => {
      const handleMatch = team.handles.some((h: string) => {
        const withAt    = h.startsWith('@') ? h.toLowerCase() : `@${h.toLowerCase()}`;
        const withoutAt = h.startsWith('@') ? h.slice(1).toLowerCase() : h.toLowerCase();
        return lower.includes(withAt) || lower.includes(withoutAt);
      });
      const kwMatch = team.keywords.some((kw: string) => lower.includes(kw.toLowerCase()));
      return handleMatch || kwMatch;
    })
    .map((t: { name: string }) => t.name);

  const isWhitelistReq = triage.whitelistKeywords.some((kw: string) => lower.includes(kw.toLowerCase()));

  // Detect if sender is from own internal team (isOwnTeam flag)
  const senderId   = msg?.senderId ?? '';
  const senderName = (msg?.senderName ?? '').toLowerCase();
  const isFromOwnTeam = config.triage.watchedTeams
    .filter((t: { isOwnTeam?: boolean }) => t.isOwnTeam)
    .some((t: { handles: string[] }) =>
      t.handles.some((h: string) => {
        const needle = h.startsWith('@') ? h.slice(1).toLowerCase() : h.toLowerCase();
        return senderName.includes(needle) || senderId === needle;
      }),
    );

  // Any message from a monitored partner chat is a candidate — the LLM decides if it's actionable
  const isExternal = !!(msg?.partnerName) && !isFromOwnTeam;

  return { mentionsMe, mentionedTeams, isWhitelistReq, isExternal, isFromOwnTeam };
}

// ─── LLM extraction ────────────────────────────────────────────────────────────

interface LLMExtraction {
  route:   TriageRoute;
  title:   string;
  body:    string;
  urgency: 'low' | 'medium' | 'high';
}

async function llmExtract(
  text: string,
  pre: PreScreenResult,
  llmConfig: LLMConfig,
  anonymizer: import('../privacy/anonymizer.js').Anonymizer | null,
): Promise<LLMExtraction> {
  const { llmCall, extractJson } = await import('../llm/index.js');

  // Anonymise only for cloud models (primary role)
  const safeText = anonymizer ? anonymizer.anonymize(text).text : text;

  const hints: string[] = [];
  if (pre.mentionsMe)             hints.push('the owner is directly mentioned or tagged');
  if (pre.mentionedTeams.length)  hints.push(`teams mentioned: ${pre.mentionedTeams.join(', ')}`);
  if (pre.isWhitelistReq)         hints.push('message may contain a whitelist / address-add request — only route tx_whitelist if a blockchain address is explicitly involved, otherwise use my_task');
  if (pre.isFromOwnTeam)          hints.push('message from an internal team member');
  if (pre.isExternal && !pre.mentionsMe && !pre.mentionedTeams.length)
                                  hints.push('message from an external partner — no explicit mention, classify by content');

  const ownerInfo = [
    `Owner handles: ${llmConfig ? '' : ''}${(text: string) => text}`,
  ];
  void ownerInfo; // unused — info injected via config below

  const response = await llmCall(llmConfig, [
    {
      role: 'system',
      content: `You are a triage classifier for a fintech/crypto operations team.
Your job: read a partner message and decide what action it requires.

KEY RULE — External partner messages (no @mention):
- If the partner is making a request, asking a question, or needs something → create a task
- If the owner or their team is implicitly concerned (topic matches their role) → my_task or team_task
- If the message is purely informational, a status update, or casual chat → skip
- If a blockchain address needs whitelisting → tx_whitelist

Routes:
- my_task      = owner needs to DO something or REPLY (explicitly tagged OR topic clearly in their scope)
- team_task    = a team member is tagged or topic belongs to a specific team
- tx_whitelist = partner wants to whitelist a blockchain address — create a tx review pack
- skip         = purely informational, status update, casual, no action required

Respond ONLY with valid JSON, no markdown:
{
  "route": "my_task" | "team_task" | "tx_whitelist" | "skip",
  "title": "short action title (max 80 chars)",
  "body": "1-2 sentence summary of what needs doing",
  "urgency": "low" | "medium" | "high"
}`,
    },
    {
      role: 'user',
      content: `Context hints: ${hints.join('; ') || 'external partner message'}\n\nMessage:\n${safeText.slice(0, 1500)}`,
    },
  ]);

  try {
    return extractJson<LLMExtraction>(response.content);
  } catch {
    // Fallback if parse fails — use pre-screen to infer route
    const route: TriageRoute = pre.isWhitelistReq ? 'tx_whitelist'
      : pre.mentionsMe ? 'my_task'
      : pre.mentionedTeams.length ? 'team_task'
      : 'skip';
    return { route, title: safeText.slice(0, 80), body: safeText.slice(0, 200), urgency: 'medium' };
  }
}

// ─── Main triage function ──────────────────────────────────────────────────────

export async function triage(
  msg: RawMessage,
  config: Config,
  llmConfig: LLMConfig,
  privacyLlmConfig: LLMConfig | null,
): Promise<TriageResult | null> {
  const triageCfg = config.triage;

  if (!triageCfg.enabled) { log.debug(`Triage skip [${msg.partnerName}]: disabled`); return null; }
  if (!msg.content?.trim()) return null;

  // 1. Fast pre-screen — skip if nothing relevant
  const pre = preScreen(msg.content, config, msg);

  log.info(`Triage pre-screen [${msg.partnerName}] sender="${msg.senderName}" | mentionsMe=${pre.mentionsMe} teams=${JSON.stringify(pre.mentionedTeams)} whitelist=${pre.isWhitelistReq} external=${pre.isExternal} ownTeam=${pre.isFromOwnTeam}`);

  // mentionOnly mode: skip unless explicitly @mentioned
  if (triageCfg.mentionOnly && !pre.mentionsMe) { log.debug(`Triage skip [${msg.partnerName}]: mentionOnly, not mentioned`); return null; }

  // ignoreOwnTeam: skip internal team messages unless they @mention me
  if (triageCfg.ignoreOwnTeam && pre.isFromOwnTeam && !pre.mentionsMe) { log.debug(`Triage skip [${msg.partnerName}]: ignoreOwnTeam`); return null; }

  const hasCandidates = pre.mentionsMe || pre.mentionedTeams.length > 0 || pre.isWhitelistReq || pre.isExternal;
  if (!hasCandidates) { log.debug(`Triage skip [${msg.partnerName}]: no candidates`); return null; }

  log.debug(`Triage pre-screen matched for ${msg.partnerName}`, {
    mentionsMe: pre.mentionsMe,
    teams: pre.mentionedTeams,
    whitelist: pre.isWhitelistReq,
  });

  // 2. LLM extraction
  // privacy role (local) → contenu brut, zéro cloud egress
  // primary (cloud)      → anonymise d'abord
  const triageRole  = config.privacy.roles.triage ?? 'privacy';
  const usePrivacy  = triageRole === 'privacy' && privacyLlmConfig != null;
  const activeLlm  = usePrivacy ? privacyLlmConfig! : llmConfig;

  let anonymizer: import('../privacy/anonymizer.js').Anonymizer | null = null;
  if (!usePrivacy) {
    // Cloud model — anonymise first
    const { Anonymizer } = await import('../privacy/anonymizer.js');
    anonymizer = new Anonymizer(config.anonymizer);
  }

  let extraction: LLMExtraction;
  try {
    extraction = await llmExtract(msg.content, pre, activeLlm, anonymizer);
  } catch (e) {
    log.warn(`Triage LLM failed for ${msg.partnerName}: ${e}`);
    return null;
  }

  if (extraction.route === 'skip') return null;

  const result: TriageResult = {
    route:    extraction.route,
    title:    extraction.title,
    body:     extraction.body,
    urgency:  extraction.urgency,
    assignee: pre.mentionedTeams[0] ?? (pre.mentionsMe ? 'me' : undefined),
    partner:  msg.partnerName ?? msg.chatId,
    chatId:   msg.chatId,
    channel:  msg.channel ?? msg.source ?? 'unknown',
    rawRef:   msg.id,
  };

  audit('triage_matched', msg.id, 'triage', {
    route:   result.route,
    partner: result.partner,
    urgency: result.urgency,
  });

  log.info(`Triage → ${result.route} | "${result.title.slice(0, 60)}" [${msg.partnerName}]`);

  return result;
}
