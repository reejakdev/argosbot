/**
 * LLM abstraction layer — swap between Claude, GPT-4o, or any
 * OpenAI-compatible endpoint without changing call sites.
 *
 * Supported providers:
 *   - "anthropic"  → Claude (Opus 4.6, Sonnet 4.6, Haiku 4.5, …)
 *   - "openai"     → OpenAI (gpt-4o, o1, …)
 *   - "compatible" → Any OpenAI-compatible endpoint (LM Studio, Mistral, Together, …)
 */

import { createLogger } from '../logger.js';

const log = createLogger('llm');

// ─── OAuth concurrency guard ──────────────────────────────────────────────────
// Anthropic OAuth (bearer) tokens can only serve one request at a time.
// We serialize all bearer-mode calls to prevent silent hangs.

let _bearerQueue: Promise<unknown> = Promise.resolve();

function withBearerQueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = _bearerQueue.then(
    () => fn(),
    () => fn(),
  );
  _bearerQueue = next.then(
    () => {},
    () => {},
  );
  return next;
}

// ─── Provider config ──────────────────────────────────────────────────────────

export type LLMProvider = 'anthropic' | 'openai' | 'compatible';

export type AuthMode = 'api-key' | 'bearer';

export interface OAuthTokens {
  access: string;
  refresh: string;
  expires: number;
}

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  /** 'api-key' → x-api-key header (default), 'bearer' → Authorization: Bearer (OAuth) */
  authMode?: AuthMode;
  /** Only for 'compatible' provider — custom base URL */
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  maxIterations?: number;
  /** OAuth tokens for auto-refresh (bearer mode only) */
  oauthTokens?: OAuthTokens;
  /** Called when tokens are refreshed — persist to config */
  _onTokenRefresh?: (tokens: OAuthTokens) => void;
  /** Extended thinking (Anthropic only) — budget_tokens controls depth */
  thinking?: { enabled: boolean; budgetTokens?: number };
  /** MCP servers to include in API calls (Anthropic native MCP support) */
  mcpServers?: Array<{ type: 'url'; name: string; url: string; authorization_token?: string }>;
  /** Fallback provider config — used automatically by llmCall on 5xx/429/timeout */
  fallback?: LLMConfig;
}

export interface LLMImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
    data: string; // base64 string — never log this
  };
}

export interface LLMDocumentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: 'application/pdf';
    data: string;
  };
}

export type LLMContentBlock = { type: 'text'; text: string } | LLMImageBlock | LLMDocumentBlock;

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMContentBlock[];
}

export interface LLMResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  provider: LLMProvider;
}

// ─── Well-known model shortcuts ───────────────────────────────────────────────

export const MODELS = {
  // Anthropic
  CLAUDE_OPUS: 'claude-opus-4-6',
  CLAUDE_SONNET: 'claude-sonnet-4-6',
  CLAUDE_HAIKU: 'claude-haiku-4-5-20251001',
  // OpenAI
  GPT4O: 'gpt-4o',
  GPT4O_MINI: 'gpt-4o-mini',
  O1: 'o1',
  O3_MINI: 'o3-mini',
  // Common compatible
  MISTRAL_LARGE: 'mistral-large-latest',
  LLAMA3: 'llama3.2',
  // Alibaba Qwen
  QWEN_PLUS: 'qwen-plus',
  QWEN_TURBO: 'qwen-turbo',
  QWEN_MAX: 'qwen-max',
} as const;

// ─── Base URLs for well-known providers ──────────────────────────────────────

const PROVIDER_BASE_URLS: Record<string, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  xai: 'https://api.x.ai/v1',
  together: 'https://api.together.xyz/v1',
  perplexity: 'https://api.perplexity.ai',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
};

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  'anthropic-oauth': 'ANTHROPIC_AUTH_TOKEN',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  together: 'TOGETHER_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  cohere: 'COHERE_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
};

/**
 * Build an LLMConfig from the config file (primary) or environment variables (fallback).
 * Config file: ~/.argos/config.json → llm.activeProvider + llm.providers[key]
 * Env vars: LLM_PROVIDER_ID, LLM_MODEL, LLM_BASE_URL (legacy / override)
 */
