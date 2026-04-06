/**
 * Credential resolver — fetches secrets at worker execution time.
 *
 * SECURITY INVARIANT:
 *   Secrets are NEVER passed to the LLM or stored in logs.
 *   The planner only sees a reference name (e.g. "vault:BankLogin").
 *   The worker calls resolve() at execution time — after approval.
 *
 * Supported reference formats:
 *
 *   vault:ItemName                → 1Password item by name (username + password)
 *   vault:VaultName/ItemName      → 1Password item in specific vault
 *   op://VaultName/ItemName/field → 1Password secret reference (specific field)
 *   config:SECRET_KEY             → config.secrets.SECRET_KEY or process.env.SECRET_KEY
 *
 * 1Password requires:
 *   - OP_SERVICE_ACCOUNT_TOKEN set in config.secrets or env
 *   - 1Password CLI (`op`) installed: brew install 1password-cli
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('credentials');

// ─── Resolved credential ──────────────────────────────────────────────────────

export interface ResolvedCredential {
  username?: string;
  password?: string;
  token?: string;
  /** Raw field value — for op:// references or config: references */
  value?: string;
  /** Card number for payment credentials */
  cardNumber?: string;
  cardExpiry?: string;
  cardCvv?: string;
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * @param configSecrets - config.secrets from the loaded config. Required for
 *   "config:" refs — only keys present in this object are accessible.
 *   Prevents arbitrary process.env leakage (e.g. ANTHROPIC_API_KEY, PATH, etc.)
 */
export async function resolveCredential(
  ref: string,
  configSecrets: Record<string, string> = {},
): Promise<ResolvedCredential> {
  if (!ref) throw new Error('credential_ref is required');

  // op:// secret reference — fetch a specific field
  if (ref.startsWith('op://')) {
    return resolveOpRef(ref);
  }

  // vault: — fetch a full item (username + password)
  if (ref.startsWith('vault:')) {
    return resolveVaultItem(ref.slice('vault:'.length));
  }

  // config: — ONLY keys defined in config.secrets, never arbitrary process.env
  if (ref.startsWith('config:')) {
    return resolveConfigSecret(ref.slice('config:'.length), configSecrets);
  }

  throw new Error(
    `Unknown credential ref format: "${ref}". Use vault:ItemName, op://vault/item/field, or config:KEY`,
  );
}

// ─── 1Password: fetch a full item ────────────────────────────────────────────

async function resolveVaultItem(itemRef: string): Promise<ResolvedCredential> {
  ensureOpToken();

  // itemRef may be "ItemName" or "VaultName/ItemName"
  const [vaultOrItem, itemName] = itemRef.includes('/')
    ? itemRef.split('/', 2)
    : [undefined, itemRef];

  const args = [
    'item',
    'get',
    itemName,
    '--format',
    'json',
    '--fields',
    'label=username,label=password,label=card number,label=expiry date,label=cvv,label=token,label=api key',
  ];
  if (vaultOrItem) args.push('--vault', vaultOrItem);

  try {
    const { stdout } = await execFileAsync('op', args, {
      env: { ...process.env },
      timeout: 10_000,
    });

    // op returns an array of field objects
    const fields = JSON.parse(stdout) as Array<{ label: string; value: string }>;
    const get = (label: string) =>
      fields.find((f) => f.label.toLowerCase() === label.toLowerCase())?.value;

    const result: ResolvedCredential = {
      username: get('username'),
      password: get('password'),
      token: get('token') ?? get('api key'),
      cardNumber: get('card number'),
      cardExpiry: get('expiry date'),
      cardCvv: get('cvv'),
    };

    // Remove undefined keys
    Object.keys(result).forEach((k) => {
      if (result[k as keyof ResolvedCredential] === undefined) {
        delete result[k as keyof ResolvedCredential];
      }
    });

    log.debug(`Credential resolved: vault:${itemRef} (fields: ${Object.keys(result).join(', ')})`);
    return result;
  } catch (e) {
    throw new Error(`1Password: could not fetch "${itemRef}": ${(e as Error).message}`);
  }
}

// ─── 1Password: op:// secret reference ───────────────────────────────────────

async function resolveOpRef(ref: string): Promise<ResolvedCredential> {
  ensureOpToken();

  try {
    const { stdout } = await execFileAsync('op', ['read', ref], {
      env: { ...process.env },
      timeout: 10_000,
    });

    const value = stdout.trim();
    log.debug(`Credential resolved: ${ref.replace(/\/[^/]+$/, '/***')}`);
    return { value };
  } catch (e) {
    throw new Error(`1Password: could not read "${ref}": ${(e as Error).message}`);
  }
}

// ─── Config / env secret ──────────────────────────────────────────────────────

function resolveConfigSecret(
  key: string,
  configSecrets: Record<string, string>,
): ResolvedCredential {
  // Only allow keys explicitly declared in config.secrets — never arbitrary process.env
  const value = configSecrets[key];
  if (!value) throw new Error(`config secret "${key}" not found in config.secrets`);
  log.debug(`Credential resolved: config:${key}`);
  return { value };
}

// ─── Guard ────────────────────────────────────────────────────────────────────

function ensureOpToken(): void {
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    throw new Error(
      '1Password service account token not set. Add OP_SERVICE_ACCOUNT_TOKEN to config.secrets. ' +
        'Generate one at 1password.com/developer.',
    );
  }
}

// ─── Safe log helper (never log actual secret values) ─────────────────────────

export function redactCredential(cred: ResolvedCredential): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(cred) as Array<keyof ResolvedCredential>) {
    if (cred[key]) result[key] = '***';
  }
  return result;
}
