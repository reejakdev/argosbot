/**
 * Tool-use agent loop — call LLM, execute tools, feed results back, repeat.
 *
 * Supports both built-in skills and MCP tools.
 * Max iterations to prevent infinite loops.
 */

import type { LLMConfig, LLMMessage, LLMResponse } from './index.js';
import { createLogger } from '../logger.js';
import { audit } from '../db/index.js';

const log = createLogger('tool-loop');

const DEFAULT_MAX_ITERATIONS = 12;
const HARD_MAX_ITERATIONS = 50; // safety ceiling — config can use up to this
const TOOL_RESULT_MAX_CHARS = 4000; // cap each tool result to prevent context bloat

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ToolExecutor {
  (name: string, input: Record<string, unknown>): Promise<{ output: string; error?: boolean }>;
}

export type ToolLoopEvent =
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; output: string; error?: boolean }
  | { type: 'text_chunk'; text: string };

/**
 * Run an agent loop with tool use.
 * The LLM can call tools, we execute them, and send results back until the LLM stops.
 */
export async function runToolLoop(
  config: LLMConfig,
  _systemPrompt: string,
  messages: LLMMessage[],
  tools: ToolDefinition[],
  executor: ToolExecutor,
  callLlmRaw: (
    config: LLMConfig,
    body: Record<string, unknown>,
    onTextDelta?: (delta: string) => void,
  ) => Promise<{
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    stop_reason: string;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  }>,
  onEvent?: (event: ToolLoopEvent) => void | Promise<void>,
  /** Called between tool calls — return a string to inject a user interrupt message. */
  getInterrupt?: () => string | undefined,
): Promise<LLMResponse> {
  // Extract system prompt and build raw message array
  const systemMsg = messages.find((m) => m.role === 'system');
  const rawMessages: Array<Record<string, unknown>> = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalText = '';
  let model = config.model;
  let iterations = 0;
  // Hard-cap iterations to prevent runaway token costs (MCP tool floods)
  const maxIterations = Math.min(
    config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    HARD_MAX_ITERATIONS,
  );

  // Detect Anthropic provider — only Anthropic supports cache_control
  const isAnthropic = config.provider === 'anthropic';

  for (let i = 0; i < maxIterations; i++, iterations++) {
    // Build system blocks with cache_control on Anthropic for prefix caching
    // (saves ~90% on input tokens for the system prompt across iterations)
    const systemForBody = isAnthropic && systemMsg
      ? [
          {
            type: 'text',
            text: systemMsg.content as string,
            cache_control: { type: 'ephemeral' },
          },
        ]
      : systemMsg?.content;

    // Cache_control on the last user message anchors the rolling cache.
    // The tool definitions array also gets cached implicitly when system is cached.
    const messagesForBody = isAnthropic
      ? rawMessages.map((m, idx) => {
          const isLast = idx === rawMessages.length - 1;
          if (!isLast || m.role !== 'user') return m;
          // Add cache_control to the last user message's last content block
          if (typeof m.content === 'string') {
            return {
              ...m,
              content: [
                { type: 'text', text: m.content, cache_control: { type: 'ephemeral' } },
              ],
            };
          }
          if (Array.isArray(m.content) && m.content.length > 0) {
            const newContent = [...(m.content as Array<Record<string, unknown>>)];
            newContent[newContent.length - 1] = {
              ...newContent[newContent.length - 1],
              cache_control: { type: 'ephemeral' },
            };
            return { ...m, content: newContent };
          }
          return m;
        })
      : rawMessages;

    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      stream: true,
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      ...(systemForBody !== undefined && { system: systemForBody }),
      messages: messagesForBody,
      ...(tools.length > 0 && { tools }),
    };

    // Stream text deltas in real time via onEvent
    const streamDelta = onEvent
      ? (delta: string) => {
          void onEvent({ type: 'text_chunk', text: delta });
        }
      : undefined;
    const result = await callLlmRaw(config, body, streamDelta);
    model = result.model;
    totalInputTokens += result.usage.input_tokens;
    totalOutputTokens += result.usage.output_tokens;

    // Extract text and tool_use blocks
    const textBlocks = result.content.filter((b) => b.type === 'text');
    const toolBlocks = result.content.filter((b) => b.type === 'tool_use');

    const newText = textBlocks.map((b) => b.text ?? '').join('');
    finalText += newText;
    // text_chunk already emitted in real-time via streamDelta above — no duplicate emit needed

    // If no tool calls, we're done
    if (toolBlocks.length === 0 || result.stop_reason !== 'tool_use') {
      break;
    }

    // Add assistant message with all blocks — clean internal fields
    const cleanedContent = result.content.map((b) => {
      const clean = { ...b };
      delete (clean as Record<string, unknown>)._partialJson;
      return clean;
    });
    rawMessages.push({ role: 'assistant', content: cleanedContent });

    // Execute tools and collect results
    const toolResults: ToolResult[] = [];
    for (const block of toolBlocks) {
      log.info(`Executing tool: ${block.name}`, {
        input: JSON.stringify(block.input).slice(0, 100),
      });
      if (onEvent)
        await onEvent({ type: 'tool_call', name: block.name!, input: block.input ?? {} });

      try {
        const toolTimeout = 60_000; // 60s max per tool execution
        const { output, error } = await Promise.race([
          executor(block.name!, block.input ?? {}),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(new Error(`Tool "${block.name}" timed out after ${toolTimeout / 1000}s`)),
              toolTimeout,
            ),
          ),
        ]);
        // Truncate large tool results to prevent context bloat / token waste.
        // Without this, MCP tools returning JSON blobs can blow up the context
        // window across many iterations.
        const truncated =
          output.length > TOOL_RESULT_MAX_CHARS
            ? output.slice(0, TOOL_RESULT_MAX_CHARS) +
              `\n\n[... truncated ${output.length - TOOL_RESULT_MAX_CHARS} chars]`
            : output;
        toolResults.push({ tool_use_id: block.id!, content: truncated, is_error: error });
        if (onEvent)
          await onEvent({
            type: 'tool_result',
            name: block.name!,
            output: output.slice(0, 200),
            error,
          });
        log.info(`Tool ${block.name} result: ${output.slice(0, 100)}`);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        toolResults.push({ tool_use_id: block.id!, content: `Error: ${errMsg}`, is_error: true });
        if (onEvent)
          await onEvent({ type: 'tool_result', name: block.name!, output: errMsg, error: true });
        log.error(`Tool ${block.name} failed: ${e}`);
      }
    }

    // Add tool results as user message
    rawMessages.push({
      role: 'user',
      content: toolResults.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.tool_use_id,
        content: r.content,
        ...(r.is_error && { is_error: true }),
      })),
    });

    // Check for user interrupt injected between tool calls
    if (getInterrupt) {
      const interrupt = getInterrupt();
      if (interrupt) {
        log.info(`Tool loop: injecting user interrupt — ${interrupt.slice(0, 80)}`);
        rawMessages.push({
          role: 'user',
          content: `[User sent a new message mid-task]: ${interrupt}`,
        });
        if (onEvent)
          await onEvent({
            type: 'thinking',
            text: `↩️ User interrupted: ${interrupt.slice(0, 60)}`,
          });
      }
    }
  }

  log.info(
    `Tool loop tokens: ${totalInputTokens}in / ${totalOutputTokens}out (${iterations} iteration${iterations > 1 ? 's' : ''})`,
  );

  // If we exited the loop because we hit maxIterations (not because the model stopped),
  // the task is incomplete — surface it explicitly so the user knows.
  if (iterations >= maxIterations) {
    log.warn(`Tool loop hit MAX_ITERATIONS (${maxIterations}) — task may be incomplete`);
    audit('tool_loop_max_iterations', undefined, 'tool_loop', {
      iterations,
      model,
      tokensIn: totalInputTokens,
      tokensOut: totalOutputTokens,
    });
    finalText += `\n\n⚠️ *Limite atteinte* — j'ai utilisé ${maxIterations} itérations sans terminer. La tâche est incomplète. Dis-moi de continuer ou découpe en sous-tâches plus petites.`;
  }

  return {
    content: finalText,
    model,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    provider: config.provider,
  };
}