export function llmConfigFromEnv(overrides: Partial<LLMConfig> = {}): LLMConfig {
  // Try reading from loaded config (set after loadConfig())
  try {
    // Dynamic import avoided — config injects into process.env at load time
  } catch {
    /* fallback to env */
  }

  const providerId = process.env.LLM_PROVIDER_ID ?? 'anthropic';
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LLMProvider;
  const model = process.env.LLM_MODEL ?? MODELS.CLAUDE_OPUS;
  const baseUrl = process.env.LLM_BASE_URL || PROVIDER_BASE_URLS[providerId];
  const envKey = PROVIDER_ENV_KEYS[providerId] ?? 'LLM_API_KEY';
  const apiKey = process.env[envKey] ?? process.env.LLM_API_KEY ?? '';
  const authMode: AuthMode = (process.env.LLM_AUTH_MODE as AuthMode) ?? 'api-key';

  return { provider, model, apiKey, authMode, baseUrl, ...overrides };
}

/**
 * Build LLMConfig directly from a config object (used at startup after loadConfig).
 */
type LlmCfgShape = {
  activeProvider: string;
  activeModel: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  providers: Record<
    string,
    {
      api?: string;
      auth?: string;
      apiKey?: string;
      baseUrl?: string;
      oauthAccess?: string;
      oauthRefresh?: string;
      oauthExpires?: number;
      models?: string[];
    }
  >;
};

function buildProviderConfig(
  providerKey: string,
  model: string,
  providers: LlmCfgShape['providers'],
): LLMConfig | null {
  const providerDef = providers[providerKey];
  if (!providerDef) return null;

  const provider: LLMProvider = providerDef.api === 'anthropic' ? 'anthropic' : 'compatible';
  const authMode: AuthMode = (providerDef.auth as AuthMode) ?? 'api-key';
  // oauthRefresh is optional — long-lived tokens (sk-ant-oat01-) don't need refresh
  const oauthTokens: OAuthTokens | undefined =
    providerDef.oauthAccess && providerDef.oauthExpires
      ? {
          access: providerDef.oauthAccess,
          refresh: providerDef.oauthRefresh ?? '', // empty for long-lived tokens
          expires: providerDef.oauthExpires,
        }
      : undefined;

  return {
    provider,
    model,
    apiKey: providerDef.oauthAccess ?? providerDef.apiKey ?? '',
    authMode,
    baseUrl: providerDef.baseUrl,
    oauthTokens,
  };
}

export function llmConfigFromConfig(
  cfg: { llm: LlmCfgShape },
  overrides: Partial<LLMConfig> = {},
): LLMConfig {
  const primary = buildProviderConfig(
    cfg.llm.activeProvider,
    cfg.llm.activeModel,
    cfg.llm.providers,
  );
  if (!primary) {
    log.warn(`LLM provider "${cfg.llm.activeProvider}" not found in config, falling back to env`);
    return llmConfigFromEnv(overrides);
  }

  // Build fallback config if configured — auto-used by llmCall on 5xx/429/timeout
  let fallback: LLMConfig | undefined;
  if (cfg.llm.fallbackProvider) {
    const fbModel =
      cfg.llm.fallbackModel ??
      (cfg.llm.providers[cfg.llm.fallbackProvider]?.models?.[0 as never] as string | undefined) ??
      primary.model;
    const fb = buildProviderConfig(cfg.llm.fallbackProvider, fbModel, cfg.llm.providers);
    if (fb) {
      fallback = fb;
      log.debug(`Fallback LLM configured: ${cfg.llm.fallbackProvider}/${fbModel}`);
    } else {
      log.warn(`Fallback provider "${cfg.llm.fallbackProvider}" not found in config — ignored`);
    }
  }

  return { ...primary, fallback, ...overrides };
}

// ─── Anthropic client ─────────────────────────────────────────────────────────

