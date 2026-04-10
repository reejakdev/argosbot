/**
 * Triage dry-run test harness.
 * Runs the real triage() function on a synthetic corpus with a deterministic
 * LLM mock, then prints a confusion matrix per category.
 *
 * Run: npx tsx scripts/test-triage.ts
 */

import { triage, __setLlmCallForTest } from '../src/core/triage.js';
import type { Config } from '../src/config/schema.js';
import type { LLMConfig, LLMResponse, LLMMessage } from '../src/llm/index.js';
import type { RawMessage } from '../src/types.js';
import { CORPUS, type CorpusEntry, type ExpectedRoute } from './test-triage-corpus.js';

// ─── Synthetic config ─────────────────────────────────────────────────────────
const config = {
  triage: {
    enabled: true,
    myHandles: ['@reejak', 'reejak'],
    watchedTeams: [
      { name: 'ops', handles: ['@ops'], keywords: ['ops'], isOwnTeam: false },
    ],
    whitelistKeywords: ['whitelist', 'add address'],
    ignoreOwnTeam: true,
    mentionOnly: false,
    notificationsLlmFilter: false,
  },
  privacy: { roles: { triage: 'privacy' } },
  anonymizer: {},
} as unknown as Config;

const llmConfig: LLMConfig = {
  provider: 'compatible',
  model: 'mock',
  apiKey: 'mock',
} as LLMConfig;

// ─── Deterministic LLM mock ───────────────────────────────────────────────────
// Simulates a "good" LLM: classify based on keywords in the user content.
// The harness focuses on testing pre-screen + routing, NOT real LLM quality.
const URGENT_RX =
  /(urgent|asap|immediately|right now|\bnow\b|\bdown\b|compromis|hack|deadline|tomorrow|today|escal|legal|terminat|critical|broken|panne|cass[ée]|next hour)/i;
const REQUEST_RX =
  /\b(can you|could you|please|peux[- ]tu|pourrais[- ]tu|envoie|send|review|schedule|need|share|forward|confirm|whitelist|add\b|onboard|prepare|sign[- ]?off|process|rotate)\b/i;
const QUESTION_NUDGE_RX =
  /^(any update|did you see|ping|hey|hm|so\??|\?|thoughts\??|still waiting|anyone)/i;
const SOCIAL_RX =
  /^(thanks|thank you|ok\b|cool|lol|great|appreciate|good (morning|afternoon|evening|weekend)|happy|congrats|🎉|👍)/i;
const INFO_RX =
  /\b(deploy(ed|ment)? (complete|done|success)|fyi|just so you know|heads up|reminder:|update:|published|uploaded|release notes|maintenance window|forwarded|webinar|newsletter|off[- ]topic|job opening)\b/i;

function mockLlmCall(_cfg: LLMConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  const userMsg = messages.find((m) => m.role === 'user');
  const text = typeof userMsg?.content === 'string' ? userMsg.content : '';
  // Strip "Context hints: ...\n\nMessage:\n" wrapper from triage prompt
  const msgBody = text.replace(/^Context hints:[\s\S]*?\n\nMessage:\n/, '').trim();
  const lower = msgBody.toLowerCase();

  let route: 'my_task' | 'team_task' | 'tx_whitelist' | 'skip' = 'skip';
  let urgency: 'low' | 'medium' | 'high' = 'low';
  let title = msgBody.slice(0, 60);

  const isSocial = SOCIAL_RX.test(msgBody.trim()) || /^[\p{Emoji}\s]+$/u.test(msgBody.trim());
  const isInfo = INFO_RX.test(msgBody);
  const isNudge = QUESTION_NUDGE_RX.test(msgBody.trim()) || msgBody.trim().length < 4;
  const isUrgent = URGENT_RX.test(msgBody);
  const isRequest = REQUEST_RX.test(msgBody);

  if (isSocial || isInfo || isNudge) {
    route = 'skip';
  } else if (isUrgent && (isRequest || /@reejak/i.test(msgBody))) {
    route = 'my_task';
    urgency = 'high';
    title = 'URGENT: ' + msgBody.slice(0, 50);
  } else if (isRequest) {
    route = 'my_task';
    urgency = 'medium';
  } else {
    route = 'skip';
  }

  const json = JSON.stringify({ route, title, body: msgBody.slice(0, 200), urgency });
  return Promise.resolve({
    content: json,
    model: 'mock',
    inputTokens: 0,
    outputTokens: 0,
    provider: 'compatible',
  } as LLMResponse);
}

