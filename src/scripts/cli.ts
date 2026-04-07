#!/usr/bin/env node
/**
 * argos CLI — cross-platform daemon & setup manager
 *
 * Usage:
 *   argos setup      — interactive first-run setup wizard
 *   argos start      — start the Argos daemon
 *   argos stop       — stop the Argos daemon
 *   argos restart    — restart the Argos daemon
 *   argos dashboard  — open the web dashboard in your browser
 */

import { execSync, spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const platform = os.platform(); // 'darwin' | 'linux' | 'win32'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), '.argos', '.config.json');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.argos.plist');
const DIST_INDEX = path.resolve(__dirname, '..', 'index.js');
const LOG_PATH = path.join(os.homedir(), '.argos', 'argos.log');

function readConfig(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    // Try plain JSON first; only strip comments if that fails (avoids //: in URLs)
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through */
    }
    return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  } catch {
    return {};
  }
}

function dashboardUrl(): string {
  const cfg = readConfig();
  const webapp = cfg.webapp as Record<string, unknown> | undefined;
  if (webapp?.webauthnOrigin) return webapp.webauthnOrigin as string;
  const port = (webapp?.port as number) ?? 3000;
  return `http://localhost:${port}`;
}

function openBrowser(url: string) {
  if (platform === 'darwin') {
    execSync(`open "${url}"`);
  } else if (platform === 'win32') {
    execSync(`start "" "${url}"`);
  } else {
    // Linux: try xdg-open, then fallback to known browsers
    try {
      execSync(`xdg-open "${url}" 2>/dev/null`);
    } catch {
      try {
        execSync(`sensible-browser "${url}" 2>/dev/null`);
      } catch {
        console.log(`Open in your browser: ${url}`);
      }
    }
  }
}

/** Run another script from the same dist/scripts/ directory */
function runScript(name: string, args: string[] = []) {
  const scriptPath = path.resolve(__dirname, name + '.js');
  execSync(`${process.execPath} ${scriptPath} ${args.join(' ')}`, { stdio: 'inherit' });
}

/** Tail the Argos log file. Ctrl+C stops tailing but does NOT stop the daemon. */
function followLogs(opts: { fromStart?: boolean } = {}) {
  if (!fs.existsSync(LOG_PATH)) {
    // Wait for the file to appear (daemon just started)
    process.stdout.write('Waiting for log file');
    let attempts = 0;
    while (!fs.existsSync(LOG_PATH) && attempts++ < 20) {
      process.stdout.write('.');
      execSync('sleep 0.5');
    }
    process.stdout.write('\n');
  }

  if (!fs.existsSync(LOG_PATH)) {
    console.log(`No log file found at ${LOG_PATH}`);
    return;
  }

  console.log(`\x1b[90m── Logs (Ctrl+C to stop following — daemon keeps running) ──\x1b[0m\n`);

  const args = opts.fromStart ? [LOG_PATH] : ['-n', '50', '-f', LOG_PATH];
  const tail = spawn('tail', opts.fromStart ? ['-f', LOG_PATH] : args, { stdio: 'inherit' });

  // Ctrl+C: kill tail but keep daemon alive
  process.on('SIGINT', () => {
    tail.kill();
    console.log('\n\x1b[90m── Stopped following logs. Daemon is still running. ──\x1b[0m');
    process.exit(0);
  });

  tail.on('exit', () => process.exit(0));
}

// ─── Platform-specific daemon control ─────────────────────────────────────────

function uid(): string {
  return execSync('id -u').toString().trim();
}

