# Security Model

> **Argos was designed around a single threat model: you are the only person who should ever approve actions. Everything else is defense in depth.**

---

## Approval flow

Every action Argos proposes goes through two independent gates:

```
Proposal created
      │
      ▼
[Gate 1: Human approval]
  Telegram / Slack / web app
  (YubiKey required for medium/high risk — or all if cloudMode: true)
      │
      ▼
[Gate 2: Ephemeral execution token]
  32 random bytes, single-use, 5-minute TTL
  Generated at approval time, consumed at execution time
  Workers are blocked without it — even if DB status is manually set to "approved"
      │
      ▼
[Execution]
```

**Why two gates?** Gate 1 can be bypassed if the database is compromised (an attacker could directly set `status = 'approved'`). Gate 2 prevents that — the token is generated only in-process at human approval time and never stored in a way that allows replay.

---

## Risk levels

Actions are classified by risk:

| Risk | Requires YubiKey | Examples |
|------|-----------------|---------|
| `low` | No (Telegram/Slack approve OK) | Send a reply draft, create a task |
| `medium` | Yes | Calendar event, Notion page update |
| `high` | Yes | Transaction prep, external API call |

In `cloudMode: true`, YubiKey is required for **all** risk levels. Enable this when Argos runs on a VPS or server you access remotely.

```json
"security": { "cloudMode": true }
```

---

## YubiKey / WebAuthn setup

### First-time registration

1. Start Argos: `npm run dev`
2. Open `https://localhost:3000` (or your configured origin)
3. Click **Register security key**
4. Name it (e.g. "YubiKey 5C")
5. Tap the key when prompted

You can register multiple keys (e.g. one at home + one at the office as backup).

### High-risk approvals

For medium/high-risk actions, the web app prompts for a **fresh YubiKey assertion** bound to the specific proposal ID. This means:
- An old session cannot be reused
- The key physically must be present at approval time
- The signature covers the proposal ID — a compromised session cannot approve a different proposal

### TOTP backup

If you lose your YubiKey, TOTP (authenticator app) is available as a backup:

```bash
npm run setup  # → security → TOTP setup
```

Or via the web app → Settings → TOTP. Scan the QR code with any TOTP app (Authy, Google Authenticator, 1Password).

---

## Secrets storage

Secrets (API keys, tokens) are stored in:

1. **System keychain** (primary) — macOS Keychain, GNOME Keyring, Windows Credential Manager
   - Never touches the filesystem
   - Protected by OS-level access controls
   - `keytar` npm package is used as the interface

2. **`~/.argos/secrets.json`** (fallback for headless/VPS) — file at `0o600` permissions
   - Used when keytar is unavailable (headless Linux without libsecret)
   - Never stored in config.json or committed to git

Config values starting with `$` are secret references:
```json
{ "apiKey": "$ANTHROPIC_API_KEY" }
```
The actual value is resolved at runtime from the store.

### Verifying secret storage

```bash
npm run doctor
```

Look for the `Secrets store` line — it shows whether keychain or file backend is active, and how many secrets are loaded.

---

## Audit log

Every critical event is written to an **append-only, tamper-evident audit log**:

```
proposal.created   proposal.approved   proposal.executed
task.created       task.completed
message.ingested   session.created     auth.failed
```

### Hash chain

Each entry includes:
- `prev_hash` — hash of the previous entry
- `entry_hash` — SHA-256(`id + event + entity + data + created_at + prev_hash`)

If any entry is modified or deleted, the chain breaks. Verify integrity:

```bash
npm run verify-audit
```

```
✓  Audit chain intact — 142 entries verified
   First: 2024-01-15T10:23:11Z  proposal.created
   Last:  2024-03-01T14:55:02Z  session.created
```

If tampering is detected:
```
✗  Chain broken at entry 87 / 142
   ID:    01HXXXXXX
   Event: proposal.executed
   Expected prev_hash: a1b2c3...
   Got:               deadbe...
```

---

## cloudMode — VPS deployment

When running Argos on a remote server:

1. Set `security.cloudMode: true` in config
2. Configure Cloudflare Tunnel to expose the web app without opening ports
3. Use a proper domain with a valid TLS cert (Cloudflare handles this)
4. All approvals require physical YubiKey presence — no Telegram shortcut

```json
"security": { "cloudMode": true },
"webapp": {
  "webauthnRpId": "argos.yourdomain.com",
  "webauthnOrigin": "https://argos.yourdomain.com",
  "port": 3000
}
```

---

## Security headers

The web app sets:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: default-src 'self'; ...
```

---

## Input validation rules

| Threat | Mitigation |
|--------|-----------|
| SQL injection | Prepared statements only — no string concatenation |
| Path traversal | `../` and absolute paths blocked in all file ops |
| SSRF via fetch_url | Localhost / private IPs blocked by URL parser |
| Prompt injection | Injection detector (regex + optional LLM scan) before any content reaches the pipeline |
| XSS | CSP headers + React's built-in escaping |
| Session fixation | Sessions bound to IP + user agent hash |
| CSRF | SameSite=Strict cookies + Origin check on all mutation endpoints |
| Brute force | Rate limiting: 10 auth attempts/min per IP |
| Key cloning | WebAuthn counter check on every assertion |
| Replay attacks | Single-use challenges (5-minute TTL) |

---

## What Claude never sees

- Raw message content (addresses, amounts, names, phone numbers)
- API keys, tokens, or secrets
- Session tokens
- Raw file content (only anonymized chunks)

See [privacy.md](./privacy.md) for the full anonymization pipeline.

---

## Reporting vulnerabilities

Open an issue at the project repository and label it `security`.
For high-severity findings, use the GitHub private vulnerability reporting feature.
