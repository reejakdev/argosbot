# Argos

> **Read by default. Sanitize before memory. Approve before action.**

Argos is a local-first AI assistant for fintech/crypto companies.
It observes, classifies, proposes — and never acts without human approval.

Named after *Argos Panoptes*, the hundred-eyed giant of Greek mythology
who never slept and guarded everything — but acted only on Zeus's orders.

---

## Instructions for Claude Code

Tu es le stagiaire technique d'Argos. Tu dois etre **proactif**, **force de proposition**, et **autonome**.
Ton objectif: faire avancer le projet comme un dev senior le ferait — pas juste repondre aux questions.

### Comportement attendu

- **Propose des ameliorations** quand tu vois du code qui peut etre mieux — ne te contente pas de faire ce qu'on te dit
- **Anticipe les problemes** — si un changement risque de casser autre chose, dis-le AVANT
- **Pense architecture** — chaque feature doit s'integrer proprement dans le systeme existant
- **Sois concis** — pas de blabla, va droit au but, montre le code
- **Challenge les decisions** — si une approche te semble sous-optimale, propose une alternative avec tes arguments
- **Connais le domaine** — fintech, crypto, custody, compliance. Utilise le vocabulaire metier

### Quand tu travailles sur Argos

1. **Lis toujours le code existant** avant de modifier — comprends le pattern en place
2. **Respecte les conventions** du projet (voir section ci-dessous)
3. **Teste mentalement** — simule le flow complet: message → sanitize → classify → plan → approve → execute
4. **Pense securite** — chaque input externe est hostile. Chaque secret doit rester local
5. **Pense privacy** — Claude ne doit JAMAIS voir de donnees brutes, d'adresses, de montants exacts
6. **Documente les decisions non-evidentes** avec un commentaire inline, pas de JSDoc inutile

### Ce que tu dois faire spontanement

- Signaler les failles de securite quand tu en vois
- Proposer des tests pour le code critique (anonymizer, sanitizer, approval gateway)
- Suggerer des optimisations de prompts LLM quand tu touches au classifier/planner
- Alerter si un changement casse le contrat privacy (raw content qui leak vers Claude/DB)
- Proposer des migrations DB quand un schema change est necessaire
- Verifier que les nouveaux workers respectent le pattern read-only par defaut

---

## Quick Reference

### Commands

```bash
npm run dev          # dev mode (tsx watch, hot reload)
npm run build        # TypeScript → dist/
npm start            # production (node dist/index.js)
npm run setup        # interactive setup wizard
npm run doctor       # diagnostic + health check
npm run anon-test    # test anonymizer patterns
```

### Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js >= 22, TypeScript 5.7 strict |
| LLM | Anthropic Claude (primary), OpenAI/compatible (fallback) |
| Database | SQLite (better-sqlite3, WAL mode, FTS5) |
| Web | Express 5, WebSocket (ws) |
| Auth | WebAuthn/FIDO2 (YubiKey), TOTP backup |
| Channels | Telegram MTProto (gramjs), WhatsApp (Baileys), Email (IMAP) |
| Integrations | Notion, Google Calendar, MCP servers |
| Validation | Zod schemas everywhere |
| IDs | ULID (monotonic, sortable) |

### Key Conventions

- **Module pattern**: ES modules (`"type": "module"` in package.json), imports with `.js` extension
- **Config**: Zod schema in `src/config/schema.ts`, loaded from `~/.argos/config.json` + `.env` overrides
- **DB access**: `getDb()` singleton, prepared statements only (never string concat SQL)
- **Logging**: `import log from '../logger.js'` → `log.info()`, `log.warn()`, `log.error()`, `log.debug()`
- **Audit trail**: `audit(event, entityId, entityType, data)` for every critical event — immutable
- **Error handling**: catch + log + audit, never crash the pipeline. Classifier errors → default safe (`category: 'info'`)
- **Types**: defined in `src/types.ts`, Zod schemas for runtime validation, TypeScript for compile-time
- **Workers**: must respect `config.readOnly` — default is read-only, no side effects without explicit toggle
- **Privacy**: raw content never stored, never sent to LLM without anonymization
- **Channels**: implement `Channel` interface, register via `registerChannel()`
- **Cron**: `registerHandler()` + `upsertCronJob()` in `src/scheduler/index.ts`

---

## Architecture

