/**
 * Conversation compaction — summarize old messages to stay within token limits.
 *
 * When conversation history exceeds MAX_HISTORY_MESSAGES, the oldest messages
 * are summarized into a single "context recap" message, preserving key info.
 */

import type { LLMConfig, LLMMessage } from './index.js';
import { createLogger } from '../logger.js';

const log = createLogger('compaction');

const MAX_HISTORY_MESSAGES = 20;
const COMPACT_KEEP_RECENT = 6; // keep last N messages verbatim

export interface CompactableHistory {
  messages: LLMMessage[];
  compactedSummary?: string; // previous compaction summary
}

/**
 * Check if history needs compaction.
 */
export function needsCompaction(history: CompactableHistory): boolean {
  return history.messages.length > MAX_HISTORY_MESSAGES;
}

/**
 * Compact conversation history by summarizing old messages.
 * Returns new history with a summary + recent messages.
 */
export async function compactHistory(
  history: CompactableHistory,
  llmConfig: LLMConfig,
  callLlm: (config: LLMConfig, messages: LLMMessage[]) => Promise<{ content: string }>,
): Promise<CompactableHistory> {
  if (!needsCompaction(history)) return history;

  const msgs = history.messages;
  const toSummarize = msgs.slice(0, msgs.length - COMPACT_KEEP_RECENT);
  const toKeep = msgs.slice(msgs.length - COMPACT_KEEP_RECENT);

  log.info(
    `Compacting ${toSummarize.length} messages into summary, keeping ${toKeep.length} recent`,
  );

  // Build the previous context
  const previousContext = history.compactedSummary
    ? `Previous conversation summary:\n${history.compactedSummary}\n\n`
    : '';

  const summaryPrompt: LLMMessage[] = [
    {
      role: 'system',
      content: `You are a conversation summarizer. Produce a single, unified summary that merges any prior summary with the new messages below.
Do NOT simply append — deduplicate facts and update outdated info.
Preserve:
- Key facts, decisions, and action items
- User preferences and profile info shared
- Important context that would be needed to continue the conversation
- Names, dates, specific details mentioned

Format: bullet points, max 500 words. Write in the same language as the conversation.`,
    },
    {
      role: 'user',
      content: `${previousContext}New messages to merge into the summary:\n\n${toSummarize.map((m) => `[${m.role}]: ${m.content}`).join('\n\n')}`,
    },
  ];

  const response = await callLlm(llmConfig, summaryPrompt);
  const summary = response.content;

  log.info(`Compaction done — summary: ${summary.length} chars`);

  return {
    compactedSummary: summary,
    messages: toKeep,
  };
}

/**
 * Build the full message array for LLM call, injecting compacted summary if present.
 */
export function buildMessagesWithCompaction(
  systemPrompt: string,
  history: CompactableHistory,
  extraContext?: string,
): LLMMessage[] {
  const messages: LLMMessage[] = [];

  // System prompt with optional compacted context
  let fullSystem = systemPrompt;
  if (history.compactedSummary) {
    fullSystem += `\n\n---\n## Conversation history (summarized):\n${history.compactedSummary}`;
  }
  if (extraContext) {
    fullSystem += extraContext;
  }

  messages.push({ role: 'system', content: fullSystem });
  messages.push(...history.messages);

  return messages;
}
