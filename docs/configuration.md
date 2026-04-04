# Configuration Reference

Config lives at `~/.argos/config.json`.
Secrets (API keys, tokens) are stored separately in your system keychain or `~/.argos/secrets.json`.

Use `$SECRET_NAME` syntax in config to reference a secret by name:
```json
{ "apiKey": "$ANTHROPIC_API_KEY" }
```

---

## Top-level structure

```json
{
  "llm": { ... },
  "owner": { ... },
  "channel": "telegram-bot",
  "channels": { ... },
  "webapp": { ... },
  "security": { ... },
  "privacy": { ... },
  "memory": { ... },
  "embeddings": { ... },
  "triage": { ... },
  "knowledge": { ... }
}
```

---

## `llm` — AI provider

```json
"llm": {
  "activeProvider": "anthropic",
  "activeModel": "claude-opus-4-6",
  "maxTokens": 4096,
  "temperature": 0,
  "providers": {
    "anthropic": {
      "name": "Anthropic",
      "api": "anthropic",
      "auth": "api-key",
      "apiKey": "$ANTHROPIC_API_KEY"
    }
  },
  "fallback": {
    "provider": "groq",
    "model": "llama-3.3-70b-versatile"
  }
}
```

| Field | Description |
|-------|-------------|
| `activeProvider` | Provider ID — must match a key in `providers` |
| `activeModel` | Model name for the active provider |
| `maxTokens` | Max tokens per response (default: 4096) |
| `temperature` | Sampling temperature (default: 0 for deterministic) |
| `fallback` | Optional fallback provider on 5xx/429/timeout |

### Supported providers

| `activeProvider` | Auth | Example model |
|-----------------|------|---------------|
| `anthropic` | API key | `claude-opus-4-6` |
| `anthropic-oauth` | OAuth token | `claude-opus-4-6` |
| `openai` | API key | `gpt-4o` |
| `gemini` | API key | `gemini-2.0-flash` |
| `groq` | API key | `llama-3.3-70b-versatile` |
| `deepseek` | API key | `deepseek-chat` |
| `mistral` | API key | `mistral-large-latest` |
| `xai` | API key | `grok-2-latest` |
| `qwen` | API key | `qwen-max` |
| `together` | API key | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| `perplexity` | API key | `sonar-pro` |
| `cohere` | API key | `command-r-plus` |
| `ollama` | none | `qwen2.5:7b` |
| `lmstudio` | none | `lmstudio-community/Qwen2.5-7B-Instruct-GGUF` |
| `custom` | API key (optional) | any OpenAI-compatible model |

---

## `owner` — Your profile

```json
"owner": {
  "name": "Alice",
  "telegramUserId": 123456789,
  "teams": ["engineering", "product"]
}
```

