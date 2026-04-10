/**
 * Voice output dispatcher — decides WHERE and WHEN Argos speaks.
 *
 * Reads voice config (triggers + output mode) and dispatches TTS to:
 *   - machine: plays audio on local speakers (macOS `say`, Windows SAPI, Linux espeak)
 *   - channel: sends voice message to the chat (Telegram, etc.)
 *   - both: machine + channel
 *
 * Called by the bot, heartbeat, briefing, and alert systems.
 */

import { createLogger } from '../logger.js';
import { synthesizeSpeech, speakLocal } from './synthesize.js';
import { jarvisSendText, jarvisSendAudio, hasJarvisClients } from '../webapp/jarvis.js';
import { spawn } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { platform } from 'process';
import type { TtsConfig } from './synthesize.js';

const log = createLogger('voice-speak');

export type TtsOutput = 'machine' | 'channel' | 'webspeak' | 'both' | 'all';
export type VoiceTrigger =
  | 'always'
  | 'onVoiceMessage'
  | 'onTask'
  | 'onAlert'
  | 'onTodo'
  | 'onBriefing';

export interface VoiceOutputConfig extends TtsConfig {
  ttsEnabled?: boolean;
  localTtsVoice?: string;
  ttsTriggers?: Record<string, string>;
}

/**
 * Strip "thinking" / reasoning blocks from text before TTS.
 * Some models (Qwen, DeepSeek-R1, GPT-o1, etc.) emit reasoning inline using
 * <think>, <thinking>, <reasoning>, or [THINKING] tags. We never want to
 * speak the model's internal reasoning — only the final answer.
 */
export function stripThinking(text: string): string {
  if (!text) return text;
  return text
    // <think>...</think> and <thinking>...</thinking>
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    // <reasoning>...</reasoning>
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    // Markdown-style [THINKING] ... [/THINKING]
    .replace(/\[THINKING\][\s\S]*?\[\/THINKING\]/gi, '')
    // Unclosed thinking block at start (model didn't close it before output)
    .replace(/^<think(?:ing)?>[\s\S]*?(?=\n\n|$)/i, '')
    .trim();
}

/**
 * Get the output mode for a trigger. Returns null if voice shouldn't fire.
 */
export function getTriggerOutput(config: VoiceOutputConfig, trigger: VoiceTrigger): TtsOutput | null {
  if (!config.ttsEnabled) return null;
  const t = config.ttsTriggers ?? {};
  // 'always' overrides all other triggers
  const alwaysMode = t['always'] ?? 'off';
  if (alwaysMode !== 'off') return alwaysMode as TtsOutput;
  const mode = t[trigger] ?? 'off';
  return mode === 'off' ? null : mode as TtsOutput;
}

/**
 * Speak text according to config — handles both machine playback and channel voice messages.
 *
 * @param text - Text to speak
 * @param config - Voice configuration
 * @param trigger - What triggered this speech
 * @param sendVoiceToChannel - Callback to send voice bytes to the chat channel (optional)
 */
export async function speak(
  text: string,
  config: VoiceOutputConfig,
  trigger: VoiceTrigger,
  sendVoiceToChannel?: (audio: Buffer, filename: string) => Promise<void>,
): Promise<void> {
  const output = getTriggerOutput(config, trigger);
  if (!output) return;
  if (!text?.trim()) return;

  // Strip any reasoning/thinking blocks the model may have emitted inline
  // (Qwen <think>, DeepSeek-R1, GPT-o1, etc.). Never speak the model's reasoning.
  const cleaned = stripThinking(text);
  if (!cleaned.trim()) return;

  // Truncate for TTS (most providers cap at 4-5k chars)
  const truncated = cleaned.slice(0, 4000);

  log.info(
    `Speaking (trigger=${trigger}, output=${output}, provider=${config.ttsProvider ?? 'local'}): ${truncated.slice(0, 60)}…`,
  );

  const wantMachine = output === 'machine' || output === 'both' || output === 'all';
  const wantChannel = output === 'channel' || output === 'both' || output === 'all';
  const wantWebspeak = output === 'webspeak' || output === 'all';
  const isCloudTts = config.ttsProvider === 'elevenlabs' || config.ttsProvider === 'openai';

  // Synthesize audio ONCE — same voice everywhere
  // If webspeak is the ONLY output and nobody is connected → skip (saves API credits)
  // If other outputs are active → synthesize anyway and also send to display as bonus
  const otherOutputsActive = wantMachine || (wantChannel && !!sendVoiceToChannel);
  const webspeakActive = wantWebspeak && (otherOutputsActive || hasJarvisClients());
  const needsAudioBytes = otherOutputsActive || webspeakActive;
  let audioBytes: Buffer | null = null;
  if (needsAudioBytes) {
    try {
      audioBytes = await synthesizeSpeech(truncated, config);
      // Apply reverb/delay effects via ffmpeg (all outputs get the same processed audio)
      const fx = (config as Record<string, unknown>).effects as { reverb?: number; delay?: number; delayTime?: number } | undefined;
      if (audioBytes && fx && (fx.reverb || fx.delay)) {
        audioBytes = await applyAudioEffects(audioBytes, isCloudTts ? 'mp3' : 'aiff', fx);
      }
    } catch (e) {
      log.warn(`TTS synthesis failed: ${e instanceof Error ? e.message : String(e)}`);
      if (wantMachine && isCloudTts) {
        const lang = (config as Record<string, unknown>).ttsLanguage as string | undefined;
        const voice = config.localTtsVoice || (lang === 'fr' ? 'Thomas' : undefined);
        speakLocal(truncated, voice).catch(() => {});
      }
    }
  }

  const promises: Promise<void>[] = [];
  const ext = isCloudTts ? 'mp3' : 'aiff';

  // Machine output — play synthesized audio on local speakers
  if (wantMachine && audioBytes) {
    promises.push(
      playAudioLocal(audioBytes, ext).catch((e) => {
        log.warn(`Machine playback failed: ${e instanceof Error ? e.message : String(e)}`);
      }),
    );
  }

  // Channel output — send voice message to chat
  if (wantChannel && sendVoiceToChannel && audioBytes) {
    promises.push(
      sendVoiceToChannel(audioBytes, `argos_voice.${ext}`).catch((e) => {
        log.warn(`Channel TTS failed: ${e instanceof Error ? e.message : String(e)}`);
      }),
    );
  }

  // Webspeak output — send to display
  if (webspeakActive) {
    jarvisSendText(truncated);
    if (audioBytes) {
      const format = ext;
      jarvisSendAudio(audioBytes, format);
    }
  }

  await Promise.all(promises);
}

