# Argos

> **Read by default. Sanitize before memory. Approve before action.**

Argos is a local-first AI assistant for fintech/crypto operators.
It monitors your Telegram, WhatsApp, and email — classifies messages, detects tasks, and proposes actions for your approval. Nothing executes without you.

Named after *Argos Panoptes*, the hundred-eyed giant who never slept — but acted only on orders.

---

## Requirements

- Node.js >= 22
- [Ollama](https://ollama.ai) (optional — for local embeddings and privacy LLM roles)
- A Telegram account with API credentials ([my.telegram.org](https://my.telegram.org))
- An Anthropic API key or Claude OAuth token

---

## Install

```bash
git clone <repo>
cd argos
npm install
```

---

## Setup

Run the interactive wizard:

```bash
npm run setup
```

This creates `~/.argos/config.json` with your channels, LLM provider, and integrations.

Or copy the config template manually:

```bash
cp config.example.json ~/.argos/config.json
# then edit it
```

### Minimum config to start

```json
{
  "llm": {
    "activeProvider": "anthropic",
    "activeModel": "claude-sonnet-4-6",
    "providers": {
      "anthropic": {
        "name": "Anthropic",
        "api": "anthropic",
        "auth": "apikey",
        "apiKey": "sk-ant-..."
      }
    }
  },
  "secrets": {
    "TELEGRAM_API_ID": "12345678",
    "TELEGRAM_API_HASH": "your_hash_here"
  },
  "owner": {
    "name": "Your Name",
    "telegramUserId": 0
  }
}
```

> **Note:** `owner.telegramUserId` is your Telegram user ID — not your phone number.
> Find it by messaging [@userinfobot](https://t.me/userinfobot) on Telegram.

---

## Start

```bash
npm run dev      # development (hot reload)
npm start        # production
```

On first run with Telegram MTProto, you'll be prompted to enter your phone number and OTP to authenticate. The session is saved locally at `~/.argos/telegram_session`.

---

## Web app

The approval dashboard runs at `https://localhost:3000` (TLS required for WebAuthn).

For local TLS, generate a self-signed cert:

```bash
mkdir -p ~/.argos/tls
openssl req -x509 -newkey rsa:4096 -keyout ~/.argos/tls/key.pem \
  -out ~/.argos/tls/cert.pem -days 365 -nodes \
  -subj "/CN=localhost"
```

Then set in config:

```json
"webapp": {
  "port": 3000,
  "webauthnRpId": "localhost",
  "webauthnOrigin": "https://localhost:3000",
  "tlsCert": "~/.argos/tls/cert.pem",
  "tlsKey": "~/.argos/tls/key.pem"
}
```

---

## Health check

```bash
npm run doctor
```

---

## Integrations

All integrations are opt-in via `~/.argos/config.json`.

| Integration | Config key | Notes |
|-------------|-----------|-------|
| Telegram MTProto | `channels.telegram.listener` | Reads your messages |
| Telegram Bot | `secrets.TELEGRAM_BOT_TOKEN` | Bot mode (no MTProto needed) |
| WhatsApp | `secrets.WHATSAPP_ENABLED=true` | Requires QR scan on first run |
| Email (IMAP) | `channels.email` | Gmail/Outlook compatible |
| Notion | `mcpServers` → notion-mcp | Official Notion MCP server |
| Google Calendar | `secrets.GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` | OAuth2 |
| Browser | `mcpServers` → puppeteer | Local headless browser |

For MCP integrations (Notion, browser, Linear, etc.) — add entries to `mcpServers` in config.
The full catalog is in `src/mcp/index.ts`.

---

## Local embeddings (Ollama)

Vector search requires Ollama running with `nomic-embed-text`:

```bash
ollama pull nomic-embed-text
ollama serve
```

Then in config:

```json
"embeddings": {
  "enabled": true,
  "baseUrl": "http://localhost:11434",
  "model": "nomic-embed-text"
}
```

---

## Privacy model

- Raw messages → never stored, never sent to LLM
- All PII (addresses, amounts, names) → anonymized with placeholders before Claude sees anything
- Lookup table (placeholder → real value) → local memory only, never persisted
- Approvals → you tap approve, Argos executes. Nothing runs on its own.

---

## Commands

```bash
npm run dev           # dev mode with hot reload
npm run build         # compile TypeScript
npm start             # run compiled build
npm run setup         # interactive setup wizard
npm run doctor        # health check
npm run anon-test     # test anonymizer on a string
```

---

## Data

All data lives in `~/.argos/`:

```
~/.argos/
├── config.json        # your config
├── argos.db           # SQLite database (messages, tasks, proposals, memory)
├── telegram_session   # Telegram MTProto session (keep private)
├── tls/               # TLS certs for web app
├── knowledge/         # drop reference files here (contracts, addresses, docs)
└── vectors/           # LanceDB vector store
```

---

## License

MIT