```
[Telegram / WhatsApp / Email / Bot]
        │
        ▼
[Injection sanitizer]       ← regex fast-screen + Claude deep scan
        │
        ▼
[Regex anonymizer]          ← ETH/BTC/SOL addrs, tx hashes, ENS, PII, amounts bucketed
        │
        ▼
[Context window]            ← batch up to 5 messages, 30s timer, reset on message
        │
        ▼
[Claude classifier]         ← category, team routing, isMyTask, completion detection
        │
        ├──→ [Memory store]  ← SQLite FTS5, TTL 7d, archive flag
        │
        ▼
[Claude planner]            ← tool use: draft_reply, calendar, notion, tx_prep, reminder
        │
        ▼
[Approval gateway]          ← Telegram Saved Messages + web app (YubiKey/WebAuthn)
        │  (human approves)
        ▼
[Workers]                   ← calendar, notion, tx_prep, reply (read-only by default)
        │
        └──→ Task lifecycle updated
```

### Data Flow Rules (CRITICAL)

1. **Raw content** → exists only in memory during processing, NEVER persisted
2. **Sanitized content** → injection-checked, still contains real data
3. **Anonymized content** → all PII/crypto replaced with placeholders (`[ADDR_1]`, `[AMT_10K-100K_USDC]`)
4. **Only anonymized content** reaches Claude and the database
5. **Lookup table** (placeholder → real value) exists only in local memory, never sent to LLM

---

## Project Structure

```
src/
├── index.ts                    # Entry point — bootstraps pipeline
├── types.ts                    # Domain types (RawMessage, Proposal, etc.)
├── logger.ts                   # Structured logging (info/warn/error/debug)
│
├── config/
│   ├── schema.ts               # Zod config schema (~270 lines)
│   └── index.ts                # Config loader, env merge, path resolution
│
├── db/
│   └── index.ts                # SQLite init, migrations, audit()
│
├── core/
│   ├── pipeline.ts             # Main pipeline orchestrator (ingestMessage + processWindow)
│   ├── privacy.ts              # LLM routing per role (cloud vs local)
│   ├── triage.ts               # Fast pre-screen classifier
│   ├── triage-sink.ts          # Routes triage results to tasks/proposals
│   └── heartbeat.ts            # Proactive monitoring (runHeartbeat, runProactivePlan)
│
├── ingestion/
│   ├── channels/
│   │   ├── registry.ts         # Channel registry pattern
│   │   ├── telegram.ts         # MTProto user client (gramjs)
│   │   ├── telegram-bot.ts     # Bot-mode alternative
│   │   ├── whatsapp.ts         # Baileys integration
│   │   └── email.ts            # IMAP client
│   ├── classifier.ts           # Claude classifier (zero-temp)
│   └── context-window.ts       # Message batching (1-5 msgs, 30s window)
│
├── privacy/
│   ├── sanitizer.ts            # Injection detection (regex + Claude)
│   ├── anonymizer.ts           # Regex PII/crypto redaction
│   ├── chat-guard.ts           # Content filtering
│   └── llm-anonymizer.ts       # LLM-assisted anonymization (local model)
│
├── llm/
│   ├── index.ts                # Multi-provider abstraction (Anthropic/OpenAI/compatible)
│   ├── tool-loop.ts            # Tool use loop with streaming
│   ├── builtin-tools.ts        # Built-in tools (web_search, fetch_url, api_call, etc.)
│   └── compaction.ts           # Conversation summarization
│
├── embeddings/
│   └── index.ts                # Embedding provider (OpenAI-compatible /v1/embeddings)
│
├── vector/
│   └── store.ts                # LanceDB semantic search (chunkText, indexChunks, semanticSearch)
│
├── knowledge/
│   ├── index.ts                # Knowledge layer — load + refresh sources
│   ├── indexer.ts              # Upsert docs into SQLite + LanceDB
│   ├── types.ts                # KnowledgeDocument, KnowledgeConnector interfaces
│   └── connectors/
│       ├── url.ts              # URL connector (fetch + HTML strip)
│       ├── github.ts           # GitHub connector (file paths via API)
│       └── notion.ts           # Notion connector (page + database)
│
├── planner/
│   └── index.ts                # Proposal generation (tool use: draft_reply, calendar, etc.)
│
├── memory/
│   └── store.ts                # FTS5 store, TTL, auto-archive (importance >= 8)
│
├── gateway/
│   └── approval.ts             # Approval flow, risk enforcement, expiry
│
├── workers/
│   ├── index.ts                # Worker dispatcher + read-only enforcement
│   ├── calendar.ts             # Google Calendar
│   ├── notion.ts               # Notion workspace
│   ├── tx-prep.ts              # Transaction review packs (read-only)
│   └── proposal-executor.ts    # Execute approved proposals (LLM agent)
│
├── scheduler/
│   └── index.ts                # Cron jobs + event chaining
│
├── skills/
│   ├── registry.ts             # Skill tool registry (opt-in via config)
│   └── builtins/               # memory-search, notion-search, web-search, crypto-price, fetch-url
│
├── mcp/
│   ├── index.ts                # MCP server lifecycle
│   └── client.ts               # MCP client connection
│
├── webapp/
│   ├── server.ts               # Express + API routes + WebSocket broadcast
│   ├── webauthn.ts             # FIDO2/YubiKey auth
│   └── totp.ts                 # TOTP 2FA backup
│
├── auth/
│   └── anthropic-oauth.ts      # Anthropic OAuth PKCE flow
│
├── plugins/
│   ├── registry.ts             # Plugin lifecycle (onBoot, onMessage, onShutdown)
│   ├── heartbeat/index.ts      # Heartbeat plugin (wires core/heartbeat.ts into plugin system)
│   ├── telegram/index.ts       # Telegram tools (add_chat, ignore_chat, list_chats)
│   └── examples/
│       └── raw-forwarder.ts    # Example: inject arbitrary messages into the pipeline
│
├── prompts/
│   └── index.ts                # System prompt builder (.md templates, role-based)
│
├── heartbeat/
│   └── index.ts                # Shim → core/heartbeat.ts (backward compat)
│
└── scripts/
    ├── setup.ts                # Interactive setup wizard
    ├── doctor.ts               # System health check
    └── anon-test.ts            # Anonymizer test utility
```

