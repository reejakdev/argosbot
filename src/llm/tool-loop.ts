/**
 * Tool-use agent loop — call LLM, execute tools, feed results back, repeat.
 *
 * Supports both built-in skills and MCP tools.
 * Max iterations to prevent infinite loops.
 */

import type { LLMConfig, LLMMessage, LLMResponse } from './index.js';
import { createLogger } from '../logger.js';

const log = createLogger('tool-loop');

const MAX_ITERATIONS = 12;

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
  systemPrompt: string,
  messages: LLMMessage[],
  tools: ToolDefinition[],
  executor: ToolExecutor,
  callLlmRaw: (
    config: LLMConfig,
    body: Record<string, unknown>,
    onTextDelta?: (delta: string) => void,
  ) => Promise<{
    content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    stop_reason: string;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  }>,
  onEvent?: (event: ToolLoopEvent) => void | Promise<void>,
  /** Called between tool calls — return a string to inject a user interrupt message. */
  getInterrupt?: () => string | undefined,
): Promise<LLMResponse> {
  // Extract system prompt and build raw message array
  const systemMsg = messages.find(m => m.role === 'system');
  const rawMessages: Array<Record<string, unknown>> = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalText = '';
  let model = config.model;
  let iterations = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++, iterations++) {
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      stream: true,
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      ...(systemMsg && { system: systemMsg.content }),
      messages: rawMessages,
      ...(tools.length > 0 && { tools }),
    };

    // Stream text deltas in real time via onEvent
    const streamDelta = onEvent
      ? (delta: string) => { void onEvent({ type: 'text_chunk', text: delta }); }
      : undefined;
    const result = await callLlmRaw(config, body, streamDelta);
    model = result.model;
    totalInputTokens += result.usage.input_tokens;
    totalOutputTokens += result.usage.output_tokens;

    // Extract text and tool_use blocks
    const textBlocks = result.content.filter(b => b.type === 'text');
    const toolBlocks = result.content.filter(b => b.type === 'tool_use');

    const newText = textBlocks.map(b => b.text ?? '').join('');
    finalText += newText;
    // text_chunk already emitted in real-time via streamDelta above — no duplicate emit needed

    // If no tool calls, we're done
    if (toolBlocks.length === 0 || result.stop_reason !== 'tool_use') {
      break;
    }

    // Add assistant message with all blocks — clean internal fields
    const cleanedContent = result.content.map(b => {
      const clean = { ...b };
      delete (clean as Record<string, unknown>)._partialJson;
      return clean;
    });
    rawMessages.push({ role: 'assistant', content: cleanedContent });

    // Execute tools and collect results
    const toolResults: ToolResult[] = [];
    for (const block of toolBlocks) {
      log.info(`Executing tool: ${block.name}`, { input: JSON.stringify(block.input).slice(0, 100) });
      if (onEvent) await onEvent({ type: 'tool_call', name: block.name!, input: block.input ?? {} });

      try {
        const { output, error } = await executor(block.name!, block.input ?? {});
        toolResults.push({ tool_use_id: block.id!, content: output, is_error: error });
        if (onEvent) await onEvent({ type: 'tool_result', name: block.name!, output: output.slice(0, 200), error });
        log.info(`Tool ${block.name} result: ${output.slice(0, 100)}`);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        toolResults.push({ tool_use_id: block.id!, content: `Error: ${errMsg}`, is_error: true });
        if (onEvent) await onEvent({ type: 'tool_result', name: block.name!, output: errMsg, error: true });
        log.error(`Tool ${block.name} failed: ${e}`);
      }
    }

    // Add tool results as user message
    rawMessages.push({
      role: 'user',
      content: toolResults.map(r => ({
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
        rawMessages.push({ role: 'user', content: `[User sent a new message mid-task]: ${interrupt}` });
        if (onEvent) await onEvent({ type: 'thinking', text: `↩️ User interrupted: ${interrupt.slice(0, 60)}` });
      }
    }
  }

  log.info(`Tool loop tokens: ${totalInputTokens}in / ${totalOutputTokens}out (${iterations} iteration${iterations > 1 ? 's' : ''})`);

  // If we exited the loop because we hit MAX_ITERATIONS (not because the model stopped),
  // the task is incomplete — surface it explicitly so the user knows.
  if (iterations >= MAX_ITERATIONS) {
    log.warn(`Tool loop hit MAX_ITERATIONS (${MAX_ITERATIONS}) — task may be incomplete`);
    finalText += `\n\n⚠️ *Limite atteinte* — j'ai utilisé ${MAX_ITERATIONS} itérations sans terminer. La tâche est incomplète. Dis-moi de continuer ou découpe en sous-tâches plus petites.`;
  }

  return {
    content: finalText,
    model,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    provider: config.provider,
  };
}