async function callAnthropic(config: LLMConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  // OAuth (Bearer) mode — use fetch directly since the SDK only supports x-api-key
  if (config.authMode === 'bearer') {
    return callAnthropicBearer(config, messages);
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.apiKey });

  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  const response = await client.messages.create({
    model: config.model,
    max_tokens: config.maxTokens ?? 4096,
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    // system is always a plain string for the SDK path
    ...(systemMsg && typeof systemMsg.content === 'string' && { system: systemMsg.content }),
    messages: nonSystem.map((m) => ({
      role: m.role as 'user' | 'assistant',
      // Pass array content directly (Anthropic SDK accepts image blocks natively)
      content: Array.isArray(m.content)
        ? (m.content as LLMContentBlock[]).map((b) =>
            b.type === 'image'
              ? { type: 'image' as const, source: b.source }
              : b.type === 'document'
                ? { type: 'document' as const, source: b.source }
                : { type: 'text' as const, text: b.text },
          )
        : m.content,
    })),
  });

  const content = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  return {
    content,
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    provider: 'anthropic',
  };
}

async function callAnthropicBearer(
  config: LLMConfig,
  messages: LLMMessage[],
): Promise<LLMResponse> {
  // Auto-refresh OAuth token if expired
  let accessToken = config.apiKey;
  if (config.oauthTokens) {
    const { getValidAccessToken } = await import('../auth/anthropic-oauth.js');
    accessToken = await getValidAccessToken(config.oauthTokens, (refreshed) => {
      config.oauthTokens = refreshed;
      config.apiKey = refreshed.access;
      config._onTokenRefresh?.(refreshed);
    });
  }

  // IMPORTANT: DO NOT use the Anthropic SDK for OAuth — it adds x-stainless-helper-method
  // headers that trigger a 400 from the API. Use raw fetch instead.
  // Required: user-agent claude-cli/2.1.75 | system prompt MUST be exact string as first block
  // Extra system context goes in a SECOND system block (appending to first block = 400)

  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  // First system block MUST be exact. Extra goes in second block (no cache_control).
  // Max 4 cache_control blocks total — use only on first system + last message.
  // First system block MUST be this exact string — OAuth token is validated against Claude Code's format
  const systemBlocks: Array<{ type: string; text: string; cache_control?: { type: string } }> = [
    {
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (systemMsg?.content) {
    // Argos system prompt goes in the SECOND block (no cache_control on this one)
    systemBlocks.push({ type: 'text', text: systemMsg.content as string });
  }

  // Only last message gets cache_control to stay under the 4-block limit
  // Filter out empty text messages (array messages with image blocks are never empty)
  const nonEmpty = nonSystem.filter((m) =>
    Array.isArray(m.content) ? m.content.length > 0 : (m.content as string)?.trim(),
  );
  const msgBodies = nonEmpty.map((m, i) => {
    const isLast = i === nonEmpty.length - 1;
    // Array content (multimodal) — pass through; add cache_control to last text block only
    if (Array.isArray(m.content)) {
      const blocks = (m.content as LLMContentBlock[]).map((b) =>
        b.type === 'image'
          ? { type: 'image' as const, source: b.source }
          : b.type === 'document'
            ? { type: 'document' as const, source: b.source }
            : { type: 'text' as const, text: b.text },
      );
      return { role: m.role, content: blocks };
    }
    return {
      role: m.role,
      content: [
        {
          type: 'text',
          text: (m.content as string) || '.',
          ...(isLast ? { cache_control: { type: 'ephemeral' } } : {}),
        },
      ],
    };
  });

  const isBearer2 = config.authMode === 'bearer' || config.oauthTokens !== undefined;
  const authHeaders2: Record<string, string> = isBearer2
    ? {
        authorization: `Bearer ${accessToken}`,
        'anthropic-dangerous-direct-browser-access': 'true',
        'user-agent': 'claude-cli/2.1.75',
        'x-app': 'cli',
      }
    : { 'x-api-key': accessToken };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders2,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': `claude-code-20250219,fine-grained-tool-streaming-2025-05-14,mcp-client-2025-04-04${isBearer2 ? ',oauth-2025-04-20' : ''}`,
      accept: 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      stream: true,
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      system: systemBlocks,
      messages: msgBodies,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic OAuth API error ${res.status}: ${errBody.slice(0, 300)}`);
  }

  // Parse SSE stream
  const sseBody = await res.text();
  let content = '';
  let model = config.model;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of sseBody.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const evt = JSON.parse(line.slice(6)) as Record<string, unknown>;
      if (evt.type === 'message_start') {
        const msg = evt.message as Record<string, unknown>;
        model = (msg.model as string) ?? model;
        const usage = msg.usage as Record<string, number>;
        if (usage)
          inputTokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
      } else if (evt.type === 'content_block_delta') {
        const delta = evt.delta as Record<string, string>;
        if (delta?.type === 'text_delta') content += delta.text ?? '';
      } else if (evt.type === 'message_delta') {
        const usage = (evt as Record<string, unknown>).usage as Record<string, number>;
        if (usage) outputTokens = usage.output_tokens ?? 0;
      }
    } catch {
      /* skip malformed SSE lines */
    }
  }

  return {
    content,
    model,
    inputTokens,
    outputTokens,
    provider: 'anthropic' as const,
  };
}

/**
 * Raw Anthropic OAuth call — returns parsed content blocks (text + tool_use).
 * Used by the tool-loop for multi-turn tool use.
 */
export async function callAnthropicBearerRaw(
  config: LLMConfig,
  body: Record<string, unknown>,
  onTextDelta?: (delta: string) => void,
): Promise<{
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
}> {
  let accessToken = config.apiKey;
  if (config.oauthTokens) {
    const { getValidAccessToken } = await import('../auth/anthropic-oauth.js');
    accessToken = await getValidAccessToken(config.oauthTokens, (refreshed) => {
      config.oauthTokens = refreshed;
      config.apiKey = refreshed.access;
    });
  }

  // OAuth tokens require the Claude Code system prompt — API validates against it
  const isOAuth = config.authMode === 'bearer' || config.oauthTokens !== undefined;
  const systemBlocks: Array<Record<string, unknown>> = isOAuth
    ? [
        {
          type: 'text',
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: 'ephemeral' },
        },
      ]
    : [];

  // Merge system from body if present
  const bodySystem = body.system;
  if (typeof bodySystem === 'string') {
    systemBlocks.push({
      type: 'text',
      text: bodySystem,
      ...(systemBlocks.length === 0 ? { cache_control: { type: 'ephemeral' } } : {}),
    });
  }
  delete body.system;

  // Ensure messages use cache_control format on last msg only
  // Filter out empty text messages (causes 400)
  const msgs = (body.messages as Array<Record<string, unknown>>).filter((m) => {
    if (typeof m.content === 'string' && !m.content.trim()) return false;
    return true;
  });
  const formattedMsgs = msgs.map((m, i) => {
    if (typeof m.content === 'string') {
      return {
        ...m,
        content: [
          {
            type: 'text',
            text: m.content || '.', // fallback to prevent empty block
            ...(i === msgs.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
          },
        ],
      };
    }
    return m; // already array format (tool_result blocks etc.)
  });

  // Support both OAuth Bearer tokens and regular API keys
  const isBearer = config.authMode === 'bearer' || config.oauthTokens !== undefined;
  const authHeaders: Record<string, string> = isBearer
    ? {
        authorization: `Bearer ${accessToken}`,
        'anthropic-dangerous-direct-browser-access': 'true',
        'user-agent': 'claude-cli/2.1.75',
        'x-app': 'cli',
      }
    : { 'x-api-key': accessToken };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': `claude-code-20250219,fine-grained-tool-streaming-2025-05-14,mcp-client-2025-04-04${isBearer ? ',oauth-2025-04-20' : ''}`,
      accept: 'application/json',
    },
    body: JSON.stringify({
      ...body,
      system: systemBlocks,
      messages: formattedMsgs,
      stream: true,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errBody.slice(0, 300)}`);
  }

  // Parse SSE in streaming fashion — process events as they arrive
  const content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }> = [];
  let stopReason = 'end_turn';
  let model = config.model;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const evt of _readSseJson(res)) {
    if (evt.type === 'message_start') {
      const msg = evt.message as Record<string, unknown>;
      model = (msg.model as string) ?? model;
      const usage = msg.usage as Record<string, number>;
      if (usage)
        inputTokens =
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);
    } else if (evt.type === 'content_block_start') {
      const block = evt.content_block as Record<string, unknown>;
      if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id as string,
          name: block.name as string,
          input: {},
        });
      } else {
        content.push({ type: 'text', text: '' });
      }
    } else if (evt.type === 'content_block_delta') {
      const delta = evt.delta as Record<string, unknown>;
      const last = content[content.length - 1];
      if (delta?.type === 'text_delta' && last?.type === 'text') {
        const text = delta.text as string;
        last.text = (last.text ?? '') + text;
        if (onTextDelta && text) onTextDelta(text);
      } else if (delta?.type === 'input_json_delta' && last?.type === 'tool_use') {
        const partial = (last as unknown as Record<string, string>)._partialJson ?? '';
        (last as unknown as Record<string, string>)._partialJson =
          partial + (delta.partial_json as string);
      }
    } else if (evt.type === 'content_block_stop') {
      const last = content[content.length - 1];
      if (last?.type === 'tool_use' && (last as unknown as Record<string, string>)._partialJson) {
        try {
          last.input = JSON.parse((last as unknown as Record<string, string>)._partialJson);
        } catch {
          /* malformed */
        }
        delete (last as unknown as Record<string, string>)._partialJson;
      }
    } else if (evt.type === 'message_delta') {
      const delta = evt.delta as Record<string, string>;
      if (delta?.stop_reason) stopReason = delta.stop_reason;
      const usage = (evt as Record<string, unknown>).usage as Record<string, number>;
      if (usage) outputTokens = usage.output_tokens ?? 0;
    }
  }

  // Clean up any leftover _partialJson fields (must not be sent back to API)
  for (const block of content) {
    delete (block as Record<string, unknown>)._partialJson;
  }

  return {
    content,
    stop_reason: stopReason,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    model,
  };
}

