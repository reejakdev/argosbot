// Structured logger — everything goes to console + audit DB in debug mode

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};

const RESET = '\x1b[0m';

// Patterns that indicate secrets — redacted before logging
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9\-_]{20,}/g, // Anthropic / Stripe API keys
  /pk-[A-Za-z0-9\-_]{20,}/g, // Public keys
  /Bearer\s+[A-Za-z0-9\-_.~+/]{20,}/g, // Bearer tokens
  /ntn_[A-Za-z0-9]{20,}/g, // Notion tokens
  /xoxb-[A-Za-z0-9\-]{20,}/g, // Slack bot tokens
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub PATs
  /gho_[A-Za-z0-9]{20,}/g, // GitHub OAuth tokens
  /eyJ[A-Za-z0-9\-_]{30,}\.[A-Za-z0-9\-_]{30,}/g, // JWTs
];

function sanitizeLogData(data: unknown): unknown {
  if (typeof data === 'string') {
    let sanitized = data;
    for (const pattern of SECRET_PATTERNS) {
      sanitized = sanitized.replace(pattern, (match) => match.slice(0, 6) + '…[REDACTED]');
    }
    return sanitized;
  }
  if (typeof data === 'object' && data !== null) {
    return JSON.parse(
      JSON.stringify(data, (_key, value) => {
        if (typeof value !== 'string') return value;
        let sanitized = value;
        for (const pattern of SECRET_PATTERNS) {
          sanitized = sanitized.replace(pattern, (match) => match.slice(0, 6) + '…[REDACTED]');
        }
        return sanitized;
      }),
    );
  }
  return data;
}

let currentLevel: LogLevel = 'debug';
let auditCallback: ((level: LogLevel, module: string, msg: string, data?: unknown) => void) | null =
  null;

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function setAuditCallback(cb: typeof auditCallback) {
  auditCallback = cb;
}

function log(level: LogLevel, module: string, msg: string, data?: unknown) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const ts = new Date().toISOString();
  const color = COLORS[level];
  const prefix = `${color}[${level.toUpperCase().padEnd(5)}]${RESET} ${ts} [${module}]`;

  if (data !== undefined) {
    const safe = sanitizeLogData(data);
    console.log(
      `${prefix} ${msg}`,
      typeof safe === 'object' ? JSON.stringify(safe, null, 2) : safe,
    ); // eslint-disable-line no-console
  } else {
    console.log(`${prefix} ${msg}`); // eslint-disable-line no-console
  }

  auditCallback?.(level, module, msg, data);
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, data?: unknown) => log('debug', module, msg, data),
    info: (msg: string, data?: unknown) => log('info', module, msg, data),
    warn: (msg: string, data?: unknown) => log('warn', module, msg, data),
    error: (msg: string, data?: unknown) => log('error', module, msg, data),
  };
}

export type Logger = ReturnType<typeof createLogger>;
