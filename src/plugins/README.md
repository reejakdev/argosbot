# Argos Plugins

Plugins extend Argos without touching the core pipeline.
Each plugin is an independent module that reacts to lifecycle events.

---

## Built-in plugins

| Plugin | Directory | Purpose |
|--------|-----------|---------|
| `triage` | `triage/` | Auto-extract tasks from 100+ partner channels (regex pre-screen → LLM classification → sink) |
| `heartbeat` | `heartbeat/` | Proactive monitoring — wakes up on a schedule to check open tasks and pending approvals |
| `telegram` | `telegram/` | Planner tools for managing monitored Telegram chats (`telegram_add_chat`, `telegram_ignore_chat`, `telegram_list_chats`) |

---

## Plugin interface

```typescript
interface ArgosPlugin {
  readonly name:         string;
  readonly description?: string;

  // Called once after core boot (DB, channels, LLM ready)
  onBoot?(ctx: PluginContext): Promise<void>;

  // Called for every inbound partner message (after sanitize + anonymize)
  // Runs in parallel — errors are caught and logged, never crash the core
  onMessage?(msg: RawMessage, ctx: PluginContext): Promise<void>;

  // Called before process exits
  onShutdown?(): Promise<void>;
}

interface PluginContext {
  config:        Config;
  llmConfig:     LLMConfig;
  privacyConfig: LLMConfig | null;
  notify:        (text: string) => Promise<void>;   // sends to owner's approval chat
}
```

---

## Lifecycle

```
startup
    │
    ▼ pluginRegistry.emitBoot(ctx)        ← sequential, awaited (run migrations, register crons)
    │
    ▼ (per inbound message)
    ├─ core pipeline (sanitize → classify → plan → propose)
    └─ pluginRegistry.emitMessage(msg, ctx)  ← parallel, non-blocking (Promise.allSettled)
    │
    ▼ shutdown
    pluginRegistry.emitShutdown()         ← sequential, best-effort (flush state, close connections)
```

---

## Writing a plugin

### 1. Implement `ArgosPlugin`

```typescript
// src/plugins/my-plugin/index.ts
import type { ArgosPlugin, PluginContext } from '../registry.js';

interface MyPluginConfig {
  enabled: boolean;
  apiKey:  string;
}

export function createMyPlugin(cfg: MyPluginConfig): ArgosPlugin {
  return {
    name:        'my_plugin',
    description: 'Short description shown in /status',

    async onBoot(ctx: PluginContext): Promise<void> {
      // Runs once at startup — safe to await (DB migrations, cron setup, etc.)
      ctx.config; // full Argos config
      ctx.notify('my_plugin ready');
    },

    async onMessage(msg, ctx): Promise<void> {
      // Runs for every inbound message — keep it fast
      // msg.content   = raw text (after sanitize, may contain PII)
      // msg.anonText  = anonymized text (safe for LLM / logging)
      if (msg.content.includes('trigger')) {
        await ctx.notify(`Triggered by ${msg.partnerName}`);
      }
    },

    async onShutdown(): Promise<void> {
      // Flush buffers, close connections
    },
  };
}
```

### 2. Register at boot

```typescript
// src/index.ts
import { createMyPlugin } from './plugins/my-plugin/index.js';

pluginRegistry.register(createMyPlugin({
  enabled: true,
  apiKey:  config.secrets.MY_PLUGIN_API_KEY,
}));
```

### 3. Plugin config (optional)

Add a config section in `~/.argos/config.json`:

```json
{
  "plugins": {
    "my_plugin": {
      "enabled": true,
      "apiKey":  "sk-..."
    }
  }
}
```

---

## Guarantees

- `onMessage` is called **after** sanitization — content is injection-checked
- `onMessage` is called **after** anonymization is available as `msg.anonText`
- Plugin errors are **caught and logged** — they never crash the core pipeline
- `onMessage` runs in parallel via `Promise.allSettled` — slow plugins do not block each other
- `onBoot` runs **sequentially** — all plugins are fully booted before messages start flowing