// ─── OpenAI / compatible client ───────────────────────────────────────────────

async function callOpenAICompat(config: LLMConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  const baseURL = config.baseUrl ?? 'https://api.openai.com/v1';

  // Convert Anthropic-format image blocks to OpenAI image_url format for non-system messages
  const mappedMessages = messages.map((m) => {
    if (Array.isArray(m.content)) {
      return {
        role: m.role,
        content: (m.content as LLMContentBlock[]).map((b) =>
          b.type === 'image'
            ? {
                type: 'image_url' as const,
                image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
              }
            : b.type === 'document'
              ? {
                  type: 'text' as const,
                  text: '[PDF document attached — not supported by this provider]',
                }
              : { type: 'text' as const, text: b.text },
        ),
      };
    }
    return m;
  });

  const body = {
    model: config.model,
    messages: mappedMessages,
    max_tokens: config.maxTokens ?? 4096,
    ...(config.temperature !== undefined && { temperature: config.temperature }),
  };

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string; reasoning?: string } }>;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  // Some models (Qwen) put the answer in content and thinking in reasoning.
  // If content is empty but reasoning exists, use reasoning as fallback.
  const msg = data.choices[0]?.message;
  const content = msg?.content || msg?.reasoning || '';

  return {
    content,
    model: data.model,
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens,
    provider: config.provider,
  };
}

