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
  | 'my_task'      // actionable work item I must complete (not just reply) → task created
  | 'my_reply'     // question/request needing a reply only → notification + draft, no task
  | 'notification' // important message to not miss (urgent info, update I need to see) → notification only, no task
  | 'team_task'    // tagged my team → task for them + silent
  | 'tx_whitelist' // whitelist address request → tx review pack
  | 'skip';        // nothing actionable

export interface TriageResult {
  route: TriageRoute;
  title: string;
  body: string;
  assignee?: string; // team name or 'me'
  urgency: 'low' | 'medium' | 'high';
  partner: string;
  chatId: string;
  channel: string; // source channel (telegram, whatsapp, email…)
  rawRef: string; // source message ID for traceability
  messageUrl?: string; // permalink to the original message (Telegram, Slack…)
}

// ─── Pre-screen ────────────────────────────────────────────────────────────────
// Cheap regex pass — returns candidate routes without any LLM call.

interface PreScreenResult {
  mentionsMe: boolean;
  isReplyToMe: boolean; // message is a direct reply to the owner's own message
  mentionedTeams: string[]; // teams matched by handle OR keyword (broad)
  mentionedTeamsByHandle: string[]; // teams matched by handle ONLY (strict, no keyword)
  isWhitelistReq: boolean;
  isExternal: boolean; // message from a monitored partner chat (always triage)
  isFromOwnTeam: boolean; // sender is a member of an internal team
  isFromAnyTeam: boolean; // sender is a member of ANY watched team
  senderTeam?: string; // the team name the sender belongs to
  isUrgent: boolean; // regex hit on urgency keywords (en + fr)
}

// Urgency keywords — EN + FR. Used as a hint to the LLM AND as a promotion gate:
// if pre.isUrgent, low/medium → high urgency (notification interrupt).
// Kept narrow on purpose: only words that actually signal interrupt-now.
const URGENT_KEYWORDS_RX =
  /(urgent|asap|immediately|right now|\bnow\b|\bdown\b|compromis|hack|deadline|tomorrow|today|escal|legal|terminat|critical|broken|outage|panne|cass[ée]|next hour|d[eé]s que possible|tout de suite)/i;

function preScreen(
  text: string,
  config: Config,
  msg?: import('../types.js').RawMessage,
): PreScreenResult {
  const triage = config.triage;
  const lower = text.toLowerCase();

  // Direct reply to owner's message counts as a mention
  const isReplyToMe = !!(msg?.meta as Record<string, unknown>)?.isReplyToMe;

  const mentionsMe =
    isReplyToMe ||
    triage.myHandles.some((h: string) => {
      const needle = h.startsWith('@') ? h.toLowerCase() : `@${h.toLowerCase()}`;
      return lower.includes(needle) || lower.includes(h.toLowerCase());
    });

  // Teams matched by handle ONLY (explicit mention of @team or @member)
  const mentionedTeamsByHandle = triage.watchedTeams
    .filter((team: { handles: string[] }) => {
      return team.handles.some((h: string) => {
        const withAt = h.startsWith('@') ? h.toLowerCase() : `@${h.toLowerCase()}`;
        const withoutAt = h.startsWith('@') ? h.slice(1).toLowerCase() : h.toLowerCase();
        return lower.includes(withAt) || lower.includes(withoutAt);
      });
    })
    .map((t: { name: string }) => t.name);

  // Teams matched by handle OR keyword (broader — used for external partners)
  const mentionedTeams = triage.watchedTeams
    .filter((team: { handles: string[]; keywords: string[] }) => {
      const handleMatch = team.handles.some((h: string) => {
        const withAt = h.startsWith('@') ? h.toLowerCase() : `@${h.toLowerCase()}`;
        const withoutAt = h.startsWith('@') ? h.slice(1).toLowerCase() : h.toLowerCase();
        return lower.includes(withAt) || lower.includes(withoutAt);
      });
      const kwMatch = team.keywords.some((kw: string) => lower.includes(kw.toLowerCase()));
      return handleMatch || kwMatch;
    })
    .map((t: { name: string }) => t.name);

  const isWhitelistReq = triage.whitelistKeywords.some((kw: string) =>
    lower.includes(kw.toLowerCase()),
  );

  // Detect which team the sender belongs to (any watched team, not just own)
  const senderId = msg?.senderId ?? '';
  const senderName = (msg?.senderName ?? '').toLowerCase();
  const senderUsername = (
    (msg as { senderUsername?: string } | undefined)?.senderUsername ?? ''
  ).toLowerCase();
  let senderTeam: string | undefined;
  let senderTeamIsOwn = false;
  for (const team of config.triage.watchedTeams) {
    const t = team as { name: string; handles?: string[]; isOwnTeam?: boolean };
    const match = (t.handles ?? []).some((h: string) => {
      const needle = h.startsWith('@') ? h.slice(1).toLowerCase() : h.toLowerCase();
      // Strict @username match first (Telegram handle), then numeric ID, then display name
      return (
        senderUsername === needle ||
        senderId === needle ||
        senderName === needle ||
        senderName.includes(needle)
      );
    });
    if (match) {
      senderTeam = t.name;
      senderTeamIsOwn = t.isOwnTeam ?? false;
      break;
    }
  }
  const isFromOwnTeam = senderTeamIsOwn;
  const isFromAnyTeam = senderTeam !== undefined;

  // Any message from a monitored partner chat is a candidate — the LLM decides if it's actionable
  const isExternal = !!msg?.partnerName && !isFromAnyTeam;

  const isUrgent = URGENT_KEYWORDS_RX.test(text);

  return {
    mentionsMe,
    isReplyToMe,
    mentionedTeams,
    mentionedTeamsByHandle,
    isWhitelistReq,
    isExternal,
    isFromOwnTeam,
    senderTeam,
    isFromAnyTeam,
    isUrgent,
  };
}

