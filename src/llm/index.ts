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
  const next = _bearerQueue.then(() => fn(), () => fn());
  _bearerQueue = next.then(() => {}, () => {});
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
  /** OAuth tokens for auto-refresh (bearer mode only) */
  oauthTokens?: OAuthTokens;
  /** Called when tokens are refreshed — persist to config */
  _onTokenRefresh?: (tokens: OAuthTokens) => void;
  /** MCP servers to include in API calls (Anthropic native MCP support) */
  mcpServers?: Array<{ type: 'url'; name: string; url: string; authorization_token?: string }>;
  /** Fallback provider config — used automatically by llmCall on 5xx/429/timeout */
  fallback?: LLMConfig;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
  CLAUDE_OPUS:    'claude-opus-4-6',
  CLAUDE_SONNET:  'claude-sonnet-4-6',
  CLAUDE_HAIKU:   'claude-haiku-4-5-20251001',
  // OpenAI
  GPT4O:          'gpt-4o',
  GPT4O_MINI:     'gpt-4o-mini',
  O1:             'o1',
  O3_MINI:        'o3-mini',
  // Common compatible
  MISTRAL_LARGE:  'mistral-large-latest',
  LLAMA3:         'llama3.2',
  // Alibaba Qwen
  QWEN_PLUS:      'qwen-plus',
  QWEN_TURBO:     'qwen-turbo',
  QWEN_MAX:       'qwen-max',
} as const;

// ─── Base URLs for well-known providers ──────────────────────────────────────

const PROVIDER_BASE_URLS: Record<string, string> = {
  gemini:     'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral:    'https://api.mistral.ai/v1',
  groq:       'https://api.groq.com/openai/v1',
  deepseek:   'https://api.deepseek.com/v1',
  xai:        'https://api.x.ai/v1',
  together:   'https://api.together.xyz/v1',
  perplexity: 'https://api.perplexity.ai',
  cohere:     'https://api.cohere.ai/compatibility/v1',
  qwen:       'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  ollama:     'http://localhost:11434/v1',
  lmstudio:   'http://localhost:1234/v1',
};

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic:          'ANTHROPIC_API_KEY',
  'anthropic-oauth':  'ANTHROPIC_AUTH_TOKEN',
  openai:     'OPENAI_API_KEY',
  gemini:     'GEMINI_API_KEY',
  mistral:    'MISTRAL_API_KEY',
  groq:       'GROQ_API_KEY',
  deepseek:   'DEEPSEEK_API_KEY',
  xai:        'XAI_API_KEY',
  together:   'TOGETHER_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  cohere:     'COHERE_API_KEY',
  qwen:       'DASHSCOPE_API_KEY',
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
  } catch { /* fallback to env */ }

  const providerId = process.env.LLM_PROVIDER_ID ?? 'anthropic';
  const provider   = (process.env.LLM_PROVIDER ?? 'anthropic') as LLMProvider;
  const model      = process.env.LLM_MODEL ?? MODELS.CLAUDE_OPUS;
  const baseUrl    = process.env.LLM_BASE_URL || PROVIDER_BASE_URLS[providerId];
  const envKey     = PROVIDER_ENV_KEYS[providerId] ?? 'LLM_API_KEY';
  const apiKey     = process.env[envKey] ?? process.env.LLM_API_KEY ?? '';
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
  providers: Record<string, {
    api?: string; auth?: string; apiKey?: string; baseUrl?: string;
    oauthAccess?: string; oauthRefresh?: string; oauthExpires?: number;
    models?: string[];
  }>;
};

function buildProviderConfig(
  providerKey: string,
  model: string,
  providers: LlmCfgShape['providers'],
): LLMConfig | null {
  const providerDef = providers[providerKey];
  if (!providerDef) return null;

  const provider: LLMProvider = providerDef.api === 'anthropic' ? 'anthropic' : 'compatible';
  const authMode: AuthMode    = (providerDef.auth as AuthMode) ?? 'api-key';
  const oauthTokens: OAuthTokens | undefined =
    providerDef.oauthAccess && providerDef.oauthRefresh && providerDef.oauthExpires
      ? { access: providerDef.oauthAccess, refresh: providerDef.oauthRefresh, expires: providerDef.oauthExpires }
      : undefined;

  return {
    provider,
    model,
    apiKey:  providerDef.oauthAccess ?? providerDef.apiKey ?? '',
    authMode,
    baseUrl: providerDef.baseUrl,
    oauthTokens,
  };
}

