# Getting Started

> **5 minutes to your first running Argos instance.**

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | ≥ 22 | `nvm install 22` if needed |
| npm | ≥ 10 | bundled with Node 22 |
| An LLM API key | — | Anthropic recommended. Ollama for local/offline |
| A notification channel | — | Telegram Bot **or** Slack Bot **or** web app only |

---

## 1. Clone and install

```bash
git clone https://github.com/argos-ai/argos
cd argos
npm install
```

---

## 2. Run the setup wizard

```bash
npm run setup
```

The wizard walks you through every step interactively:

| Step | What it does |
|------|--------------|
| **1 — LLM provider** | Pick your AI provider and enter the API key (stored in system keychain) |
| **2 — Web app access** | Configure HTTPS + WebAuthn origin for the approval dashboard |
| **3 — Owner profile** | Your name and Telegram user ID (for routing) |
| **4 — Approval channel** | Telegram Bot / Slack Bot / Discord / web app only |
| **5 — Telegram listener** | Optional — read your personal Telegram messages via MTProto |
| **6 — Integrations** | Notion, Google Calendar, Linear, email — all optional |

Config is saved to `~/.argos/config.json`.
Secrets (API keys, tokens) go into your **system keychain** (macOS Keychain / GNOME Keyring) or `~/.argos/secrets.json` if the keychain is unavailable.

---

## 3. Register your YubiKey (or passkey)

Start Argos for the first time:

```bash
npm run dev
```

Then open the web app in your browser:

```
http://localhost:3000
```

You'll be prompted to register a security key. Tap your YubiKey (or use a passkey on your device). This becomes your authentication for approving high-risk actions.

> **HTTPS required for WebAuthn on non-localhost.**
> If accessing from your phone on the LAN, run `npm run setup` → step 2 and let the wizard generate a TLS cert with mkcert.

---

## 4. Verify everything is working

```bash
npm run doctor        # full health check
npm run doctor --fix  # shows actionable fix commands for each issue
npm run doctor --llm  # additionally tests a live LLM API call
npm run doctor --all  # includes optional integrations
```

Expected output when healthy:

```
  ✓  Node.js           v22.x.x
  ✓  Data directory    ~/.argos
  ✓  Secrets store     system keychain · 4 secrets loaded
  ✓  Config — LLM      anthropic  claude-opus-4-6  (key: ✓)
  ✓  Approval channel  Telegram Bot  (token: ✓)
  ✓  Database          16 tables · 0 pending proposals · 0 open tasks
  ✓  Web app           https://localhost:3000  (rp: localhost)
  ✓  YubiKey           1 credential registered
  ✓  Audit chain       42 entries (all hashed)
```

---

## 5. Connect your first channel

Argos monitors your messages. To start, it needs at least one **listening channel**.

### Telegram MTProto (read your personal chats)

Go through the setup wizard → Telegram listener, or add manually to `~/.argos/config.json`:

```json
{
  "channels": {
    "telegram": {
      "listener": {
        "mode": "mtproto",
        "monitoredChats": [],
        "ignoredChats": []
      }
    }
  }
}
```

Get API credentials at [my.telegram.org](https://my.telegram.org) → API development tools.

### Other channels

See [integrations.md](./integrations.md) for Slack, Discord, WhatsApp, Email, and Signal setup.

---

## 6. Watch it work

```bash
npm run status        # live DB snapshot (proposals, tasks, memories)
npm run status --watch # auto-refresh every 5s
```

When Argos detects something actionable, it:
1. Classifies the message
2. Proposes an action (with a plan + risk level)
3. Sends you a notification via your approval channel
4. Waits for your approval before doing anything

Approve in Telegram/Slack/web app — Argos executes. Reject — nothing happens.

---

## Next steps

- [configuration.md](./configuration.md) — full config reference
- [security.md](./security.md) — YubiKey setup, cloudMode, audit log
- [integrations.md](./integrations.md) — all supported channels and services
- [privacy.md](./privacy.md) — how the privacy pipeline works
