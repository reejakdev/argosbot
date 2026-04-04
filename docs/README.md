# Argos Documentation

> **Read by default. Sanitize before memory. Approve before action.**

## Guides

| Guide | Description |
|-------|-------------|
| [Getting Started](./getting-started.md) | Install, configure, and run Argos in 5 minutes |
| [Configuration](./configuration.md) | Full reference for `~/.argos/config.json` |
| [Security](./security.md) | YubiKey setup, cloudMode, approval flow, audit log |
| [Privacy](./privacy.md) | Anonymization pipeline, local model routing, what Claude never sees |
| [Integrations](./integrations.md) | All channels, services, and MCP servers |

## CLI Reference

```bash
npm run dev             # Start Argos in dev mode (hot reload)
npm run start           # Start in production mode
npm run setup           # Interactive setup wizard
npm run doctor          # Health check (--fix, --llm, --all, --json)
npm run status          # Live snapshot: proposals, tasks, memories (--watch, --json)
npm run verify-audit    # Verify tamper-evident audit log chain integrity
npm run anon-test       # Test anonymizer patterns on a string
npm run decrypt         # Decrypt a stored message by ID (if encryptMessages: true)
npm run reauth          # Re-authenticate Telegram MTProto session
```

## Quick links

- [README.md](../README.md) — project overview, architecture, roadmap
- [ARCHITECTURE.md](../ARCHITECTURE.md) — deep technical architecture
- [config.example.json](../config.example.json) — example configuration
