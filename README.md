# Argos

> **Read by default. Sanitize before memory. Approve before action.**

A local-first AI operations layer for fintech and crypto teams.
Argos monitors your messages, classifies signals, and proposes actions — you approve, it executes.
Raw data never leaves your machine. Nothing runs without your sign-off.

Named after *Argos Panoptes* — the hundred-eyed giant who never slept, but acted only on orders.

---

## What it does

```
[Telegram / WhatsApp / Email / Discord / Slack]
         │
         ▼
  Injection detector        fast regex screen + Claude deep scan
         │
         ▼
  Regex anonymizer          ETH/BTC addresses, tx hashes, amounts, PII → placeholders
         │
         ▼
  Context window            batch up to 5 messages, 30s timer
         │
         ▼
  Claude classifier         category, routing, isMyTask, completion
         │
         ├──→ Memory store  SQLite FTS5, TTL-based, archive flag
         │
         ▼
  Claude planner            tool use: draft_reply, calendar, notion, tx_prep
         │
         ▼
  Approval gateway          Telegram + web app (YubiKey / TOTP)
         │  (you approve)
         ▼
  Workers                   calendar, notion, reply — read-only by default
```

Claude never sees raw messages, addresses, amounts, or any identifying data.

---

## Key capabilities

**Signal detection**
- Classifies every message: task, tx request, question, info, follow-up, spam
- Detects actionable items and routes them to the right team
- Identifies partner names, chains, assets, urgency from anonymized context

**Knowledge base + RAG**
- Index any GitHub repo, URL, or local file into a semantic + keyword search store
- `chunkCode()` splits structured configs (Solidity addresses, ABIs) at brace boundaries — keeps contract names and addresses in the same chunk
- Hybrid search: semantic (LanceDB) + FTS5 keyword boost, ranked by relevance

**Whitelist verification — DOCS FIRST**
- Receives a transaction whitelist request from a partner
- Searches official protocol docs for the contract address
- Returns APPROVE / MANUAL_REVIEW / REJECT with a confidence score and source links
- Burns addresses always rejected. Unknown addresses flagged for manual review.

**Memory**
- Every classified window is summarized and stored with TTL
- High-importance items auto-archived (no expiry)
- FTS5 keyword search + semantic recall via LanceDB
- Purge cron cleans expired entries from both SQLite and LanceDB

**Approval gateway**
- Every proposed action requires explicit approval
- High-risk proposals require a fresh YubiKey assertion bound to the proposal ID
- Approvals expire — stale approvals are rejected

**Privacy model**
- Raw content: never stored, never sent to any LLM
- Regex anonymizer strips addresses, amounts, ENS names, emails, phones before classification
- Optional local LLM (Ollama) as a second anonymization pass for stronger coverage
- Cloud LLM only ever sees anonymized text with `[ADDR_1]` / `[AMT_10K-100K_USDC]` placeholders

---

## Requirements

