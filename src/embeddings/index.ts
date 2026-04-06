/**
 * Embedding provider — converts text to dense vector representations.
 *
 * Supported backends (OpenAI-compatible /v1/embeddings endpoint):
 *   - Ollama:    http://localhost:11434  (nomic-embed-text, mxbai-embed-large)
 *   - LM Studio: http://localhost:1234
 *   - Any OpenAI-compatible remote API
 *
 * nomic-embed-text is recommended:
 *   - 137M params, fast on CPU/GPU
 *   - 768-dim vectors, strong on retrieval tasks
 *   - ollama pull nomic-embed-text
 */

import { createLogger } from '../logger.js';
import type { EmbeddingsConfig } from '../config/schema.js';

const log = createLogger('embeddings');

// ─── Core embed call ──────────────────────────────────────────────────────────

/**
 * Embed a single text string. Returns a Float32Array of the embedding vector.
 */
export async function embed(text: string, config: EmbeddingsConfig): Promise<Float32Array> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/v1/embeddings`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.model, input: text }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  const vec = data.data[0]?.embedding;
  if (!vec?.length) throw new Error('Embedding API returned empty vector');

  return new Float32Array(vec);
}

/**
 * Embed multiple texts sequentially (avoids overwhelming Ollama).
 */
export async function embedBatch(
  texts: string[],
  config: EmbeddingsConfig,
): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (const text of texts) {
    results.push(await embed(text, config));
  }
  return results;
}

// ─── Math ─────────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── SQLite serialization ─────────────────────────────────────────────────────

export function serializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer);
}

export function deserializeEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ─── Health check ─────────────────────────────────────────────────────────────

export async function checkEmbeddingModel(config: EmbeddingsConfig): Promise<boolean> {
  try {
    await embed('test', config);
    log.info(`Embedding model ready: ${config.model} @ ${config.baseUrl}`);
    return true;
  } catch (e) {
    log.warn(`Embedding model unavailable (${config.model}): ${e}`);
    return false;
  }
}
