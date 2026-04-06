import { spawn } from 'child_process';
import { resolve as resolvePath } from 'path';
import { homedir } from 'os';
import { createLogger } from '../logger.js';
import { audit } from '../db/index.js';
import type { Config } from '../config/schema.js';

const log = createLogger('shell-exec');

// ─── Allowlist ───────────────────────────────────────────────────────────────
const DEFAULT_ALLOWED = new Set([
  'git',
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'find',
  'wc',
  'node',
  'npm',
  'npx',
  'tsx',
  'python3',
  'pip3',
  'jq',
  'yq',
  'date',
  'whoami',
  'pwd',
  'ps',
  'df',
  'du',
  'uptime',
  'curl',
  'wget',
]);

// Hard-blocked regardless of allowlist
const BLOCKED_RE = [
  /\brm\b/,
  /\brmdir\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\bsudo\b/,
  /\bsu\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bpasswd\b/,
  /\bcrontab\b/,
  /\bkill\b/,
  /\beval\b/,
  /[;&|`]/, // shell metacharacters
  /\.\.[/\\]/, // path traversal
];

function isPrivateUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname);
  } catch {
    return true;
  }
}

export interface ShellExecInput {
  command: string;
  args: string[];
  workingDir?: string;
  timeoutSeconds?: number;
  reason: string;
}

export interface WorkerResult {
  success: boolean;
  output: string;
  dryRun: boolean;
  data?: unknown;
}

export async function executeShellExec(
  input: Record<string, unknown>,
  config: Config,
): Promise<WorkerResult> {
  const cmd = String(input.command ?? '').trim();
  const args = (input.args as string[] | undefined) ?? [];
  const reason = String(input.reason ?? '');
  const timeoutMs = Math.min(Number(input.timeoutSeconds ?? 30), 60) * 1000;
  const rawDir = input.workingDir ? String(input.workingDir) : undefined;

  // ── shellExec must be enabled in config ──
  const shellCfg = (
    config as unknown as { shellExec?: { enabled?: boolean; allowedCommands?: string[] } }
  ).shellExec;
  if (!shellCfg?.enabled) {
    return {
      success: false,
      output: 'shell_exec is disabled. Set shellExec.enabled = true in config.',
      dryRun: false,
    };
  }

  // ── Build effective allowlist ──
  const allowed = new Set([...DEFAULT_ALLOWED, ...(shellCfg.allowedCommands ?? [])]);

  // ── Validate command ──
  if (!allowed.has(cmd)) {
    audit('shell_exec_blocked', cmd, 'worker', { reason: 'not in allowlist', args });
    return { success: false, output: `Command '${cmd}' is not in the allowlist.`, dryRun: false };
  }

  // ── Check all args for blocked patterns ──
  const fullCommand = [cmd, ...args].join(' ');
  for (const re of BLOCKED_RE) {
    if (re.test(fullCommand)) {
      audit('shell_exec_blocked', cmd, 'worker', {
        reason: 'blocked pattern',
        pattern: re.toString(),
      });
      return { success: false, output: `Blocked pattern detected in command.`, dryRun: false };
    }
  }

  // ── For curl/wget: block private URLs + enforce HTTPS ──
  if (cmd === 'curl' || cmd === 'wget') {
    for (const arg of args) {
      if (/^http:\/\//i.test(arg)) {
        return {
          success: false,
          output: `Blocked insecure HTTP URL: ${arg}. Use HTTPS.`,
          dryRun: false,
        };
      }
      if (/^https?:\/\//i.test(arg) && isPrivateUrl(arg)) {
        return { success: false, output: `Blocked private/localhost URL: ${arg}`, dryRun: false };
      }
    }
  }

  // ── Validate workingDir ──
  let cwd = homedir();
  if (rawDir) {
    const resolved = resolvePath(rawDir.startsWith('~') ? rawDir.replace('~', homedir()) : rawDir);
    if (!resolved.startsWith(homedir())) {
      return { success: false, output: 'workingDir must be within HOME directory.', dryRun: false };
    }
    cwd = resolved;
  }

  log.info(`shell_exec: ${cmd} ${args.join(' ')} — ${reason}`);
  audit('shell_exec_run', cmd, 'worker', { args, cwd, reason });

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_OUTPUT = 10 * 1024; // 10KB

    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false, // NO shell interpretation
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_OUTPUT) chunks.push(chunk);
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString('utf-8').slice(0, MAX_OUTPUT);
      const truncated = totalBytes > MAX_OUTPUT ? `\n[truncated — ${totalBytes} bytes total]` : '';
      if (code === 0) {
        resolve({ success: true, output: output + truncated, dryRun: false });
      } else {
        resolve({
          success: false,
          output: `Exit code ${code}\n${output}${truncated}`,
          dryRun: false,
        });
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ success: false, output: e.message, dryRun: false });
    });
  });
}
