/**
 * GLiNER process manager.
 *
 * Automatically starts/stops the GLiNER NER server based on config:
 *   - anonymizer.glinerUrl is set → ensure server is running
 *   - anonymizer.mode === 'none' OR glinerUrl not set → ensure server is stopped
 *
 * Uses launchctl on macOS (if the plist is installed) or spawns the process
 * directly as a fallback.
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createLogger } from '../logger.js';
import type { AnonymizerConfig } from '../config/schema.js';
import { isGlinerAvailable } from './gliner-anonymizer.js';

const log = createLogger('gliner-manager');

const PLIST_LABEL = 'ai.argos.gliner';
const PLIST_PATH = `${process.env.HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist`;
const SERVER_SCRIPT = new URL('../../gliner_server.py', import.meta.url).pathname;
const VENV_PYTHON = new URL('../../.venv/bin/python3', import.meta.url).pathname;

// ─── launchctl helpers ────────────────────────────────────────────────────────

function launchctlIsRunning(): boolean {
  try {
    const out = execSync(`launchctl list ${PLIST_LABEL} 2>/dev/null`, { encoding: 'utf8' });
    return out.includes(PLIST_LABEL);
  } catch {
    return false;
  }
}

function launchctlStart(): boolean {
  try {
    execSync(`launchctl load -w "${PLIST_PATH}" 2>/dev/null`);
    return true;
  } catch {
    try {
      execSync(`launchctl kickstart -k gui/$(id -u)/${PLIST_LABEL} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }
}

function launchctlStop(): void {
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
  } catch {
    try {
      execSync(`launchctl stop ${PLIST_LABEL} 2>/dev/null`);
    } catch {
      // ignore
    }
  }
}

// ─── Fallback: spawn process directly ────────────────────────────────────────

let _spawned: ReturnType<typeof spawn> | null = null;

function spawnServer(url: string): void {
  if (_spawned) return;
  const port = new URL(url).port || '7688';

  if (!existsSync(VENV_PYTHON)) {
    log.warn(`GLiNER venv not found at ${VENV_PYTHON} — cannot auto-start server`);
    return;
  }
  if (!existsSync(SERVER_SCRIPT)) {
    log.warn(`GLiNER server script not found at ${SERVER_SCRIPT}`);
    return;
  }

  log.info(`Spawning GLiNER server on port ${port}`);
  _spawned = spawn(VENV_PYTHON, [SERVER_SCRIPT, '--port', port], {
    detached: false,
    stdio: 'ignore',
  });

  _spawned.on('error', (e) => log.warn(`GLiNER process error: ${e}`));
  _spawned.on('exit', (code) => {
    log.info(`GLiNER process exited (code=${code})`);
    _spawned = null;
  });
}

function killSpawned(): void {
  if (_spawned) {
    _spawned.kill();
    _spawned = null;
  }
}

// ─── Main exports ─────────────────────────────────────────────────────────────

/**
 * Called at Argos boot. Ensures GLiNER is running if configured, stopped if not.
 */
export async function ensureGliner(cfg: AnonymizerConfig): Promise<void> {
  const glinerUrl = cfg.glinerUrl;
  const enabled = cfg.mode !== 'none' && !!glinerUrl;

  if (!enabled) {
    // Anonymization disabled or no glinerUrl — stop GLiNER if it was running
    if (launchctlIsRunning()) {
      log.info('GLiNER not needed — stopping launchd service');
      launchctlStop();
    }
    killSpawned();
    return;
  }

  // Check if already up
  if (await isGlinerAvailable(glinerUrl)) {
    log.info(`GLiNER already running at ${glinerUrl}`);
    return;
  }

  log.info(`GLiNER not running — starting...`);

  // Try launchctl first (macOS, plist installed)
  if (existsSync(PLIST_PATH)) {
    if (launchctlStart()) {
      // Wait up to 15s for the model to load
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await isGlinerAvailable(glinerUrl)) {
          log.info(`GLiNER ready via launchctl (${i + 1}s)`);
          return;
        }
      }
      log.warn('GLiNER launchctl start timed out — trying direct spawn');
    }
  }

  // Fallback: spawn directly
  spawnServer(glinerUrl);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isGlinerAvailable(glinerUrl)) {
      log.info(`GLiNER ready via spawn (${i + 1}s)`);
      return;
    }
  }

  log.warn('GLiNER did not become ready in 20s — anonymization will fall back to regex-only');
}

/**
 * Called on graceful shutdown. Kills the spawned process (not the launchd service).
 */
export function stopGliner(): void {
  killSpawned();
}