// ─── Provider-agnostic tool use ──────────────────────────────────────────────
//
// Supports Anthropic tool format AND OpenAI-compatible tool format (OpenAI,
// Groq, Ollama + any model with function calling).
//
// Usage:
//   const messages: unknown[] = [{ role: 'user', content: prompt }];
//   while (true) {
//     const step = await callWithTools(cfg, system, messages, tools);
//     // handle step.toolCalls ...
//     if (step.done) break;
//     messages.push(...buildToolResultMessages(cfg, step._rawAssistant, feedbacks));
//   }

export interface NormalizedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolStepResult {
  text: string;
  toolCalls: NormalizedToolCall[];
  /** true = LLM stopped tool-calling, loop should end */
  done: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Opaque — pass as-is to buildToolResultMessages */
  _rawAssistant: unknown;
}

/** Call LLM with tool use. Tools always passed in Anthropic format — converted internally for OpenAI. */
export async function callWithTools(
  config: LLMConfig,
  system: string,
  messages: unknown[],
  tools: Array<{ name: string; description: string; input_schema: unknown }>,
): Promise<ToolStepResult> {
  if (config.provider === 'anthropic') {
    return _callAnthropicWithTools(config, system, messages, tools);
  }
  return _callOpenAIWithTools(config, system, messages, tools);
}