| Field | Description |
|-------|-------------|
| `name` | Your display name — used in prompts and notifications |
| `telegramUserId` | Your Telegram user ID (get it from [@userinfobot](https://t.me/userinfobot)) |
| `teams` | Teams you belong to — used for routing in triage mode |

---

## `channel` — Approval notification channel

```json
"channel": "telegram-bot"
```

Allowed values: `"telegram-bot"` | `"slack"` | `"discord"` | `"none"`

This controls where Argos sends approval requests. Independent from the **listening** channels.

---

## `channels` — Message listening

### Telegram MTProto listener

```json
"channels": {
  "telegram": {
    "listener": {
      "mode": "mtproto",
      "monitoredChats": [],
      "ignoredChats": []
    }
  }
}
```

Secrets required: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` (from [my.telegram.org](https://my.telegram.org))

| Field | Description |
|-------|-------------|
| `mode` | `"mtproto"` — use gramjs user client |
| `monitoredChats` | Array of chat/user IDs to monitor. Empty = monitor all |
| `ignoredChats` | Array of chat/user IDs to always skip |

### Telegram Bot (approval channel + commands)

```json
"channels": {
  "telegram": {
    "bot": {
      "approvalChatId": "YOUR_CHAT_ID"
    }
  }
}
```

Secret required: `TELEGRAM_BOT_TOKEN`

### Slack listener

```json
"channels": {
  "slack": {
    "enabled": true,
    "pollIntervalSeconds": 60,
    "monitorDMs": true,
    "monitoredChannels": [
      { "channelId": "C0123ABCDEF", "name": "partner-acme" }
    ]
  }
}
```

Secret required: `SLACK_USER_TOKEN` (xoxp-... user token, not bot token)

### Slack Bot (approval channel + commands)

```json
"channels": {
  "slack": {
    "personal": {
      "approvalChannelId": "C0123ABCDEF",
      "allowedUserIds": ["U0123ABCDEF"]
    }
  }
}
```

Secret required: `SLACK_BOT_TOKEN` (xoxb-...)

### Discord

```json
"channels": {
  "discord": {
    "enabled": true,
    "monitoredGuildIds": ["123456789"],
    "monitoredChannels": [
      { "channelId": "987654321", "name": "partner-acme" }
    ],
    "approvalChannelId": "111111111"
  }
}
```

Secret required: `DISCORD_BOT_TOKEN`

### Email IMAP

```json
"channels": {
  "email": {
    "imap": {
      "host": "imap.gmail.com",
      "port": 993,
      "tls": true,
      "user": "$EMAIL_IMAP_USER",
      "password": "$EMAIL_IMAP_PASSWORD",
      "mailbox": "INBOX"
    }
  }
}
```

### WhatsApp

```json
"channels": {
  "whatsapp": {
    "enabled": true
  }
}
```

Requires `@whiskeysockets/baileys`. QR code authentication on first run.

### Signal

```json
"channels": {
  "signal": {
    "enabled": true,
    "signalCliBin": "signal-cli",
    "account": "+1234567890"
  }
}
```

Requires `signal-cli` installed and linked. See [integrations.md](./integrations.md#signal).

---

## `webapp` — Approval dashboard

```json
"webapp": {
  "port": 3000,
  "webauthnRpId": "localhost",
  "webauthnOrigin": "https://localhost:3000",
  "tlsCert": "~/.argos/tls/cert.pem",
  "tlsKey": "~/.argos/tls/key.pem"
}
```

| Field | Description |
|-------|-------------|
| `port` | Port to listen on (default: 3000) |
| `webauthnRpId` | The hostname/IP you access the app from. **Must match exactly.** |
| `webauthnOrigin` | Full origin URL including protocol + port |
| `tlsCert` / `tlsKey` | TLS cert for HTTPS. Required for WebAuthn on non-localhost. |

> Run `npm run setup` → step 2 to auto-generate a cert with mkcert.

---

## `security`

```json
"security": {
  "cloudMode": false
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `cloudMode` | `false` | When `true`, YubiKey is required for **all** approvals regardless of risk level. Use on VPS/remote deployments. |

---

## `privacy` — Local vs cloud routing

```json
"privacy": {
  "provider": "ollama",
  "model": "qwen2.5:7b",
  "storeRaw": false,
  "encryptMessages": false,
  "roles": {
    "sanitize": "privacy",
    "classify": "privacy",
    "triage": "privacy",
    "llmAnon": "privacy",
    "plan": "primary"
  }
}
```

| Role | Default | Receives |
|------|---------|---------|
| `sanitize` | `privacy` | Raw content — injection check |
| `classify` | `privacy` | Anonymized content |
| `triage` | `privacy` | Anonymized content |
| `llmAnon` | `privacy` | Raw content — second anon pass |
| `plan` | `primary` | Fully anonymized content |

`"privacy"` = use the local model (Ollama/LM Studio). `"primary"` = use the cloud model.

If no `privacy.provider` is set, all roles fall back to the primary provider.

See [privacy.md](./privacy.md) for details on the full pipeline.

---

## `memory` — Knowledge retention

```json
"memory": {
  "defaultTtlDays": 7,
  "archiveTtlDays": 365,
  "autoArchiveThreshold": 8
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `defaultTtlDays` | 7 | How long to keep regular memories |
| `archiveTtlDays` | 365 | TTL for archived (high-importance) memories |
| `autoArchiveThreshold` | 8 | Importance score (0–10) above which memories are auto-archived |

---

## `embeddings` — Semantic search

```json
"embeddings": {
  "enabled": true,
  "baseUrl": "http://localhost:11434",
  "model": "nomic-embed-text"
}
```

Requires Ollama with an embedding model: `ollama pull nomic-embed-text`

When enabled, memories, conversations, and knowledge documents are indexed into LanceDB for semantic search.

---

## `triage` — Message routing

```json
"triage": {
  "enabled": true,
  "myHandles": ["@alice", "alice"],
  "watchedTeams": [
    {
      "name": "Acme",
      "handles": ["@acme", "acme-team"],
      "keywords": ["whitelist", "partner"],
      "description": "External partner — crypto whitelist requests"
    }
  ],
  "ignoreOwnTeam": true,
  "mentionOnly": false
}
```

---

## `knowledge` — Reference documents

```json
"knowledge": {
  "sources": [
    { "type": "url", "url": "https://docs.example.com/api", "name": "API docs" },
    { "type": "github", "repo": "owner/repo", "branch": "main", "paths": ["docs/", "README.md"] },
    { "type": "local", "glob": "~/Documents/argos-reference/**/*.md" },
    { "type": "notion", "pageId": "abc123", "name": "Team handbook" }
  ]
}
```

Knowledge sources are indexed at boot and refreshed periodically. The planner uses them for context when proposing actions.

---

## Environment variables

A handful of settings can be overridden via `.env` or environment:

| Variable | Description |
|----------|-------------|
| `DATA_DIR` | Override `~/.argos` data directory |
| `CONFIG_PATH` | Override `~/.argos/config.json` path |
| `APP_PORT` | Override web app port |
| `NODE_ENV` | `development` or `production` |

---

## Minimal config to get started

```json
{
  "llm": {
    "activeProvider": "anthropic",
    "activeModel": "claude-opus-4-6",
    "providers": {
      "anthropic": {
        "name": "Anthropic",
        "api": "anthropic",
        "auth": "api-key",
        "apiKey": "$ANTHROPIC_API_KEY"
      }
    }
  },
  "owner": {
    "name": "Your Name",
    "telegramUserId": 0
  },
  "channel": "telegram-bot",
  "webapp": {
    "port": 3000,
    "webauthnRpId": "localhost",
    "webauthnOrigin": "http://localhost:3000"
  }
}
```

Run `npm run setup` — the wizard generates this for you.