__setLlmCallForTest(mockLlmCall as unknown as Parameters<typeof __setLlmCallForTest>[0]);

// ─── Build a RawMessage ───────────────────────────────────────────────────────
function makeMsg(entry: CorpusEntry, idx: number): RawMessage {
  return {
    id: `test-${idx}`,
    channel: 'telegram',
    source: 'telegram',
    chatId: `chat-${idx}`,
    senderName: 'Partner X',
    senderUsername: 'partnerx',
    partnerName: 'Partner X',
    content: entry.text,
    receivedAt: Date.now(),
  } as unknown as RawMessage;
}

// ─── Map a triage outcome to the test routes ─────────────────────────────────
type ActualRoute = 'urgent_notif' | 'task' | 'skip';
function classifyOutcome(
  result: Awaited<ReturnType<typeof triage>>,
): ActualRoute {
  if (!result) return 'skip';
  if (result.urgency === 'high') return 'urgent_notif';
  return 'task';
}

// ─── Run ──────────────────────────────────────────────────────────────────────
interface RowResult {
  entry: CorpusEntry;
  expected: ExpectedRoute;
  actual: ActualRoute;
}

async function main() {
  const results: RowResult[] = [];
  for (let i = 0; i < CORPUS.length; i++) {
    const entry = CORPUS[i];
    const msg = makeMsg(entry, i);
    let actual: ActualRoute;
    try {
      const r = await triage(msg, config, llmConfig, llmConfig);
      actual = classifyOutcome(r);
    } catch (e) {
      console.error(`triage threw on entry ${i}: ${e}`);
      actual = 'skip';
    }
    results.push({ entry, expected: entry.expectedRoute, actual });
  }

  // ─── Confusion matrix per category ──────────────────────────────────────────
  const cats: ActualRoute[] = ['urgent_notif', 'task', 'skip'];
  const stats: Record<ActualRoute, { tp: number; fp: number; fn: number; tn: number }> = {
    urgent_notif: { tp: 0, fp: 0, fn: 0, tn: 0 },
    task: { tp: 0, fp: 0, fn: 0, tn: 0 },
    skip: { tp: 0, fp: 0, fn: 0, tn: 0 },
  };

  for (const r of results) {
    for (const c of cats) {
      const isPos = r.expected === c;
      const predPos = r.actual === c;
      if (isPos && predPos) stats[c].tp++;
      else if (!isPos && predPos) stats[c].fp++;
      else if (isPos && !predPos) stats[c].fn++;
      else stats[c].tn++;
    }
  }

  console.log('\n=== Confusion matrix ===');
  for (const c of cats) {
    const s = stats[c];
    const prec = s.tp + s.fp ? s.tp / (s.tp + s.fp) : 1;
    const rec = s.tp + s.fn ? s.tp / (s.tp + s.fn) : 1;
    console.log(
      `${c.padEnd(14)} TP=${s.tp} FP=${s.fp} FN=${s.fn} TN=${s.tn}  precision=${prec.toFixed(2)}  recall=${rec.toFixed(2)}`,
    );
  }

  const total = results.length;
  const surfaced = results.filter((r) => r.actual !== 'skip').length;
  const correctlySurfaced = results.filter(
    (r) => r.actual !== 'skip' && r.expected === r.actual,
  ).length;
  console.log(
    `\nTotal: ${total} | Surfaced: ${surfaced} (${((surfaced / total) * 100).toFixed(0)}%) | Correctly surfaced: ${correctlySurfaced}`,
  );

  console.log('\n=== False positives (noise → notif/task) ===');
  for (const r of results) {
    if (r.expected === 'skip' && r.actual !== 'skip') {
      console.log(`  [${r.actual}] "${r.entry.text.slice(0, 80)}"`);
    }
  }
  console.log('\n=== False negatives (urgent → dropped) ===');
  for (const r of results) {
    if (r.expected === 'urgent_notif' && r.actual !== 'urgent_notif') {
      console.log(`  [got=${r.actual}] "${r.entry.text.slice(0, 80)}"`);
    }
  }
  console.log('\n=== Task FNs (action → dropped) ===');
  for (const r of results) {
    if (r.expected === 'task' && r.actual === 'skip') {
      console.log(`  "${r.entry.text.slice(0, 80)}"`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