- Node.js >= 22
- Anthropic API key (or any supported provider — including Ollama for full local mode)
- Telegram API credentials ([my.telegram.org](https://my.telegram.org))

---

## Install

```bash
git clone <repo>
cd argos
npm install
npm run setup    # interactive wizard — channels, LLM, integrations
npm run dev      # hot reload dev mode
```

Config lives at `~/.argos/config.json`.

---

## LLM providers

| Provider | `activeProvider` | Notes |
|----------|-----------------|-------|
| Anthropic (API key) | `anthropic` | Claude Opus/Sonnet/Haiku |
| Anthropic (OAuth) | `anthropic-oauth` | Claude Pro/Max — no API key needed |
| OpenAI | `openai` | GPT-4o, o1, o3-mini |
| Google Gemini | `gemini` | 2.0 Flash, 1.5 Pro |
| Groq | `groq` | Llama 3.3, Mixtral — fast |
| DeepSeek | `deepseek` | V3, R1 reasoner |
| Mistral | `mistral` | Large, Small, Codestral |
| xAI | `xai` | Grok 2 |
| Qwen | `qwen` | qwen-max, qwen-plus, qwen-turbo |
| Together AI | `together` | Llama, Mixtral, Qwen hosted |
| Perplexity | `perplexity` | Sonar — web-grounded responses |
| Cohere | `cohere` | Command R+ |
| Ollama | `ollama` | Fully local — Llama, Qwen, Mistral… |
| LM Studio | `lmstudio` | Local GUI — any GGUF model |
| OpenAI-compatible | `custom` | Point `baseUrl` to your endpoint |

Fallback provider supported — automatic failover if primary is down.

---

## Minimum config

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

Find your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).

---

## Local anonymization (recommended)

For the strongest privacy guarantee, run a local model as a second anonymization pass after the regex layer. If not configured, only the regex anonymizer runs — the LLM pass is opt-in.

```bash
ollama pull qwen2.5:7b
ollama serve
```

Declare the Ollama provider and configure the `privacy` block:

```json
"llm": {
  "providers": {
    "ollama": {
      "name": "Ollama",
      "api": "compatible",
      "auth": "none",
      "baseUrl": "http://localhost:11434/v1",
      "models": ["qwen2.5:7b"]
    }
  }
},
"privacy": {
  "provider": "ollama",
  "model": "qwen2.5:7b",
  "roles": {
    "sanitize": "privacy",
    "llmAnon":  "privacy",
    "classify": "privacy",
    "triage":   "privacy",
    "plan":     "primary"
  }
}
```

Flow: **local model anonymizes → anonymized text goes to Claude**. Cloud LLM never sees raw data.

---

## Vector search (semantic RAG)

Requires Ollama with an embedding model:

```bash
ollama pull nomic-embed-text
```

```json
"embeddings": {
  "enabled": true,
  "baseUrl": "http://localhost:11434",
  "model": "nomic-embed-text"
}
```

Once enabled, knowledge sources (GitHub repos, URLs, local files) are chunked and indexed into LanceDB. Hybrid search combines semantic similarity with keyword boosting from FTS5.

---

## Memory TTL

Default: 7 days. Configurable:

```json
"memory": {
  "defaultTtlDays": 7,
  "archiveTtlDays": 365,
  "autoArchiveThreshold": 8
}
```

Items with `importance >= autoArchiveThreshold` are permanently archived (no expiry). Archived items survive `purgeExpired`. Everything else is cleaned by the nightly cron.

---

## Security ownership rules

- Partners **cannot** trigger knowledge base indexing — only the owner can add content
- All partner-originated URLs are treated as hostile inputs
- The owner can ask the bot to index a URL or file via direct message
- High-risk proposals require a fresh YubiKey assertion cryptographically bound to the proposal ID

---

## Web app

Approval dashboard at `https://localhost:3000` (TLS required for WebAuthn):

```bash
mkdir -p ~/.argos/tls
openssl req -x509 -newkey rsa:4096 -keyout ~/.argos/tls/key.pem \
  -out ~/.argos/tls/cert.pem -days 365 -nodes -subj "/CN=localhost"
```

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

## Integrations

| Integration | Config | Notes |
|-------------|--------|-------|
| Telegram MTProto | `channels.telegram.listener` | Reads your personal messages |
| Telegram Bot | `secrets.TELEGRAM_BOT_TOKEN` | Bot mode — no MTProto needed |
| WhatsApp | `secrets.WHATSAPP_ENABLED=true` | QR scan on first run |
| Email (IMAP) | `channels.email` | Gmail / Outlook compatible |
| Discord | `secrets.DISCORD_BOT_TOKEN` | Bot reads channels it's added to |
| Slack | `secrets.SLACK_BOT_TOKEN` | Bot reads channels it's invited to |
| Notion | `mcpServers` → notion-mcp | Official Notion MCP server |
| Google Calendar | `secrets.GOOGLE_CLIENT_ID/SECRET` | OAuth2 |
| Gmail | `mcpServers` → gmail | Read, draft, send |
| Outlook | `mcpServers` → outlook | Read, draft, send via Graph API |
| 1Password | `mcpServers` → 1password | Read vault secrets |
| Browser | `mcpServers` → puppeteer | Local headless browser for scraping |
| Local files | `knowledge.sources` | `.txt`, `.md`, `.docx`, `.xlsx`, `.json`, `.csv` |

---

## Commands

```bash
npm run dev           # hot reload
npm run build         # compile TypeScript
npm start             # production
npm run setup         # interactive setup
npm run doctor        # health check + diagnostics
npm run anon-test     # test anonymizer patterns on a string
```

---

## Data

```
~/.argos/
├── config.json          your config (never commit this)
├── argos.db             SQLite — messages, tasks, proposals, memories, audit log
├── telegram_session     MTProto session (treat as a private key)
├── tls/                 TLS certs for the web app
├── knowledge/           drop reference files here for indexing
└── vectors/             LanceDB semantic store
```

---

## Tests

```bash
npx vitest run src/tests/
```

Covers: `chunkText`, `chunkCode` (brace-aware splitting, mBASIS bug regression), `storeQuick`, FTS5 search, archive, `purgeExpired`, `formatVerificationNotif` (whitelist score bar, decision icons).

---

## License

MIT
