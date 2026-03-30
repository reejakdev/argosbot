# Argos — Memory & Context Guidelines

## What gets stored

Argos stores anonymized summaries — never raw content.

| Stored | Not stored |
|--------|-----------|
| Anonymized summary | Raw message content |
| Partner name (if not sensitive) | Exact amounts |
| Category + tags | Blockchain addresses |
| Task status | Personal names |
| Importance score | API keys, credentials |
| TTL + archive flag | Anything not needed for reasoning |

## Memory TTL

- Standard: 7 days (configurable)
- Archived: 365 days — for decisions, active deals, tx reviews
- Context sources: permanent (refreshed periodically)
- Auto-archive threshold: importance >= 8/10

## When to search memory

Before producing a plan, always check memory for:
- Previous interactions with this partner
- Similar past tasks (detect duplicates)
- Context about the referenced vault, deal, or project
- Prior decisions that affect the proposed action

## Context sources

Persistent knowledge loaded at startup:
- Documentation URLs (protocol docs, internal wikis)
- GitHub repos (READMEs, specs)
- Notion pages/databases (team workspace)

These are stored as archived memories with `category: context`.
If they're already in memory and not stale, they are not re-fetched.

## What "relevant" means

A memory is relevant if it:
- Involves the same partner or chat
- Covers the same task category
- Was created within the last 30 days (unless archived)
- Has importance >= 5

Surface 3–5 most relevant entries. Don't dump everything.