/** Build messages to append after a tool step (provider-specific format). */
export function buildToolResultMessages(
  config: LLMConfig,
  rawAssistant: unknown,
  results: Array<{ id: string; content: string }>,
): unknown[] {
  if (config.provider === 'anthropic') {
    const blocks = results.map((r) => ({
      type: 'tool_result',
      tool_use_id: r.id,
      content: r.content,
    }));
    return [
      { role: 'assistant', content: rawAssistant },
      { role: 'user', content: blocks },
    ];
  }
  // OpenAI: assistant message (with tool_calls) + individual tool messages
  const toolMessages = results.map((r) => ({
    role: 'tool',
    tool_call_id: r.id,
    content: r.content,
  }));
  return [rawAssistant as Record<string, unknown>, ...toolMessages];
}

// ─── Anthropic tool step ─────────────────────────────────────────────────────

async function _callAnthropicWithTools(
  config: LLMConfig,
  system: string,
  messages: unknown[],
  tools: Array<{ name: string; description: string; input_schema: unknown }>,
): Promise<ToolStepResult> {
  const body = {
    model: config.model,
    max_tokens: config.maxTokens ?? 4096,
    // Extended thinking: temperature must be omitted when enabled (Anthropic requirement)
    ...(config.thinking?.enabled
      ? { thinking: { type: 'enabled', budget_tokens: config.thinking.budgetTokens ?? 1024 } }
      : config.temperature !== undefined
        ? { temperature: config.temperature }
        : {}),
    system,
    tools,
    messages,
  };

  const { default: AnthropicSDK } = await import('@anthropic-ai/sdk');
  const raw =
    config.authMode === 'bearer'
      ? await callAnthropicBearerRaw(config, body as Record<string, unknown>)
      : await new AnthropicSDK({ apiKey: config.apiKey }).messages.create(
          body as unknown as Parameters<InstanceType<typeof AnthropicSDK>['messages']['create']>[0],
        );

  const content = (
    raw as {
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
    }
  ).content;
  const stopReason = (raw as { stop_reason: string }).stop_reason;
  const usage = (raw as { usage: { input_tokens: number; output_tokens: number } }).usage;

  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const toolCalls: NormalizedToolCall[] = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id!, name: b.name!, input: (b.input ?? {}) as Record<string, unknown> }));

  return {
    text,
    toolCalls,
    done: stopReason !== 'tool_use',
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    _rawAssistant: content,
  };
}

// ─── OpenAI-compatible tool step ─────────────────────────────────────────────

async function _callOpenAIWithTools(
  config: LLMConfig,
  system: string,
  messages: unknown[],
  tools: Array<{ name: string; description: string; input_schema: unknown }>,
): Promise<ToolStepResult> {
  const openAITools = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  // System prompt as first message — not stored in history between iterations
  const allMessages = [{ role: 'system', content: system }, ...messages];

  const baseURL = config.baseUrl ?? 'https://api.openai.com/v1';
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      tools: openAITools,
      tool_choice: 'auto',
      messages: allMessages,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI tool call error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices: Array<{
      message: {
        role: string;
        content: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
      finish_reason: string;
    }>;
    usage: { prompt_tokens: number; completion_tokens: number };
    model: string;
  };

  const message = data.choices[0].message;
  const finishReason = data.choices[0].finish_reason;

  const toolCalls: NormalizedToolCall[] = (message.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: (() => {
      try {
        return JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        return {};
      }
    })(),
  }));

  return {
    text: message.content ?? '',
    toolCalls,
    done: finishReason !== 'tool_calls',
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens,
    _rawAssistant: {
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: message.tool_calls ?? [],
    },
  };
}

// ─── Main call function ───────────────────────────────────────────────────────