// macOS — launchd
// KeepAlive is true, so "stop" must unload the plist; "start" must load it.
const mac = {
  isRunning(): boolean {
    try {
      const out = execSync('launchctl list dev.argos 2>/dev/null', { stdio: 'pipe' }).toString();
      // If "PID" key is present and non-zero, the daemon is alive
      return /\"PID\"\s*=\s*[1-9]/.test(out);
    } catch {
      return false;
    }
  },
  start() {
    if (!fs.existsSync(PLIST_PATH)) {
      console.error(`Plist not found: ${PLIST_PATH}\nRun "argos setup" first.`);
      process.exit(1);
    }
    if (mac.isRunning()) {
      console.log('Argos is already running. Use "argos restart" to reload.');
      process.exit(0);
    }
    execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: 'inherit' });
    console.log('Argos started.');
  },
  stop() {
    try {
      execSync(`launchctl unload -w "${PLIST_PATH}"`, { stdio: 'inherit' });
      console.log('Argos stopped.');
    } catch {
      // Might not be loaded — that's fine
      console.log('Argos was not running (or already stopped).');
    }
  },
  restart() {
    // unload (ignore error if not loaded), then load fresh
    try {
      execSync(`launchctl unload -w "${PLIST_PATH}"`, { stdio: 'pipe' });
    } catch {
      /* not loaded — ok */
    }
    execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: 'inherit' });
    console.log('Argos restarted.');
  },
};

// Linux — systemd user service
const linux = {
  start() {
    try {
      const out = execSync('systemctl --user is-active argos 2>/dev/null', { stdio: 'pipe' })
        .toString()
        .trim();
      if (out === 'active') {
        console.log('Argos is already running. Use "argos restart" to reload.');
        process.exit(0);
      }
    } catch {
      /* not running — proceed */
    }
    execSync('systemctl --user start argos', { stdio: 'inherit' });
    console.log('Argos started.');
  },
  stop() {
    execSync('systemctl --user stop argos', { stdio: 'inherit' });
    console.log('Argos stopped.');
  },
  restart() {
    execSync('systemctl --user restart argos', { stdio: 'inherit' });
    console.log('Argos restarted.');
  },
};

// Windows — spawn detached node process, track PID in ~/.argos/argos.pid
const PID_FILE = path.join(os.homedir(), '.argos', 'argos.pid');

const win = {
  start() {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      try {
        process.kill(pid, 0); // check if alive
        console.log(`Argos is already running (PID ${pid}).`);
        return;
      } catch {
        /* stale pid */
      }
    }
    const child = spawn(process.execPath, [DIST_INDEX], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, HOME: os.homedir() },
    });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
    console.log(`Argos started (PID ${child.pid}).`);
  },
  stop() {
    if (!fs.existsSync(PID_FILE)) {
      console.log('Argos is not running (no PID file found).');
      return;
    }
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      fs.unlinkSync(PID_FILE);
      console.log(`Argos stopped (PID ${pid}).`);
    } catch {
      fs.unlinkSync(PID_FILE);
      console.log('Argos process was not running (stale PID cleaned up).');
    }
  },
  restart() {
    win.stop();
    setTimeout(() => win.start(), 500);
  },
};

function daemon() {
  if (platform === 'darwin') return mac;
  if (platform === 'linux') return linux;
  if (platform === 'win32') return win;
  console.error(`Unsupported platform: ${platform}`);
  process.exit(1);
}

// ─── Command dispatch ─────────────────────────────────────────────────────────

const [, , subcmd, ...rest] = process.argv;

const noFollow = rest.includes('--no-follow');

