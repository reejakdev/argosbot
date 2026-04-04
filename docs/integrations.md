# Integrations

All integrations are **opt-in**. Argos works with only the LLM + one approval channel. Everything else is additive.

---

## Message channels (listening)

These are the channels Argos **reads from** to detect tasks and proposals.

### Telegram MTProto

Reads your personal Telegram messages via the MTProto protocol (gramjs). Requires your personal API credentials — this is your user account, not a bot.

**Setup:**
1. Go to [my.telegram.org](https://my.telegram.org) → Log in with your phone number
2. Click "API development tools" → Create an application
3. Copy `api_id` (number) and `api_hash` (string)
4. Run `npm run setup` → Telegram listener step

**Config:**
```json
"channels": {
  "telegram": {
    "listener": {
      "mode": "mtproto",
      "monitoredChats": [],
      "ignoredChats": [123456789]
    }
  }
}
```

Leave `monitoredChats` empty to monitor all conversations. Use `ignoredChats` to skip specific chats by ID.

**Authentication:** On first start, Argos will ask for your phone number and a Telegram verification code. The session is saved to `~/.argos/telegram_session`.

---

### Telegram Bot (approval channel)

A bot you invite to a private channel or DM. Used for receiving proposals and typing commands.

**Setup:**
1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the bot token
3. Run `npm run setup` → approval channel → Telegram Bot

**Bot commands:**
```
/proposals    List pending proposals
/tasks        List open tasks
/done <id>    Mark a task as completed
/done all     Mark all open tasks as completed
/cancel       Cancel all pending proposals
/cancel <id>  Cancel a specific proposal
/help         Show available commands
```

Approve/reject proposals by tapping the inline buttons sent with each proposal notification.

---

### Slack listener

Reads your personal Slack messages using a **user token** (xoxp-). No bot invite required — Argos reads the channels you're already in.

**Setup:**
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. OAuth & Permissions → User Token Scopes, add:
   - `channels:history` `channels:read`
   - `groups:history` `groups:read`
   - `im:history` `im:read`
   - `mpim:history` `mpim:read`
   - `users:read`
3. Install to Workspace → copy User OAuth Token (xoxp-...)
4. Run `npm run setup` → Slack listener step

**Config:**
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

---

### Slack Bot (approval channel)

A Slack bot for receiving proposals and running commands. Separate from the listener.

**Setup:**
1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. Bot Token Scopes: `chat:write` `channels:history` `im:history` `im:write` `groups:history` `channels:read` `im:read` `users:read`
3. Install to workspace → copy Bot User OAuth Token (xoxb-...)
4. Create a private channel → `/invite @your-bot-name`
5. Right-click channel → Copy link → last segment is the channel ID

**Bot commands:** `/approve`, `/reject`, `/proposals`, `/tasks`, `/memory`, `/help`

---

### Discord

Reads messages from specific Discord servers/channels.

**Setup:**
1. Go to [discord.com/developers](https://discord.com/developers/applications) → New Application
2. Bot → Add Bot → copy token
3. OAuth2 → URL Generator: scopes `bot`, permissions `Read Messages/View Channels`
4. Add bot to your server via the generated URL

**Config:**
```json
"channels": {
  "discord": {
    "enabled": true,
    "monitoredGuildIds": ["YOUR_SERVER_ID"],
    "monitoredChannels": [
      { "channelId": "CHANNEL_ID", "name": "partner-acme" }
    ],
    "approvalChannelId": "YOUR_APPROVAL_CHANNEL_ID"
  }
}
```

---

### Email (IMAP)

Reads your email inbox via IMAP. Compatible with Gmail, Outlook, and any standard IMAP server.

**Gmail setup:**
1. Enable IMAP in Gmail settings
2. Create an app password (Google Account → Security → App passwords)
3. Use `imap.gmail.com:993` with your email + app password

**Config:**
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

---

### WhatsApp

Connects to WhatsApp via [Baileys](https://github.com/WhiskeySockets/Baileys) (unofficial client). Requires scanning a QR code on first run.

**Install:**
```bash
npm install @whiskeysockets/baileys
```

**Config:**
```json
"channels": {
  "whatsapp": { "enabled": true }
}
```

On first start, a QR code is printed to the terminal — scan it with your WhatsApp app. The session is saved to `~/.argos/whatsapp_session/`.

---

### Signal

Reads Signal messages via [signal-cli](https://github.com/AsamK/signal-cli).

**Install:**
```bash
brew install signal-cli   # macOS
# or download from https://github.com/AsamK/signal-cli/releases
```

**Link to your Signal account:**
```bash
signal-cli link -n "Argos"
# Scan the QR code with your Signal app
```

**Config:**
```json
"channels": {
  "signal": {
    "enabled": true,
    "signalCliBin": "signal-cli",
    "account": "+1234567890"
  }
}
```

---

## Productivity integrations

### Notion

Argos can read your Notion workspace for context (knowledge base) and create/update pages (with approval).

**Setup:**
1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) → New integration
2. Give it a name, select your workspace, capabilities: Read/Insert/Update content
3. Copy the Internal Integration Secret
4. Share the pages/databases you want Argos to access with the integration

Store the token:
```bash
# It will be saved in your keychain
npm run setup  # → integrations → Notion
```

Or manually: secret name = `NOTION_API_KEY`

**Config:**
```json
"mcpServers": {
  "notion": {
    "command": "npx",
    "args": ["-y", "@notionhq/notion-mcp-server"],
    "env": { "OPENAPI_MCP_HEADERS": "{\"Authorization\": \"Bearer $NOTION_API_KEY\"}" }
  }
}
```

---

### Google Calendar

Read calendar events for context, create events with approval.

**Setup:**
1. [console.cloud.google.com](https://console.cloud.google.com) → Create project
2. Enable Calendar API
3. Credentials → OAuth 2.0 Client IDs → Desktop app
4. Download credentials JSON → run OAuth flow to get refresh token

Secrets needed: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`

---

### Linear

Track issues and projects. Argos can surface assigned issues and create/update issues with approval.

**Setup:**
1. [linear.app/settings/api](https://linear.app/settings/api) → Personal API keys → New key

Secret needed: `LINEAR_API_KEY`

Optional: `LINEAR_TEAM_ID` (found in team settings URL)

**Config:**
```json
"linear": {
  "enabled": true,
  "teamId": "$LINEAR_TEAM_ID",
  "refreshHours": 6
}
```

---

### GitHub

Read assigned issues and open PRs for context.

**Setup:**
1. [github.com/settings/tokens](https://github.com/settings/tokens) → Generate new token (classic)
2. Scopes: `repo` (or `public_repo` for public repos only)

Secret needed: `GITHUB_TOKEN`

**Config (in knowledge sources):**
```json
"knowledge": {
  "sources": [
    {
      "type": "github-issues",
      "owner": "your-org",
      "repo": "your-repo",
      "token": "$GITHUB_TOKEN"
    }
  ]
}
```

---

## MCP servers

Argos supports the [Model Context Protocol](https://modelcontextprotocol.io) for extending the planner's tool set.

**Config:**
```json
"mcpServers": {
  "puppeteer": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-puppeteer"]
  },
  "1password": {
    "command": "npx",
    "args": ["-y", "@1password/mcp-server"],
    "env": { "OP_SERVICE_ACCOUNT_TOKEN": "$OP_SERVICE_ACCOUNT_TOKEN" }
  }
}
```

Any MCP server can be added here. Tools exposed by the server become available to the planner when generating proposals.

---

## Wallet monitoring

Monitor EVM (ERC-20 + native ETH/USDC/etc.) and Solana wallets for incoming transactions.

**Config:**
```json
"walletMonitoring": {
  "enabled": true,
  "pollIntervalSeconds": 60,
  "wallets": [
    {
      "address": "0xYourAddress",
      "chain": "ethereum",
      "label": "Main treasury",
      "alertThresholdUsd": 1000
    },
    {
      "address": "YourSolanaAddress",
      "chain": "solana",
      "label": "Ops wallet"
    }
  ]
}
```

Transactions above the threshold trigger a notification and can propose an action (e.g. draft a receipt, update a Notion ledger).

---

## Local file knowledge

Drop reference files in `~/.argos/knowledge/` and Argos indexes them automatically:

```json
"knowledge": {
  "sources": [
    { "type": "local", "glob": "~/.argos/knowledge/**/*.{md,txt,pdf}", "name": "My docs" }
  ]
}
```

Supported formats: `.txt`, `.md`, `.docx`, `.xlsx`, `.json`, `.csv`, `.pdf`
