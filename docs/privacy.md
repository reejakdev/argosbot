# Privacy Model

> **Claude never sees raw messages, addresses, amounts, or any identifying data.**

Argos is built on the principle that privacy is a first-class citizen, not an afterthought. The pipeline has multiple layers of protection, each independent of the others.

---

## Data flow

```
[Raw message arrives]
        │
        ▼
[1. Injection detector]
   Fast regex + optional deep LLM scan
   Blocks prompt injection attempts before they reach any processing
        │
        ▼  (passes injection check)
[2. Regex anonymizer]
   Replaces crypto addresses, amounts, emails, phones, ENS names
   with deterministic placeholders: [ADDR_1], [AMT_10K-100K_USDC]
        │
        ▼
[3. LLM anonymizer — optional]
   Second pass with a LOCAL model (Ollama)
   Catches what regex misses: informal number expressions, code names, etc.
   Only runs if privacy.provider is configured
        │
        ▼  (fully anonymized)
[4. Context window]
   Batches 1–5 messages, 30s timer
        │
        ▼
[5. Claude classifier] ← sees only anonymized text + [ADDR_1] placeholders
   category, team routing, isMyTask, completion detection
        │
        ├──→ [Memory store]  ← stores anonymized summaries only
        │
        ▼
[6. Claude planner] ← sees anonymized context + memory + knowledge
   Proposes actions using [ADDR_1] etc.
        │
        ▼
[7. Approval gateway]
   Human approves with full context (de-anonymized locally, never sent out)
        │
        ▼
[8. Worker execution]  ← workers receive real values from local lookup table
```

---

## What gets anonymized

### Crypto

| Pattern | Example | Placeholder |
|---------|---------|-------------|
| Ethereum addresses | `0xAbCd...1234` | `[ADDR_1]` |
| Bitcoin addresses | `1BvBMSEYstWet...` | `[BTC_ADDR_1]` |
| Solana addresses | `4zMMC9srt5...` | `[SOL_ADDR_1]` |
| ENS names | `alice.eth` | `[ENS_1]` |
| Transaction hashes | `0xabc123...` (64 hex) | `[TX_1]` |
| Amounts | `50,000 USDC` | `[AMT_10K-100K_USDC]` |
| Token amounts | `1.5 ETH` | `[AMT_1-10_ETH]` |

Amounts are bucketed (not exact) — Claude knows the order of magnitude but not the precise figure.

### PII

| Pattern | Placeholder |
|---------|-------------|
| Email addresses | `[EMAIL_1]` |
| Phone numbers | `[PHONE_1]` |
| Names (from `knownPersons` list) | `[PERSON_1]` |

### Lookup table

When anonymizing `0xAbCd...1234 → [ADDR_1]`, Argos keeps a **local in-memory lookup table**:
```
[ADDR_1] → "0xAbCd...1234"
```

This table:
- Lives only in memory (never persisted to DB or sent to any external service)
- Is passed to workers at execution time so they can use the real value
- Is not sent to Claude — Claude works with placeholders only

---

## Privacy roles

Each step of the pipeline can be routed to a **local model** or the **cloud model**:

| Role | Default routing | Why |
|------|----------------|-----|
| `sanitize` | local | Injection check sees raw content — cloud would leak it |
| `classify` | local | Partner message context — stays local |
| `triage` | local | Same |
| `llmAnon` | local | Anon pass sees raw content — must be local |
| `plan` | cloud | Planning needs the strongest model — receives only anonymized content |

Configure in `privacy.roles`:

```json
"privacy": {
  "provider": "ollama",
  "model": "qwen2.5:7b",
  "roles": {
    "sanitize": "privacy",
    "classify": "privacy",
    "triage": "privacy",
    "llmAnon": "privacy",
    "plan": "primary"
  }
}
```

If `privacy.provider` is not set, all roles use the primary (cloud) provider. In this case, set `sanitize`, `classify`, and `triage` roles to `"primary"` — the regex anonymizer still runs before content reaches the cloud.

---

## What is never stored

| Data | Status |
|------|--------|
| Raw message content | Never stored — exists only in memory during processing |
| Crypto addresses | Never stored — only placeholders in DB |
| Exact amounts | Never stored — only bucketed ranges |
| Personal contact names | Never stored — only `[PERSON_1]` placeholders |
| API keys / tokens | Only in system keychain or `~/.argos/secrets.json` |

---

## What is stored

| Data | Where | Notes |
|------|-------|-------|
| Anonymized message summaries | `memories` table | With TTL |
| Task metadata (title, status, partner placeholder) | `tasks` table | No raw content |
| Proposal plans | `proposals` table | Fully anonymized |
| Audit events | `audit_log` | Event type + entity ID only — no content |
| Message metadata | `messages` table | Only content hash (SHA-256) + channel + chat_id |

---

## Optional: raw content storage

For users running fully local models who want Argos to recall exact values:

```json
"privacy": {
  "storeRaw": true
}
```

This stores the pre-anonymization content in a `raw_content` column in `memories`. **Only use this if your privacy roles are all set to local models** — otherwise the local storage provides no privacy benefit.

### Optional: message encryption

For additional security when storing raw content:

```json
"privacy": {
  "storeRaw": true,
  "encryptMessages": true
}
```

Raw content is encrypted with AES-256-GCM before storage. The key is generated on first boot at `~/.argos/message.key` (32 bytes, never leaves your machine).

Decrypt a specific message for debugging:
```bash
npm run decrypt -- <message_id>
```

---

## Injection detection

Before any message reaches the pipeline, the injection detector checks for:

1. **Regex fast-screen** — known injection patterns (role overrides, jailbreak attempts, system prompt leaks)
2. **LLM deep scan** (optional, local model recommended) — catches sophisticated attempts

Flagged messages are quarantined — they don't enter the classifier or planner.

---

## External content tagging

All content from external sources (partner messages, fetched URLs, Notion pages) is wrapped in XML tags before reaching Claude:

```
<external_content source="telegram/ChatName">
  [anonymized content here]
</external_content>
```

This helps Claude distinguish between your instructions and partner-provided content, reducing the impact of indirect prompt injection.

---

## Setting up local privacy model

```bash
# Install Ollama
brew install ollama   # macOS

# Pull a capable small model
ollama pull qwen2.5:7b

# Start Ollama
ollama serve
```

Then in `~/.argos/config.json`:

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
  "model": "qwen2.5:7b"
}
```

Verify: `npm run doctor --all` should show `Embeddings / LanceDB` and the privacy model configured.