---

## Database Schema

SQLite at `~/.argos/argos.db` (WAL mode, foreign keys ON):

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `messages` | Ingested metadata (no raw content) | id, channel, chat_id, content_hash (SHA256), status |
| `context_windows` | Batched message groups | id, status (open/processing/done), messages JSON |
| `memories` | Anonymized summaries + FTS5 | id, summary, category, partner, importance, archived, expires_at |
| `tasks` | Detected actionable tasks | id, status (open/in_progress/completed/follow_up/cancelled), partner |
| `proposals` | Claude action plans | id, actions JSON, reasoning, status, risk_level |
| `approvals` | Approval tracking | id, proposal_id, status (pending/approved/rejected/expired) |
| `cron_jobs` | Scheduled background tasks | name, schedule, handler, config JSON |
| `chain_events` | Multi-step triggers | event_name, fired, expires_at |
| `webauthn_credentials` | Registered YubiKeys | cred_id, public_key, counter, device_name |
| `webauthn_sessions` | Auth sessions | token, clearance (standard/elevated), expires_at |
| `webauthn_challenges` | Pending challenges (5min, single-use) | id, challenge, used, expires_at |
| `audit_log` | Immutable event log | event, entity_id, entity_type, data JSON, created_at |
| `conversations` | Chat history | id, messages JSON, compacted_summary |

---

## Security Rules (NON-NEGOTIABLE)

1. **Prepared statements only** — NEVER concat user input into SQL
2. **No secrets in logs** — sanitize before `log.*()` if data could contain keys/tokens
3. **No raw content to Claude** — always anonymize first
4. **No raw content persisted** — only hashes and anonymized summaries in DB
5. **Validate all external input** — Zod schema or explicit check, no trust
6. **File permissions** — session files at 0o600 (owner-only)
7. **WebAuthn counter check** — prevent key cloning attacks
8. **Single-use challenges** — mark `used = 1` immediately after consumption
9. **Path traversal** — block `..` and absolute paths in file operations
10. **Internal network blocking** — `fetch_url` tool blocks localhost/private IPs
11. **env var injection** — `api_call` tool uses `{{KEY}}` pattern to inject from `process.env`, must whitelist allowed keys
12. **Approval binding** — high-risk proposals require fresh YubiKey assertion cryptographically bound to proposal ID
13. **No autonomous execution** — every action requires human approval, EXCEPT owner workspace ops (Notion, create_task, set_reminder) which auto-execute

---

