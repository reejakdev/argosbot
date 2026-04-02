import { createLogger } from '../logger.js';

const log = createLogger('voice-tts');

export interface TtsConfig {
  ttsProvider?: 'openai' | 'elevenlabs';
  openAiTtsApiKey?: string;
  openAiTtsModel?: string;   // default: tts-1
  openAiTtsVoice?: string;   // default: onyx
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
}

/**
 * Synthesize text to speech. Returns MP3 bytes.
 * Supported providers: OpenAI TTS, ElevenLabs.
 * Audio bytes are NEVER persisted — caller is responsible for ephemeral use.
 */
export async function synthesizeSpeech(
  text: string,
  config: TtsConfig,
): Promise<Buffer> {
  const provider = config.ttsProvider ?? 'openai';

  if (provider === 'openai') {
    const apiKey = config.openAiTtsApiKey;
    if (!apiKey) throw new Error('openAiTtsApiKey required for TTS');

    log.debug(`TTS via OpenAI (${config.openAiTtsModel ?? 'tts-1'}, voice: ${config.openAiTtsVoice ?? 'onyx'})`);

    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openAiTtsModel ?? 'tts-1',
        voice: config.openAiTtsVoice ?? 'onyx',
        input: text.slice(0, 4096), // OpenAI TTS max
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI TTS error ${res.status}: ${t.slice(0, 200)}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }

  if (provider === 'elevenlabs') {
    const apiKey  = config.elevenLabsApiKey;
    const voiceId = config.elevenLabsVoiceId ?? '21m00Tcm4TlvDq8ikWAM'; // default Rachel voice

    if (!apiKey) throw new Error('elevenLabsApiKey required');

    log.debug(`TTS via ElevenLabs (voiceId: ${voiceId})`);

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text.slice(0, 5000),
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`ElevenLabs TTS error ${res.status}: ${t.slice(0, 200)}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }

  throw new Error(`Unknown TTS provider: ${provider}`);
}