/**
 * Play audio bytes on the local machine speakers.
 * Uses afplay (macOS), ffplay (Linux), or PowerShell (Windows).
 * If a previous playback is in progress, it is interrupted (new audio takes precedence).
 */
let _currentPlaybackProc: import('child_process').ChildProcess | null = null;

async function playAudioLocal(audio: Buffer, ext: string): Promise<void> {
  // Cut current playback — new message takes precedence
  if (_currentPlaybackProc) {
    try { _currentPlaybackProc.kill('SIGTERM'); } catch { /* ignore */ }
    _currentPlaybackProc = null;
  }

  const voiceDir = join(homedir(), '.argos', 'voice');
  mkdirSync(voiceDir, { recursive: true });
  const tmpFile = join(voiceDir, `playback_${Date.now()}.${ext}`);
  writeFileSync(tmpFile, audio);

  return new Promise((resolve) => {
    let cmd: string;
    let args: string[];
    if (platform === 'darwin') {
      cmd = 'afplay';
      args = [tmpFile];
    } else if (platform === 'win32') {
      cmd = 'powershell';
      args = ['-Command', `(New-Object Media.SoundPlayer '${tmpFile}').PlaySync()`];
    } else {
      cmd = 'ffplay';
      args = ['-nodisp', '-autoexit', '-loglevel', 'quiet', tmpFile];
    }

    const proc = spawn(cmd, args, { stdio: 'ignore' });
    _currentPlaybackProc = proc;
    proc.on('close', () => {
      if (_currentPlaybackProc === proc) _currentPlaybackProc = null;
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      resolve();
    });
    proc.on('error', () => {
      if (_currentPlaybackProc === proc) _currentPlaybackProc = null;
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      resolve();
    });
  });
}

/**
 * Apply reverb and delay effects to audio using ffmpeg.
 * Returns processed audio as MP3 buffer.
 * If ffmpeg is not available, returns the original audio unchanged.
 */
async function applyAudioEffects(
  audio: Buffer,
  inputExt: string,
  fx: { reverb?: number; delay?: number; delayTime?: number },
): Promise<Buffer> {
  const reverb = fx.reverb ?? 0;
  const delay = fx.delay ?? 0;
  const delayTime = fx.delayTime ?? 0.3;

  if (reverb === 0 && delay === 0) return audio;

  const voiceDir = join(homedir(), '.argos', 'voice');
  mkdirSync(voiceDir, { recursive: true });
  const ts = Date.now();
  const inFile = join(voiceDir, `fx_in_${ts}.${inputExt}`);
  const outFile = join(voiceDir, `fx_out_${ts}.mp3`);
  writeFileSync(inFile, audio);

  // Build ffmpeg filter chain
  const filters: string[] = [];

  // Delay: adelay adds a delayed copy mixed with original
  if (delay > 0) {
    const delayMs = Math.round(delayTime * 1000);
    const wet = (delay / 100).toFixed(2);
    // Split → delay one copy → mix back at wet level
    filters.push(`adelay=${delayMs}|${delayMs}`);
    // Use aecho for a cleaner delay effect
    filters.length = 0; // reset — aecho handles both
  }

  // Use aecho for combined delay+reverb (ffmpeg's simplest effect chain)
  // aecho=in_gain:out_gain:delays:decays
  if (delay > 0 || reverb > 0) {
    const delayMs = delay > 0 ? Math.round(delayTime * 1000) : 60;
    const decay = delay > 0 ? (delay / 100 * 0.6).toFixed(2) : '0';
    // Reverb via multiple short echoes
    if (reverb > 0) {
      const r = (reverb / 100 * 0.5).toFixed(2);
      filters.push(`aecho=0.8:0.7:${delayMs}|40|80:${decay}|${r}|${(parseFloat(r) * 0.6).toFixed(2)}`);
    } else {
      filters.push(`aecho=0.8:0.8:${delayMs}:${decay}`);
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const args = ['-i', inFile, '-y'];
      if (filters.length) args.push('-af', filters.join(','));
      args.push('-q:a', '4', outFile);
      const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
      proc.on('error', reject);
    });
    const result = readFileSync(outFile);
    try { unlinkSync(inFile); unlinkSync(outFile); } catch { /* ignore */ }
    log.info(`Audio effects applied: reverb=${reverb}% delay=${delay}% delayTime=${delayTime}s`);
    return result;
  } catch (e) {
    log.warn(`ffmpeg effects failed (returning dry audio): ${e instanceof Error ? e.message : String(e)}`);
    try { unlinkSync(inFile); unlinkSync(outFile); } catch { /* ignore */ }
    return audio;
  }
}
