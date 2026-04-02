/**
 * Signal Channel — uses signal-cli as a sidecar process.
 *
 * signal-cli is a Java binary — the user must install it manually:
 *   - macOS:  brew install signal-cli
 *   - Linux:  download from https://github.com/AsamK/signal-cli/releases
 *
 * Setup:
 *   1. Install signal-cli (see above)
 *   2. Register your number: signal-cli -a +YOURNUMBER register
 *   3. Verify: signal-cli -a +YOURNUMBER verify CODE
 *   4. Configure in ~/.argos/config.json:
 *      "signal": { "enabled": true, "phoneNumber": "+33612345678", "allowedNumbers": ["+33611111111"] }
 *
 * signal-cli daemon mode (JSON-RPC over Unix socket):
 *   signal-cli --account +YOURNUMBER daemon --socket /tmp/signal-cli.sock
 *
 * Argos starts signal-cli as a subprocess and communicates via JSON-RPC over the Unix socket.
 * The socket path is validated to start with /tmp to prevent path traversal.
 */

import net from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { monotonicFactory } from 'ulid';
import { createLogger } from '../../logger.js';
import type { Channel } from './registry.js';
import type { RawMessage } from '../../types.js';

const ulid = monotonicFactory();
const log  = createLogger('signal');

// ─── Config ───────────────────────────────────────────────────────────────────

export interface SignalChannelOptions {
  /** Path to signal-cli binary. Default: 'signal-cli' (must be on PATH) */
  signalCliBin:   string;
  /** Registered phone number, e.g. +33612345678 */
  phoneNumber:    string;
  /** Allowlist of sender numbers. Empty = allow all (NOT recommended for production) */
  allowedNumbers: string[];
  /** Unix socket path for JSON-RPC. Default: /tmp/argos-signal.sock */
  socketPath:     string;
  /** signal-cli data directory (--config flag). Optional. */
  signalDataDir?: string;
}

type MessageHandler = (msg: RawMessage) => Promise<void>;

// ─── Signal channel ───────────────────────────────────────────────────────────

export class SignalChannel implements Channel {
  readonly name = 'signal';

  private proc:    ChildProcess | null = null;
  private socket:  net.Socket | null = null;
  private handler: MessageHandler | null = null;
  private pending  = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private reqId    = 0;
  private buffer   = '';
  private stopped  = false;

  constructor(private opts: SignalChannelOptions) {
    // Validate socket path — prevent path traversal
    if (!opts.socketPath.startsWith('/tmp')) {
      throw new Error(`Signal socket path must start with /tmp — got: ${opts.socketPath}`);
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const args = [
      '--account', this.opts.phoneNumber,
      'daemon',
      '--socket', this.opts.socketPath,
      ...(this.opts.signalDataDir ? ['--config', this.opts.signalDataDir] : []),
    ];

    log.info(`Starting signal-cli daemon: ${this.opts.signalCliBin} ${args.join(' ')}`);

    // spawn — never exec/shell to prevent injection
    this.proc = spawn(this.opts.signalCliBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    this.proc.stdout?.on('data', (d: Buffer) => log.debug(`signal-cli stdout: ${d.toString().trim()}`));
    this.proc.stderr?.on('data', (d: Buffer) => log.debug(`signal-cli stderr: ${d.toString().trim()}`));
    this.proc.on('exit', (code) => {
      if (!this.stopped) log.warn(`signal-cli exited unexpectedly (code ${code})`);
    });

    // signal-cli takes a few seconds to start its daemon before the socket appears
    await this.waitForSocket();

    // Connect via Unix socket
    this.socket = net.createConnection(this.opts.socketPath);
    this.socket.setEncoding('utf-8');
    this.socket.on('data', this.onData.bind(this));
    this.socket.on('error', (e) => log.error(`Signal socket error: ${e.message}`));
    this.socket.on('close', () => {
      if (!this.stopped) log.warn('Signal socket closed unexpectedly');
    });

    // Subscribe to incoming messages
    await this.rpc('subscribeReceive', {});
    log.info(`Signal channel ready — ${this.opts.phoneNumber}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.destroy();
    this.proc?.kill('SIGTERM');
    log.info('Signal channel stopped');
  }

  async sendMessage(recipient: string, text: string): Promise<void> {
    await this.rpc('send', { recipient: [recipient], message: text });
  }

  // ─── JSON-RPC over Unix socket ────────────────────────────────────────────

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id  = ++this.reqId;
    const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(req);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.method === 'receive') {
          // Async — don't let a bad message handler stall the socket reader
          void this.handleIncoming(msg.params as Record<string, unknown>);
        } else if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error((msg.error as Record<string, string>).message ?? String(msg.error)));
          } else {
            resolve(msg.result);
          }
        }
      } catch { /* malformed JSON line — ignore */ }
    }
  }

  private async handleIncoming(params: Record<string, unknown>): Promise<void> {
    const envelope = params.envelope as Record<string, unknown> | undefined;
    if (!envelope) return;

    const dataMsg = envelope.dataMessage as Record<string, unknown> | undefined;
    // Skip reactions, delivery receipts, read receipts — only process text messages
    if (!dataMsg || !dataMsg.message) return;

    const sender = String(envelope.sourceNumber ?? envelope.sourceUuid ?? '');

    // Allowlist check — enforced before any message hits the pipeline
    if (this.opts.allowedNumbers.length > 0 && !this.opts.allowedNumbers.includes(sender)) {
      log.warn(`Signal: ignoring message from non-allowed number ${sender}`);
      return;
    }

    const content = String(dataMsg.message ?? '');
    if (!content.trim()) return;

    const raw: RawMessage = {
      id:          ulid(),
      channel:     'signal',
      source:      'signal',
      chatId:      sender,
      chatType:    'dm',
      senderId:    sender,
      senderName:  sender,
      content,
      links:       extractLinks(content),
      receivedAt:  Date.now(),
      timestamp:   Number(envelope.timestamp ?? Date.now()),
    };

    log.info(`Signal message from ${sender}: ${content.slice(0, 60)}`);

    if (this.handler) {
      await this.handler(raw).catch(e => log.error(`Signal message handler error: ${e}`));
    }
  }

  // ─── Wait for socket file ─────────────────────────────────────────────────

  private waitForSocket(maxMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (existsSync(this.opts.socketPath)) {
          resolve();
        } else if (Date.now() - start > maxMs) {
          reject(new Error(`signal-cli socket not found after ${maxMs}ms: ${this.opts.socketPath}`));
        } else {
          setTimeout(check, 300);
        }
      };
      check();
    });
  }
}

// ─── Link extraction ──────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

function extractLinks(text: string): string[] {
  return [...new Set(text.match(URL_REGEX) ?? [])];
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSignalChannel(opts: SignalChannelOptions): SignalChannel {
  return new SignalChannel(opts);
}