// ─── LLM extraction ────────────────────────────────────────────────────────────

interface LLMExtraction {
  route: TriageRoute;
  title: string;
  body: string;
  urgency: 'low' | 'medium' | 'high';
}

// ─── Test injection hook ──────────────────────────────────────────────────────
// Allows tests to override the LLM call without monkey-patching ESM modules.
type LlmCallFn = typeof import('../llm/index.js').llmCall;
let _llmCallOverride: LlmCallFn | null = null;
export function __setLlmCallForTest(fn: LlmCallFn | null): void {
  _llmCallOverride = fn;
}
export { preScreen as __preScreenForTest };

async function llmExtract(
  text: string,
  pre: PreScreenResult,
  llmConfig: LLMConfig,
  anonymizer: import('../privacy/anonymizer.js').Anonymizer | null,
): Promise<LLMExtraction> {
  const { llmCall: realLlmCall, extractJson } = await import('../llm/index.js');
  const llmCall = _llmCallOverride ?? realLlmCall;

  // Anonymise only for cloud models (primary role)
  const safeText = anonymizer ? anonymizer.anonymize(text).text : text;

  const hints: string[] = [];
  if (pre.mentionsMe)
    hints.push(
      pre.isReplyToMe
        ? "this is a direct reply to the owner's own message — treat as if owner was tagged"
        : 'the owner is directly mentioned or tagged',
    );
  if (pre.mentionedTeams.length) hints.push(`teams mentioned: ${pre.mentionedTeams.join(', ')}`);
  if (pre.isWhitelistReq)
    hints.push(
      'message may contain a whitelist / add request — only route tx_whitelist if a specific identifier needs to be whitelisted, otherwise use my_task',
    );
  if (pre.isFromOwnTeam) hints.push('message from an internal team member');
  if (pre.isExternal && !pre.mentionsMe && !pre.mentionedTeams.length)
    hints.push('message from an external partner — no explicit mention, classify by content');
  if (pre.isUrgent)
    hints.push('PRE-SCREEN URGENCY HIT — message contains urgency keywords (urgent/asap/down/deadline/etc), strongly consider urgency=high if action is needed');

  const ownerInfo = [`Owner handles: ${llmConfig ? '' : ''}${(text: string) => text}`];
  void ownerInfo; // unused — info injected via config below

  const isAnthropic = llmConfig.provider === 'anthropic';
  const systemText = `You are a HIGH-PRECISION triage classifier for a busy fintech operations manager who receives ~200 partner messages/day.

ROUTES — pick exactly one:

my_task      = Owner must complete a concrete multi-step action or deliverable (not just reply).
               Examples: process withdrawals, send funds, review contract, set up integration, deploy fix.
               Creates a task in the to-do list.

my_reply     = Owner needs to answer a question or give a quick response — the "work" is just the reply.
               Examples: "what's the address?", "can you confirm?", "did you receive X?", "are you available Thursday?"
               Does NOT create a task — generates a draft reply + push notification.

notification = Important message the owner must NOT miss, but requires no action right now.
               Examples: partner transferred funds (FYI), liquidity warning, regulatory update, critical system alert, incident resolved but owner should know.
               Push notification only — no task, no draft.

team_task    = Request clearly directed at a specific internal team (not the owner).
               Silently logged for that team — no notification to owner.

tx_whitelist = Partner wants an address/identifier whitelisted or added to an allowlist.
               Creates a whitelist review task.

skip         = Nothing actionable. No push. No task.
               - Social: thanks, ok, 👍, greetings, congrats
               - Vague nudges: "ping", "?", "any update?", "hey", "still waiting"
               - OOO: "I'll be offline tomorrow"
               - Pure status (no action needed): "deploy done", "report uploaded", "migration complete"
               - Newsletters, marketing, off-topic chat

URGENCY:
- high   = interrupt now: money at risk, production down, hard deadline today/tomorrow, explicit urgent/asap, partner escalating
- medium = concrete request, soft deadline (by end of week, when you can)
- low    = background, informational, no deadline

DECISION TREE:
1. Is it social / vague / OOO / pure status? → skip
2. Does it ask me to DO something concrete (multi-step, not just reply)? → my_task
3. Does it ask me a question or need a quick reply? → my_reply
4. Is it important info I must see but no action needed? → notification (only if urgency=medium or high)
5. Is it directed at an internal team? → team_task
6. Wallet/address whitelist request? → tx_whitelist
7. Otherwise → skip

Respond ONLY with valid JSON, no markdown:
{
  "route": "my_task" | "my_reply" | "notification" | "team_task" | "tx_whitelist" | "skip",
  "title": "max 80 chars — verb + object (e.g. 'Process withdrawal requests for Ether.fi')",
  "body": "1-2 sentences — what happened and what is expected",
  "urgency": "low" | "medium" | "high"
}`;

  const systemMessage = isAnthropic
    ? ({
        role: 'system' as const,
        content: [
          { type: 'text', text: systemText, cache_control: { type: 'ephemeral' } },
        ] as unknown as import('../llm/index.js').LLMContentBlock[],
      })
    : { role: 'system' as const, content: systemText };

  const response = await llmCall({ ...llmConfig, maxTokens: 256 }, [
    systemMessage,
    {
      role: 'user',
      content: `Context hints: ${hints.join('; ') || 'external partner message'}\n\nMessage:\n${safeText.slice(0, 800)}`,
    },
  ]);

  try {
    return extractJson<LLMExtraction>(response.content);
  } catch {
    // Fallback if parse fails — use pre-screen to infer route
    const route: TriageRoute = pre.isWhitelistReq
      ? 'tx_whitelist'
      : pre.mentionsMe
        ? 'my_task'
        : pre.mentionedTeams.length
          ? 'team_task'
          : pre.isUrgent
            ? 'notification'
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

  if (!triageCfg.enabled) {
    log.debug(`Triage skip [${msg.partnerName}]: disabled`);
    return null;
  }
  if (!msg.content?.trim()) return null;

  // Skip slash commands — bot commands for other bots in group chats (e.g. /redeem, /start)
  if (/^\s*\/[a-zA-Z]/.test(msg.content)) {
    log.debug(`Triage skip [${msg.partnerName}]: slash command ignored`);
    return null;
  }

  // 1. Fast pre-screen — skip if nothing relevant
  const pre = preScreen(msg.content, config, msg);

  log.info(
    `Triage pre-screen [${msg.partnerName}] sender="${msg.senderName}" | mentionsMe=${pre.mentionsMe} teams=${JSON.stringify(pre.mentionedTeams)} whitelist=${pre.isWhitelistReq} external=${pre.isExternal} ownTeam=${pre.isFromOwnTeam}`,
  );

  // mentionOnly mode: skip unless explicitly @mentioned
  if (triageCfg.mentionOnly && !pre.mentionsMe) {
    log.debug(`Triage skip [${msg.partnerName}]: mentionOnly, not mentioned`);
    return null;
  }

  // Sender is a teammate (any watched team):
  //   - if they @mention me → process normally (creates my_task)
  //   - if they @mention another team handle → process as team_task for that team (silent)
  //   - if they just use keywords (whitelist, etc.) → SKIP, no task
  //   - if they say nothing relevant → SKIP
  if (pre.isFromAnyTeam && !pre.mentionsMe && pre.mentionedTeamsByHandle.length === 0) {
    log.debug(
      `Triage skip [${msg.partnerName}]: sender "${msg.senderName}" in team "${pre.senderTeam}", no explicit team handle mention`,
    );
    return null;
  }

  const hasCandidates =
    pre.mentionsMe || pre.mentionedTeams.length > 0 || pre.isWhitelistReq || pre.isExternal;
  if (!hasCandidates) {
    log.debug(`Triage skip [${msg.partnerName}]: no candidates`);
    return null;
  }

  log.debug(`Triage pre-screen matched for ${msg.partnerName}`, {
    mentionsMe: pre.mentionsMe,
    teams: pre.mentionedTeams,
    whitelist: pre.isWhitelistReq,
  });

  // 2. LLM extraction
  // privacy role (local) → contenu brut, zéro cloud egress
  // primary (cloud)      → anonymise d'abord
  const triageRole = config.privacy.roles.triage ?? 'privacy';
  const usePrivacy = triageRole === 'privacy' && privacyLlmConfig !== null;
  const activeLlm = usePrivacy ? privacyLlmConfig! : llmConfig;

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
    log.warn(`Triage LLM failed for ${msg.partnerName}: ${e} — falling back to pre-screen`);
    // Fallback to pre-screen result instead of silently dropping
    const route: TriageRoute = pre.isWhitelistReq
      ? 'tx_whitelist'
      : pre.mentionsMe
        ? 'my_task'
        : pre.mentionedTeams.length
          ? 'team_task'
          : 'skip';
    extraction = {
      route,
      title: (msg.anonText ?? msg.content).slice(0, 80),
      body: (msg.anonText ?? msg.content).slice(0, 200),
      urgency: 'medium',
    };
  }

  if (extraction.route === 'skip') return null;

  // Pre-screen urgency override: if regex caught urgency keywords AND the LLM
  // agreed there's an action, promote to high. This catches LLM under-rating
  // (e.g. "terminate the contract in next hour") and guarantees genuine
  // urgency reaches the notification path.
  if (pre.isUrgent && extraction.urgency !== 'high') {
    log.info(
      `Triage urgency promoted to high by pre-screen for ${msg.partnerName} ("${extraction.title.slice(0, 50)}")`,
    );
    extraction.urgency = 'high';
  }

  const result: TriageResult = {
    route: extraction.route,
    title: extraction.title,
    body: extraction.body,
    urgency: extraction.urgency,
    assignee: pre.mentionedTeams[0] ?? (pre.mentionsMe ? 'me' : undefined),
    partner: msg.partnerName ?? msg.chatId,
    chatId: msg.chatId,
    channel: msg.channel ?? msg.source ?? 'unknown',
    rawRef: msg.id,
    messageUrl: msg.messageUrl,
  };

  try {
    audit('triage_matched', msg.id, 'triage', {
      route: result.route,
      partner: result.partner,
      urgency: result.urgency,
    });
  } catch (e) {
    log.debug(`audit failed (non-fatal): ${e}`);
  }

  log.info(`Triage → ${result.route} | "${result.title.slice(0, 60)}" [${msg.partnerName}]`);

  return result;
}