switch (subcmd) {
  case 'start':
    try {
      daemon().start();
      if (!noFollow) followLogs();
    } catch (e) {
      console.error('Failed to start Argos:', (e as Error).message);
      process.exit(1);
    }
    break;

  case 'stop':
    try {
      daemon().stop();
    } catch (e) {
      console.error('Failed to stop Argos:', (e as Error).message);
      process.exit(1);
    }
    break;

  case 'restart':
    try {
      daemon().restart();
      if (!noFollow) followLogs();
    } catch (e) {
      console.error('Failed to restart Argos:', (e as Error).message);
      process.exit(1);
    }
    break;

  case 'log':
  case 'logs':
    if (rest.includes('--clean')) {
      const dir = path.dirname(LOG_PATH);
      const removed: string[] = [];
      try {
        for (const f of fs.readdirSync(dir)) {
          if (/^argos\.log\.\d+$/.test(f)) {
            const full = path.join(dir, f);
            try {
              fs.unlinkSync(full);
              removed.push(full);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
      try {
        if (fs.existsSync(LOG_PATH)) fs.truncateSync(LOG_PATH, 0);
      } catch {
        /* ignore */
      }
      console.log(`Truncated ${LOG_PATH}`);
      if (removed.length) console.log(`Removed ${removed.length} rotated log(s):`);
      for (const r of removed) console.log(`  ${r}`);
      break;
    }
    followLogs({ fromStart: rest.includes('--from-start') });
    break;

  case 'dev': {
    // Run Argos in the foreground — logs go directly to the terminal.
    // Ctrl+C kills the process (doesn't affect the background daemon if running).
    if (platform === 'darwin' && mac.isRunning()) {
      console.error('Argos daemon is already running. Stop it first: argos stop');
      process.exit(1);
    }
    console.log('\x1b[90m── Argos (foreground) — Ctrl+C to stop ──\x1b[0m\n');
    const dev = spawn(process.execPath, [DIST_INDEX], {
      stdio: 'inherit',
      env: { ...process.env, HOME: os.homedir() },
    });
    process.on('SIGINT', () => dev.kill('SIGINT'));
    process.on('SIGTERM', () => dev.kill('SIGTERM'));
    dev.on('exit', (code) => process.exit(code ?? 0));
    break;
  }

  case 'dashboard': {
    const url = dashboardUrl();
    console.log(`Opening ${url}`);
    openBrowser(url);
    break;
  }

  case 'setup':
    runScript('setup', rest);
    break;

  case 'status':
    runScript('status', rest);
    break;

  case 'reauth':
  case 'anthropic-login':
    runScript('reauth', rest);
    break;

  case 'bw-unlock': {
    const { bitwardenUnlock } = await import('./setup.js');
    const success = await bitwardenUnlock();
    process.exit(success ? 0 : 1);
  }

  case 'check-update':
  case 'version': {
    const { checkForUpdate } = await import('./check-update.js');
    const info = await checkForUpdate();
    if (info.error) {
      console.error(`❌ ${info.error}`);
      process.exit(1);
    }
    console.log(`Current:  v${info.current}`);
    if (info.latest) {
      console.log(`Latest:   ${info.latest}  (${new Date(info.publishedAt).toLocaleDateString()})`);
    }
    if (info.hasUpdate) {
      console.log(`\n🆕 Update available — ${info.releaseUrl}`);
      console.log(`\nChangelog:\n${info.changelog.slice(0, 500)}`);
      console.log(`\nUpdate: git pull && npm install && npm run build && argos restart`);
    } else if (!info.latest) {
      console.log(`\nℹ️  No releases published yet`);
    } else {
      console.log(`\n✅ Up to date`);
    }
    process.exit(0);
  }

  default:
    console.log(`\nArgos CLI\n\nUsage: argos <command> [options]\n
Commands:
  setup                Run the interactive first-run setup wizard
  start                Start the daemon (background) and follow logs
  stop                 Stop the daemon
  restart              Restart the daemon and follow logs
  dev                  Run Argos in the foreground — logs direct, Ctrl+C to stop
  logs                 Follow live logs  (--from-start to show all, --clean to wipe rotated logs)
  dashboard            Open the web dashboard in your browser
  status               Show running status and health check  (--watch, --json)
  anthropic-login      Re-authenticate with Anthropic (OAuth token refresh)
  bw-unlock            Re-unlock Bitwarden vault and update session token
  reauth               Alias for anthropic-login

Options:
  --no-follow          With start/restart: don't tail logs after starting
`);
    process.exit(subcmd ? 1 : 0);
}
