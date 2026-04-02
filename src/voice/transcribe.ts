import { createLogger } from '../logger.js';

const log = createLogger('voice');

export interface VoiceConfig {
  whisperEndpoint?: string;  // default: https://api.openai.com/v1
  whisperApiKey?: string;
  whisperModel?: string;     // default: whisper-1
}

/**
 * Transcribe audio bytes via OpenAI Whisper API (or compatible endpoint).
 * Supports OGG/OPUS (Telegram native), MP3, MP4, WebM.
 * Audio bytes are NEVER persisted — processed in memory only.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,    // e.g. 'voice.ogg' — Whisper uses extension to detect format
  config: VoiceConfig,
): Promise<string> {
  const endpoint = config.whisperEndpoint ?? 'https://api.openai.com/v1';
  const apiKey   = config.whisperApiKey;
  const model    = config.whisperModel ?? 'whisper-1';

  if (!apiKey) throw new Error('whisperApiKey is required for voice transcription');
  if (audioBuffer.length > 25 * 1024 * 1024) throw new Error('Audio file too large (max 25MB)');

  // Use FormData with Blob — works in Node 18+ without extra packages
  const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
  const formData = new globalThis.FormData();
  formData.append('file', blob, filename);
  formData.append('model', model);
  formData.append('response_format', 'text');

  log.debug(`Transcribing ${audioBuffer.length} bytes via ${endpoint}`);

  const res = await fetch(`${endpoint}/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Whisper API error ${res.status}: ${text.slice(0, 200)}`);
  }

  return (await res.text()).trim();
}
