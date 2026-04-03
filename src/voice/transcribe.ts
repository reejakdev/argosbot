import { createLogger } from '../logger.js';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const log = createLogger('voice');

export interface VoiceConfig {
  whisperEndpoint?: string;   // default: https://api.openai.com/v1
  whisperApiKey?: string;
  whisperModel?: string;      // default: whisper-1 (API) or 'base' (local)
  whisperBackend?: 'api' | 'local';  // default: auto (local if no apiKey)
}

/**
 * Transcribe audio bytes — supports:
 *   - 'local'  : whisper CLI (pip install openai-whisper) — free, runs on device
 *   - 'api'    : OpenAI Whisper API or compatible endpoint — needs apiKey
 *
 * Backend is auto-detected: local if no apiKey, api if apiKey present.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
  config: VoiceConfig,
): Promise<string> {
  const backend = config.whisperBackend
    ?? (config.whisperApiKey ? 'api' : 'local');

  if (backend === 'local') {
    return transcribeLocal(audioBuffer, filename, config.whisperModel ?? 'base');
  }
  return transcribeApi(audioBuffer, filename, config);
}

// ─── Local Whisper CLI ────────────────────────────────────────────────────────

async function transcribeLocal(buffer: Buffer, filename: string, model: string): Promise<string> {
  if (buffer.length > 100 * 1024 * 1024) throw new Error('Audio too large (max 100MB for local)');

  // Write audio to a temp file (whisper CLI needs a file path)
  const tmpFile = join(tmpdir(), `argos_voice_${Date.now()}_${filename}`);
  try {
    writeFileSync(tmpFile, buffer);

    // Detect whisper CLI before entering Promise constructor (no await allowed inside)
    const whisperInPath = await new Promise<boolean>((res) => {
      const check = spawn('which', ['whisper']);
      check.on('close', (code) => res(code === 0));
    });
    const outDir  = tmpdir();
    // whisper names output as <stem>.txt — derive it from the input filename
    const stem    = tmpFile.replace(/\.[^.]+$/, '');   // strip last extension
    const outFile = join(outDir, stem.split('/').pop()! + '.txt');

    const cmd  = whisperInPath ? 'whisper' : 'python3';
    const baseArgs = [
      '--model', model,
      '--output_format', 'txt',
      '--output_dir', outDir,
      '--verbose', 'False',
      '--fp16', 'False',
    ];
    const args = whisperInPath
      ? [tmpFile, ...baseArgs]
      : ['-m', 'whisper', tmpFile, ...baseArgs];

    const transcript = await new Promise<string>((resolve, reject) => {
      const proc = spawn(cmd, args, { timeout: 120_000 });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => stdout += d.toString());
      proc.stderr.on('data', (d: Buffer) => stderr += d.toString());

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`whisper exited ${code}: ${stderr.slice(0, 300)}`));
          return;
        }
        if (existsSync(outFile)) {
          const text = readFileSync(outFile, 'utf8').trim();
          try { unlinkSync(outFile); } catch { /* ignore */ }
          resolve(text || stdout.trim());
        } else {
          // fallback: stdout may contain the transcript
          resolve(stdout.trim() || '(empty transcript)');
        }
      });

      proc.on('error', (e) => reject(new Error(`whisper not found: ${e.message} — install: pip install openai-whisper`)));
    });

    log.info(`Local whisper transcribed: ${transcript.slice(0, 80)}`);
    return transcript;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ─── OpenAI Whisper API ───────────────────────────────────────────────────────

async function transcribeApi(buffer: Buffer, filename: string, config: VoiceConfig): Promise<string> {
  const endpoint = config.whisperEndpoint ?? 'https://api.openai.com/v1';
  const apiKey   = config.whisperApiKey;
  const model    = config.whisperModel ?? 'whisper-1';

  if (!apiKey) throw new Error('whisperApiKey required for API transcription (or use whisperBackend: "local")');
  if (buffer.length > 25 * 1024 * 1024) throw new Error('Audio file too large (max 25MB for API)');

  const blob = new Blob([buffer], { type: 'audio/ogg' });
  const formData = new globalThis.FormData();
  formData.append('file', blob, filename);
  formData.append('model', model);
  formData.append('response_format', 'text');

  log.debug(`Transcribing ${buffer.length} bytes via ${endpoint}`);

  const res = await fetch(`${endpoint}/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Whisper API error ${res.status}: ${text.slice(0, 200)}`);
  }

  return (await res.text()).trim();
}