async function callProvider(config: LLMConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  switch (config.provider) {
    case 'anthropic':
      return callAnthropic(config, messages);
    case 'openai':
    case 'compatible':
      return callOpenAICompat(config, messages);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}

/** Whether the error is retryable (server error, timeout, network, rate limit, auth refresh) */
function isRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b(5\d\d|429|401|403|rate.limit|timeout|overloaded|ECONNREFUSED|ECONNRESET|ETIMEDOUT|oauth|token.*expired|token.*refresh)/i.test(
    msg,
  );
}

/** Retry fn up to maxAttempts times with exponential backoff on retryable errors. */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 1000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isRetryableError(e) || attempt === maxAttempts - 1) throw e;
      const delay = baseDelayMs * 2 ** attempt; // 1s → 2s → 4s
      log.warn(
        `LLM call failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delay}ms — ${(e as Error).message}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export async function llmCall(
  config: LLMConfig,
  messages: LLMMessage[],
  fallbackConfig?: LLMConfig,
): Promise<LLMResponse> {
  // Use embedded fallback if no explicit one passed
  const effectiveFallback = fallbackConfig ?? config.fallback;
  log.debug(
    `Calling ${config.provider}/${config.model}${effectiveFallback ? ` (fallback: ${effectiveFallback.provider}/${effectiveFallback.model})` : ''}`,
    {
      messages: messages.length,
      maxTokens: config.maxTokens,
    },
  );

  const start = Date.now();

  const run = async () => {
    try {
      const response = await withRetry(() => callProvider(config, messages));
      log.debug(`LLM response in ${Date.now() - start}ms`, {
        model: response.model,
        tokens: `${response.inputTokens}in / ${response.outputTokens}out`,
      });
      return response;
    } catch (e) {
      if (effectiveFallback && isRetryableError(e)) {
        log.warn(
          `Primary LLM failed (${(e as Error).message}), falling back to ${effectiveFallback.provider}/${effectiveFallback.model}`,
        );
        const response = await withRetry(() => callProvider(effectiveFallback, messages));
        log.debug(`Fallback LLM response in ${Date.now() - start}ms`, {
          model: response.model,
          tokens: `${response.inputTokens}in / ${response.outputTokens}out`,
        });
        return response;
      }
      throw e;
    }
  };

  return config.authMode === 'bearer' ? withBearerQueue(run) : run();
}

// ─── Streaming helpers ────────────────────────────────────────────────────────

/**
 * Shared SSE reader — yields parsed JSON objects from a streaming fetch response.
 * Stops on `[DONE]` or when the stream ends.
 */
export async function* _readSseJson(response: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data) as Record<string, unknown>;
      } catch {
        /* skip malformed lines */
      }
    }
  }
}

/**
 * Stream Anthropic OAuth (bearer) response — yields text chunks as they arrive.
 */
async function* _streamAnthropicBearer(
  config: LLMConfig,
  messages: LLMMessage[],
): AsyncGenerator<string> {
  // Auto-refresh OAuth token if needed
  let accessToken = config.apiKey;
  if (config.oauthTokens) {
    const { getValidAccessToken } = await import('../auth/anthropic-oauth.js');
    accessToken = await getValidAccessToken(config.oauthTokens, (refreshed) => {
      config.oauthTokens = refreshed;
      config.apiKey = refreshed.access;
      config._onTokenRefresh?.(refreshed);
    });
  }

  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  const systemBlocks: Array<{ type: string; text: string; cache_control?: { type: string } }> = [
    {
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (systemMsg?.content) {
    systemBlocks.push({ type: 'text', text: systemMsg.content as string });
  }

  const nonEmpty = nonSystem.filter((m) =>
    Array.isArray(m.content) ? m.content.length > 0 : (m.content as string)?.trim(),
  );
  const msgBodies = nonEmpty.map((m, i) => {
    const isLast = i === nonEmpty.length - 1;
    if (Array.isArray(m.content)) {
      const blocks = (m.content as LLMContentBlock[]).map((b) =>
        b.type === 'image'
          ? { type: 'image' as const, source: b.source }
          : b.type === 'document'
            ? { type: 'document' as const, source: b.source }
            : { type: 'text' as const, text: b.text },
      );
      return { role: m.role, content: blocks };
    }
    return {
      role: m.role,
      content: [
        {
          type: 'text',
          text: (m.content as string) || '.',
          ...(isLast ? { cache_control: { type: 'ephemeral' } } : {}),
        },
      ],
    };
  });

  const isBearer3 = config.authMode === 'bearer' || config.oauthTokens !== undefined;
  const authHeaders3: Record<string, string> = isBearer3
    ? {
        authorization: `Bearer ${accessToken}`,
        'anthropic-dangerous-direct-browser-access': 'true',
        'user-agent': 'claude-cli/2.1.75',
        'x-app': 'cli',
      }
    : { 'x-api-key': accessToken };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders3,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': `claude-code-20250219,fine-grained-tool-streaming-2025-05-14,mcp-client-2025-04-04${isBearer3 ? ',oauth-2025-04-20' : ''}`,
      accept: 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      stream: true,
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      system: systemBlocks,
      messages: msgBodies,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic OAuth streaming error ${res.status}: ${errBody.slice(0, 300)}`);
  }

  for await (const evt of _readSseJson(res)) {
    if (evt.type === 'content_block_delta') {
      const delta = evt.delta as Record<string, string>;
      if (delta?.type === 'text_delta' && delta.text) {
        yield delta.text;
      }
    } else if (evt.type === 'message_stop') {
      return;
    }
  }
}