export function llmConfigFromConfig(cfg: { llm: LlmCfgShape }, overrides: Partial<LLMConfig> = {}): LLMConfig {
  const primary = buildProviderConfig(cfg.llm.activeProvider, cfg.llm.activeModel, cfg.llm.providers);
  if (!primary) {
    log.warn(`LLM provider "${cfg.llm.activeProvider}" not found in config, falling back to env`);
    return llmConfigFromEnv(overrides);
  }

  // Build fallback config if configured — auto-used by llmCall on 5xx/429/timeout
  let fallback: LLMConfig | undefined;
  if (cfg.llm.fallbackProvider) {
    const fbModel = cfg.llm.fallbackModel
      ?? cfg.llm.providers[cfg.llm.fallbackProvider]?.models?.[0 as never] as string | undefined
      ?? primary.model;
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

async function callAnthropic(
  config: LLMConfig,
  messages: LLMMessage[],
): Promise<LLMResponse> {
  // OAuth (Bearer) mode — use fetch directly since the SDK only supports x-api-key
  if (config.authMode === 'bearer') {
    return callAnthropicBearer(config, messages);
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.apiKey });

  const systemMsg = messages.find(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  const response = await client.messages.create({
    model: config.model,
    max_tokens: config.maxTokens ?? 4096,
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    ...(systemMsg && { system: systemMsg.content }),
    messages: nonSystem.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  });

  const content = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
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

  const systemMsg = messages.find(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  // First system block MUST be exact. Extra goes in second block (no cache_control).
  // Max 4 cache_control blocks total — use only on first system + last message.
  const systemBlocks: Array<{ type: string; text: string; cache_control?: { type: string } }> = [
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } },
  ];
  if (systemMsg?.content) {
    systemBlocks.push({ type: 'text', text: systemMsg.content });
  }

  // Only last message gets cache_control to stay under the 4-block limit
  // Filter out empty messages
  const nonEmpty = nonSystem.filter(m => m.content?.trim());
  const msgBodies = nonEmpty.map((m, i) => ({
    role: m.role,
    content: [{
      type: 'text',
      text: m.content || '.',
      ...(i === nonEmpty.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    }],
  }));

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,mcp-client-2025-04-04',
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'claude-cli/2.1.75',
      'x-app': 'cli',
      'accept': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      stream: true,
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      system: systemBlocks,
      messages: msgBodies,
      // MCP servers are handled locally (not via API mcp_servers — Anthropic can't reach localhost)
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
        if (usage) inputTokens = usage.input_tokens ?? 0;
      } else if (evt.type === 'content_block_delta') {
        const delta = evt.delta as Record<string, string>;
        if (delta?.type === 'text_delta') content += delta.text ?? '';
      } else if (evt.type === 'message_delta') {
        const usage = (evt as Record<string, unknown>).usage as Record<string, number>;
        if (usage) outputTokens = usage.output_tokens ?? 0;
      }
    } catch { /* skip malformed SSE lines */ }
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
): Promise<{
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
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

  const systemBlocks: Array<Record<string, unknown>> = [
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } },
  ];

  // Merge system from body if present
  const bodySystem = body.system;
  if (typeof bodySystem === 'string') {
    systemBlocks.push({ type: 'text', text: bodySystem });
  }
  delete body.system;

  // Ensure messages use cache_control format on last msg only
  // Filter out empty text messages (causes 400)
  const msgs = (body.messages as Array<Record<string, unknown>>)
    .filter(m => {
      if (typeof m.content === 'string' && !m.content.trim()) return false;
      return true;
    });
  const formattedMsgs = msgs.map((m, i) => {
    if (typeof m.content === 'string') {
      return {
        ...m,
        content: [{
          type: 'text',
          text: m.content || '.',  // fallback to prevent empty block
          ...(i === msgs.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
        }],
      };
    }
    return m; // already array format (tool_result blocks etc.)
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,mcp-client-2025-04-04',
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'claude-cli/2.1.75',
      'x-app': 'cli',
      'accept': 'application/json',
    },
    body: JSON.stringify({
      ...body,
      system: systemBlocks,
      messages: formattedMsgs,
      stream: true,
      // MCP servers are handled locally (not via API mcp_servers — Anthropic can't reach localhost)
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errBody.slice(0, 300)}`);
  }

  // Parse SSE — collect all content blocks
  const sseBody = await res.text();
  const content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> = [];
  let currentBlock: Record<string, unknown> | null = null;
  let stopReason = 'end_turn';
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
        if (usage) inputTokens = usage.input_tokens ?? 0;
      } else if (evt.type === 'content_block_start') {
        currentBlock = evt.content_block as Record<string, unknown>;
        if (currentBlock.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: currentBlock.id as string,
            name: currentBlock.name as string,
            input: {},
          });
        } else {
          content.push({ type: 'text', text: '' });
        }
      } else if (evt.type === 'content_block_delta') {
        const delta = evt.delta as Record<string, unknown>;
        const last = content[content.length - 1];
        if (delta?.type === 'text_delta' && last?.type === 'text') {
          last.text = (last.text ?? '') + (delta.text as string);
        } else if (delta?.type === 'input_json_delta' && last?.type === 'tool_use') {
          const partial = (last as unknown as Record<string, string>)._partialJson ?? '';
          (last as unknown as Record<string, string>)._partialJson = partial + (delta.partial_json as string);
        }
      } else if (evt.type === 'content_block_stop') {
        const last = content[content.length - 1];
        if (last?.type === 'tool_use' && (last as unknown as Record<string, string>)._partialJson) {
          try {
            last.input = JSON.parse((last as unknown as Record<string, string>)._partialJson);
          } catch { /* malformed */ }
          delete (last as unknown as Record<string, string>)._partialJson;
        }
        currentBlock = null;
      } else if (evt.type === 'message_delta') {
        const delta = evt.delta as Record<string, string>;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        const usage = (evt as Record<string, unknown>).usage as Record<string, number>;
        if (usage) outputTokens = usage.output_tokens ?? 0;
      }
    } catch { /* skip */ }
  }

  // Clean up any leftover _partialJson fields (must not be sent back to API)
  for (const block of content) {
    delete (block as Record<string, unknown>)._partialJson;
  }

  return { content, stop_reason: stopReason, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, model };
}

// ─── OpenAI / compatible client ───────────────────────────────────────────────

async function callOpenAICompat(
  config: LLMConfig,
  messages: LLMMessage[],
): Promise<LLMResponse> {
  const baseURL = config.baseUrl ?? 'https://api.openai.com/v1';

  const body = {
    model: config.model,
    messages,
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

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: data.choices[0]?.message.content ?? '',
    model: data.model,
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens,
    provider: config.provider,
  };
}

// ─── Main call function ───────────────────────────────────────────────────────

async function callProvider(
  config: LLMConfig,
  messages: LLMMessage[],
): Promise<LLMResponse> {
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

/** Whether the error is retryable (server error, rate limit, timeout, network) */
function isRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b(5\d\d|429|rate.limit|timeout|overloaded|ECONNREFUSED)/i.test(msg);
}

/** Retry fn up to maxAttempts times with exponential backoff on retryable errors. */
async function withRetry<T>(
  fn:           () => Promise<T>,
  maxAttempts:  number = 3,
  baseDelayMs:  number = 1000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isRetryableError(e) || attempt === maxAttempts - 1) throw e;
      const delay = baseDelayMs * (2 ** attempt); // 1s → 2s → 4s
      log.warn(`LLM call failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delay}ms — ${(e as Error).message}`);
      await new Promise(r => setTimeout(r, delay));
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
  log.debug(`Calling ${config.provider}/${config.model}${effectiveFallback ? ` (fallback: ${effectiveFallback.provider}/${effectiveFallback.model})` : ''}`, {
    messages: messages.length,
    maxTokens: config.maxTokens,
  });

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
        log.warn(`Primary LLM failed (${(e as Error).message}), falling back to ${effectiveFallback.provider}/${effectiveFallback.model}`);
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

// ─── JSON extraction helper ───────────────────────────────────────────────────
// Claude and GPT sometimes wrap JSON in markdown — strip it

export function extractJson<T>(content: string): T {
  // Try direct parse first
  try { return JSON.parse(content) as T; } catch {}

  // Strip markdown code fence
  const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match?.[1]) {
    try { return JSON.parse(match[1].trim()) as T; } catch {}
  }

  // Try to find first { or [ and extract from there
  const start = content.search(/[{[]/);
  if (start !== -1) {
    try { return JSON.parse(content.slice(start)) as T; } catch {}
  }

  throw new Error(`Could not extract JSON from LLM response: ${content.slice(0, 200)}`);
}
