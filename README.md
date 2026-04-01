# Argos

> **Read by default. Sanitize before memory. Approve before action.**

Argos is a privacy-first AI assistant that monitors your messages across Telegram, WhatsApp, email, Slack, and Discord — classifies them, detects tasks, and proposes actions for your approval. Nothing executes without you.

All data stays on your machine. Raw messages are anonymized before reaching any LLM — cloud or local. Argos is designed to mix models: use a capable cloud model (Claude, GPT-4o) for reasoning and tool use, while routing sensitive content through a local model (Ollama) for privacy-critical roles.

Named after *Argos Panoptes*, the hundred-eyed giant who never slept — but acted only on orders.

---

## Requirements

- Node.js >= 22
- [Ollama](https://ollama.ai) (optional — for local embeddings and privacy LLM roles)
- A Telegram account with API credentials ([my.telegram.org](https://my.telegram.org))
- An API key for any supported LLM provider (Anthropic, OpenAI, Groq, Qwen, etc.) — or Ollama for fully local usage

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

### Supported LLM providers

Argos works with any LLM — cloud or local. The setup wizard lets you pick one interactively.

| Provider | `activeProvider` | Notes |
|----------|-----------------|-------|
| Anthropic (API key) | `anthropic` | Claude Opus/Sonnet/Haiku |
| Anthropic (OAuth) | `anthropic-oauth` | Claude Pro/Max subscription, no API key |
| OpenAI | `openai` | GPT-4o, o1, o3-mini |
| Google Gemini | `gemini` | 2.0 Flash, 1.5 Pro |
| Groq | `groq` | Llama 3.3, Mixtral — fast inference |
| DeepSeek | `deepseek` | V3, R1 reasoner |
| Mistral | `mistral` | Large, Small, Codestral |
| xAI | `xai` | Grok 2 |
| Alibaba Qwen | `qwen` | qwen-max, qwen-plus, qwen-turbo |
| Together AI | `together` | Llama, Mixtral, Qwen hosted |
| Perplexity | `perplexity` | Sonar — web-grounded |
| Cohere | `cohere` | Command R+ |
| Ollama | `ollama` | Local — Llama, Qwen, DeepSeek, Mistral… |
| LM Studio | `lmstudio` | Local GUI — any GGUF model |
| Any OpenAI-compatible | `custom` | Set `baseUrl` to your endpoint |

You can also configure a **fallback provider** — if the primary fails, Argos automatically switches:

```json
"llm": {
  "activeProvider": "anthropic",
  "activeModel": "claude-sonnet-4-6",
  "fallbackProvider": "ollama",
  "fallbackModel": "qwen3.5:9b"
}
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
        "auth": "api-key",
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
| Email (IMAP) | `channels.email` | Gmail/Outlook compatible — read/classify |
| Email (SMTP) | `smtp` | Send emails — requires approval before sending |
| Discord | `secrets.DISCORD_BOT_TOKEN` | Bot reads channels you add it to |
| Slack | `secrets.SLACK_BOT_TOKEN` | Bot reads channels it's invited to |
| Notion | `mcpServers` → notion-mcp | Official Notion MCP server |
| Google Calendar | `secrets.GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` | OAuth2 |
| Gmail (MCP) | `mcpServers` → gmail | Read, draft, send via Google OAuth |
| Outlook (MCP) | `mcpServers` → outlook | Read, draft, send via Microsoft Graph |
| 1Password (MCP) | `mcpServers` → 1password | Read vault secrets (service account token) |
| Browser | `mcpServers` → puppeteer | Local headless browser |

### SMTP config example

```json
"smtp": {
  "host": "smtp.gmail.com",
  "port": 587,
  "secure": false,
  "user": "you@gmail.com",
  "password": "your_app_password",
  "fromName": "Your Name"
}
```

For MCP integrations — add entries to `mcpServers` in config.
The full catalog is in `src/mcp/index.ts`.

---

## Local model for anonymization (recommended)

Before any message reaches a cloud LLM (Claude, GPT-4o, etc.), Argos runs a regex-based anonymizer to strip addresses, amounts, and known PII. For stronger privacy, you should also run a **local LLM as a second anonymization pass** — it catches patterns the regex misses (implicit references, context-dependent identifiers).

This is the most important privacy safeguard: your raw messages never leave your machine.

```bash
ollama pull qwen2.5:7b   # or llama3.2:3b, mistral:7b — any instruction-following model works
ollama serve
```

Then set the `llmAnonymizer` role in config:

```json
"llm": {
  "activeProvider": "anthropic",
  "activeModel": "claude-sonnet-4-6",
  "roles": {
    "llmAnonymizer": {
      "provider": "ollama",
      "model": "qwen2.5:7b",
      "baseUrl": "http://localhost:11434"
    }
  }
}
```

With this setup: **local model anonymizes → anonymized text sent to Claude**. Claude never sees raw names, addresses, amounts, or any identifying data.

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