/**
 * Stream OpenAI-compatible response — yields text chunks as they arrive.
 */
async function* _streamOpenAICompat(
  config: LLMConfig,
  messages: LLMMessage[],
): AsyncGenerator<string> {
  const baseURL = config.baseUrl ?? 'https://api.openai.com/v1';

  const mappedMessages = messages.map((m) => {
    if (Array.isArray(m.content)) {
      return {
        role: m.role,
        content: (m.content as LLMContentBlock[]).map((b) =>
          b.type === 'image'
            ? {
                type: 'image_url' as const,
                image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
              }
            : b.type === 'document'
              ? {
                  type: 'text' as const,
                  text: '[PDF document attached — not supported by this provider]',
                }
              : { type: 'text' as const, text: b.text },
        ),
      };
    }
    return m;
  });

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: mappedMessages,
      max_tokens: config.maxTokens ?? 4096,
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      stream: true,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI streaming error ${res.status}: ${errBody.slice(0, 300)}`);
  }

  for await (const parsed of _readSseJson(res)) {
    const choices = parsed.choices as Array<{ delta: { content?: string | null } }> | undefined;
    const text = choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}

/**
 * Stream LLM response as text chunks.
 * Supported: Anthropic bearer (SSE) and OpenAI-compatible (SSE).
 * For providers without streaming support, yields the full response as one chunk.
 */
export async function* streamLlmResponse(
  config: LLMConfig,
  messages: LLMMessage[],
): AsyncGenerator<string> {
  if (config.provider === 'anthropic' && config.authMode === 'bearer') {
    yield* _streamAnthropicBearer(config, messages);
    return;
  }
  if (config.provider === 'compatible' || config.provider === 'openai') {
    yield* _streamOpenAICompat(config, messages);
    return;
  }
  // Fallback: non-streaming Anthropic SDK path — yield full response as one chunk
  const response = await llmCall(config, messages);
  yield response.content;
}

// ─── JSON extraction helper ───────────────────────────────────────────────────
// Claude and GPT sometimes wrap JSON in markdown — strip it

export function extractJson<T>(content: string): T {
  // Try direct parse first
  try {
    return JSON.parse(content) as T;
  } catch {}

  // Strip markdown code fence
  const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match?.[1]) {
    try {
      return JSON.parse(match[1].trim()) as T;
    } catch {}
  }

  // Try to find first { or [ and extract from there
  const start = content.search(/[{[]/);
  if (start !== -1) {
    try {
      return JSON.parse(content.slice(start)) as T;
    } catch {}
  }

  throw new Error(`Could not extract JSON from LLM response: ${content.slice(0, 200)}`);
}
