# Argos

> **Read by default. Sanitize before memory. Approve before action.**

A local-first AI ops layer for one person — it watches your messages, proposes actions, and never executes without your sign-off. Raw data never leaves your machine.

![Argos dashboard](docs/img/dashboard.png)

---

## Install

Requires Node.js >= 22 and an Anthropic API key (or any supported provider, including local Ollama).

```bash
git clone <repo> argos
cd argos
npm install
npm run setup    # interactive wizard: channels, LLM, integrations
npm run dev      # hot reload — or `npm start` for production
```

Config lives at `~/.argos/config.json`. Run `npm run doctor` any time to health-check the install.

---

## First message

Once `npm run dev` is running and Telegram is linked:

1. Send yourself a message like *"Remind me to review the Acme contract tomorrow at 10am."*
2. The pipeline sanitizes → anonymizes → classifies → plans.
3. Argos posts a proposal in your Telegram Saved Messages (and the web app at `https://localhost:3000`).
4. You tap **Approve**. The reminder is created. Nothing happens until you do.

That round-trip is the whole product. Everything else is more channels, more workers, more context.

---

## Features

- 📥 **Multi-channel ingestion** — Telegram, WhatsApp, Email/IMAP, Discord, Slack
- 🛡️ **Injection sanitizer** — regex fast-screen + LLM deep scan on every inbound message
- 🕵️ **Anonymizer** — strips addresses, tx hashes, amounts, emails, phones before any LLM call
- 🧠 **Memory + RAG** — SQLite FTS5 + LanceDB hybrid search over messages, conversations, knowledge sources
- ✅ **Approval gateway** — every action requires human approval; high-risk needs a fresh YubiKey assertion
- 🔌 **Workers** — Calendar, Notion, Linear, GitHub, tx-prep, draft replies (read-only by default)
- 🗝️ **Multi-LLM** — Anthropic, OpenAI, Gemini, Groq, DeepSeek, Mistral, xAI, Qwen, Ollama, LM Studio, custom
- 📋 **Tamper-evident audit log** — hash-chained, verifiable via `npm run verify-audit`

---

## Privacy

| Stays local | Goes to cloud LLM |
|-------------|-------------------|
| Raw message content (never persisted) | Anonymized text only |
| Identifiers, addresses, amounts, emails, phones | `[ADDR_1]`, `[AMT_10K-100K]` placeholders |
| Lookup table (placeholder → real value) | — |
| SQLite DB, LanceDB vectors, session files | — |

For maximum privacy, configure a local Ollama model as a second anonymization pass (`privacy.provider: "ollama"`). The cloud LLM then only ever sees text already scrubbed by both regex and a local model.

---

## Architecture

```
[Telegram / WhatsApp / Email / Discord / Slack]
        │
        ▼
  Sanitizer  →  Anonymizer  →  Context window (5 msgs / 30s)
        │
        ▼
  Classifier  →  Memory (SQLite FTS5 + LanceDB)
        │
        ▼
  Planner  →  Approval gateway (Telegram + web app + YubiKey)
        │  (you approve)
        ▼
  Workers (calendar, notion, linear, reply, tx-prep)
```

---

## Configuration

The setup wizard covers 90% of cases. For everything else, see [docs/configuration.md](./docs/configuration.md) for the full schema reference.

Common pointers:

- [docs/getting-started.md](./docs/getting-started.md) — install + first run walkthrough
- [docs/privacy.md](./docs/privacy.md) — anonymization pipeline + local-LLM setup
- [docs/security.md](./docs/security.md) — YubiKey, cloudMode, audit log
- [docs/integrations.md](./docs/integrations.md) — every channel, worker and MCP server

Useful commands:

```bash
npm run doctor          # health check (--fix, --llm, --all)
npm run status          # live snapshot of proposals/tasks/memories
npm run verify-audit    # verify audit log hash chain
npm run anon-test       # test anonymizer patterns on a string
```

---

## Roadmap

- **v1 — Local, single user** (current) — channels, privacy pipeline, approval gateway, YubiKey, workers, memory, knowledge base. Shipped.
- **v2 — Omniscience + extended channels** (~85%) — wallet monitoring, Linear/GitHub/Drive connectors, proactive heartbeat, Slack/Discord bot mode.
- **v2.5 — Cloud-ready solo** — `security.cloudMode` for VPS deploys, Cloudflare Tunnel + Zero Trust, hash-chained audit log.
- **v3 — Multi-user / enterprise** — split approval/execution services, D1-backed state, SSO/SAML, Docker, SOC2 export.

Open an issue if you want early access to v2.5 / v3 or have an enterprise use case.

---

## Contributing

PRs welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) before opening a non-trivial change. Run `npm run lint && npx vitest run` before pushing.

---

## License

MIT