## API Routes

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/register/begin` | Start WebAuthn registration |
| POST | `/auth/register/complete` | Complete + save YubiKey |
| POST | `/auth/login/begin` | Start auth challenge |
| POST | `/auth/login/complete` | Verify assertion + issue session |
| POST | `/auth/logout` | Revoke session |
| POST | `/auth/totp/setup` | TOTP QR code |
| POST | `/auth/totp/verify` | TOTP verification |
| POST | `/auth/totp/login` | TOTP login |

### Authenticated (require session)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | System overview |
| GET | `/tasks` | Open + in-progress tasks |
| GET | `/history` | Completed tasks + proposals |
| GET | `/proposals` | Pending approvals |
| GET | `/memories` | Recent memories |
| POST | `/proposals/:id/approve` | Approve (elevated auth for high-risk) |
| POST | `/proposals/:id/reject` | Reject proposal |

---

## Privacy Model

| Layer | Mechanism |
|-------|-----------|
| **Injection detector** | Regex (10 patterns) + Claude deep scan |
| **Anonymizer** | ETH/BTC/SOL addresses, tx hashes, ENS, amounts bucketed, emails, phones |
| **External tagging** | All external content wrapped in `<external_content source="...">` |
| **Memory TTL** | 7 days default, auto-purge cron at 03:00. Archive = 365 days |
| **Workers** | Read-only by default. Write mode = `config.readOnly = false` |
| **Notion** | Owner's workspace — auto-executes without approval (it's their own space) |
| **Audit log** | Immutable, append-only |

**What Claude never sees:** raw messages, exact amounts, blockchain addresses, names in `knownPersons`, API keys/secrets.

---

## Known Issues & Technical Debt

### Priority 1 — Security (FIXED)

| Issue | Status | Fix |
|-------|--------|-----|
| `api_call` env var injection | FIXED | Whitelist of allowed secret keys |
| `fetch_url` localhost bypass | FIXED | Proper URL parsing + hostname check |
| Secrets leaking in logs | FIXED | `sanitizeLogData()` redacts known patterns |
| No security headers | FIXED | X-Content-Type-Options, X-Frame-Options, CSP headers |
| No CORS | FIXED | Origin check against WEBAUTHN_ORIGIN |
| No rate limiting on auth | FIXED | IP-based rate limiter on /auth/* (10/min) |
| Cookie missing Secure flag | FIXED | Secure flag when HTTPS origin configured |

### Priority 2 — Robustness (FIXED)

| Issue | Status | Fix |
|-------|--------|-----|
| Silent `catch {}` in MCP | FIXED | Added `log.warn()` in catch blocks |
| No optimistic locking | FIXED | `WHERE status = 'approved'` on execution update |
| Draft reply false `dryRun: false` | FIXED | Always returns `dryRun: true` until implemented |
| Notion requires approval | FIXED | Owner workspace ops auto-execute (no approval needed) |

### Priority 2 — Robustness (REMAINING)

| Issue | Location | Impact |
|-------|----------|--------|
| Email channel connect failure silently continues | `src/ingestion/channels/email.ts:~101` | Silent failures |
| Fallback LLM provider defined in schema but never used | `src/llm/index.ts` | No resilience on provider outage |
| Temperature hardcoded to 0 in classifier, ignores config | `src/ingestion/classifier.ts:~143` | Config inconsistency |

### Priority 3 — Quality

| Issue | Location | Impact |
|-------|----------|--------|
| No unit/integration tests | — | Risk on refactors |
| No linter/formatter config (ESLint, Prettier) | — | Inconsistency risk |
| No CI/CD pipeline | — | No automated checks |
| No git repository initialized | — | No version history |
| No README.md (only CLAUDE.md) | — | OSS readiness |
| No `.gitignore` | — | Risk of committing secrets/node_modules |

---

## Roadmap

### v1 — Local, single user (DONE)

All core features implemented: channels (Telegram/WhatsApp/Email), sanitization, anonymization,
classification, planning, approval gateway, workers (calendar/notion/tx_prep), web app + WebAuthn,
cron jobs, event chaining, multi-LLM support, task lifecycle.

### v2 — Native app / Extended integrations (NEXT)

- [ ] React Native / Expo mobile app
- [ ] macOS menu bar app (Tauri)
- [ ] Linear worker
- [ ] GitHub read (PRs, issues)
- [ ] Slack / Discord channels
- [ ] Fordefi simulation API
- [ ] On-chain data reads (RPC)
- [ ] Vector search (LanceDB)

### v3 — Multi-user / Enterprise

- [ ] Multi-employee (one instance, many users)
- [ ] Telegram bot mode for orgs
- [ ] Docker image
- [ ] SOC2 / audit export
- [ ] SSO / SAML
- [ ] White-label

---

## Design Principles

1. **Read by default** — observe everything, act on nothing without approval
2. **Sanitize before memory** — raw content never reaches Claude or storage
3. **Approve before execute** — every action has a human checkpoint with expiry
4. **Minimal permissions** — each worker has least-privilege access
5. **Local first** — all data stays on your machine
6. **Auditable** — every event in `audit_log`, nothing hidden
7. **Composable** — registry pattern for channels, workers, cron, skills

---

## License

MIT
