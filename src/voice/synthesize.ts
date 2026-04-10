import { createLogger } from '../logger.js';
import { spawn } from 'child_process';
import { readFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { platform } from 'process';

const log = createLogger('voice-tts');

/** Default macOS `say` voice per language */
const SAY_VOICES: Record<string, string> = {
  fr: 'Thomas', en: 'Samantha', es: 'Monica', de: 'Anna',
  it: 'Alice', pt: 'Luciana', ja: 'Kyoko', zh: 'Ting-Ting',
};

export interface TtsConfig {
  ttsProvider?: 'openai' | 'elevenlabs' | 'local';
  openAiTtsApiKey?: string;
  openAiTtsModel?: string; // default: tts-1
  openAiTtsVoice?: string; // default: onyx
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  localTtsVoice?: string; // macOS: explicit voice name (overrides ttsLanguage)
  ttsLanguage?: string;   // 'fr', 'en', etc. — auto-selects voice
}

/** Resolve the voice name for local TTS: explicit > language default > system default */
function resolveLocalVoice(config: TtsConfig): string | undefined {
  if (config.localTtsVoice) return config.localTtsVoice;
  const lang = config.ttsLanguage ?? 'fr';
  return SAY_VOICES[lang];
}

/**
 * Synthesize text to speech. Returns MP3 bytes.
 * Supported providers: OpenAI TTS, ElevenLabs.
 * Audio bytes are NEVER persisted — caller is responsible for ephemeral use.
 */
export async function synthesizeSpeech(text: string, config: TtsConfig): Promise<Buffer> {
  const provider = config.ttsProvider ?? 'openai';

  // Always log who's calling synthesis — helps trace credit burn
  if (provider === 'elevenlabs' || provider === 'openai') {
    const stack = new Error().stack?.split('\n').slice(2, 5).join(' → ').trim() ?? 'unknown';
    log.info(`💸 TTS synthesis (${provider}, ${text.length} chars) — caller: ${stack.slice(0, 200)}`);
  }

  if (provider === 'openai') {
    const apiKey = config.openAiTtsApiKey;
    if (!apiKey) throw new Error('openAiTtsApiKey required for TTS');

    log.debug(
      `TTS via OpenAI (${config.openAiTtsModel ?? 'tts-1'}, voice: ${config.openAiTtsVoice ?? 'onyx'})`,
    );

    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
    const apiKey = config.elevenLabsApiKey;
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
        model_id: 'eleven_multilingual_v2',
        language_code: config.ttsLanguage ?? 'fr',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`ElevenLabs TTS error ${res.status}: ${t.slice(0, 200)}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }

  if (provider === 'local') {
    return synthesizeLocal(text, resolveLocalVoice(config));
  }

  throw new Error(`Unknown TTS provider: ${provider}`);
}

/**
 * Speak text on the local machine speaker (non-blocking).
 * macOS: `say`, Windows: PowerShell SAPI, Linux: `espeak`.
 */
let _currentSayProc: import('child_process').ChildProcess | null = null;

export async function speakLocal(text: string, voice?: string): Promise<void> {
  // Cut current `say` if running — new message takes precedence
  if (_currentSayProc) {
    try { _currentSayProc.kill('SIGTERM'); } catch { /* ignore */ }
    _currentSayProc = null;
  }

  const sanitized = text.replace(/[`$"\\]/g, ''); // prevent injection
  return new Promise((resolve, _reject) => {
    let proc;
    if (platform === 'darwin') {
      proc = spawn('say', [...(voice ? ['-v', voice] : []), sanitized]);
    } else if (platform === 'win32') {
      proc = spawn('powershell', [
        '-Command',
        `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${sanitized.replace(/'/g, "''")}')`,
      ]);
    } else {
      proc = spawn('espeak', [...(voice ? ['-v', voice] : []), sanitized]);
    }
    _currentSayProc = proc;
    proc.on('close', () => {
      if (_currentSayProc === proc) _currentSayProc = null;
      resolve();
    });
    proc.on('error', (e) => {
      if (_currentSayProc === proc) _currentSayProc = null;
      log.warn(`Local TTS failed: ${e.message}`);
      resolve();
    });
  });
}

/**
 * Synthesize text to audio file using local TTS. Returns MP3/AIFF bytes.
 * macOS: `say -o file.aiff`, then convert to MP3 if ffmpeg available.
 */
async function synthesizeLocal(text: string, voice?: string): Promise<Buffer> {
  const voiceDir = join(homedir(), '.argos', 'voice');
  mkdirSync(voiceDir, { recursive: true });
  const sanitized = text.replace(/[`$"\\]/g, '');
  const ts = Date.now();

  if (platform === 'darwin') {
    const aiffFile = join(voiceDir, `tts_${ts}.aiff`);
    const mp3File = join(voiceDir, `tts_${ts}.mp3`);

    // Generate AIFF
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('say', [...(voice ? ['-v', voice] : []), '-o', aiffFile, sanitized]);
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`say exited ${code}`)),
      );
      proc.on('error', reject);
    });

    // Try to convert to MP3 (Telegram prefers it)
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', ['-i', aiffFile, '-y', '-q:a', '4', mp3File], {
          stdio: 'pipe',
        });
        proc.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
        );
        proc.on('error', reject);
      });
      const buf = readFileSync(mp3File);
      try {
        unlinkSync(aiffFile);
        unlinkSync(mp3File);
      } catch {
        /* ignore */
      }
      return buf;
    } catch {
      // No ffmpeg — return AIFF
      const buf = readFileSync(aiffFile);
      try {
        unlinkSync(aiffFile);
      } catch {
        /* ignore */
      }
      return buf;
    }
  }

  // Windows / Linux: use espeak + pipe to file
  const wavFile = join(voiceDir, `tts_${ts}.wav`);
  const cmd = platform === 'win32' ? 'powershell' : 'espeak';
  const args =
    platform === 'win32'
      ? [
          '-Command',
          `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wavFile}'); $s.Speak('${sanitized.replace(/'/g, "''")}'); $s.Dispose()`,
        ]
      : [...(voice ? ['-v', voice] : []), '-w', wavFile, sanitized];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`TTS exited ${code}`))));
    proc.on('error', reject);
  });

  const buf = readFileSync(wavFile);
  try {
    unlinkSync(wavFile);
  } catch {
    /* ignore */
  }
  return buf;
}
