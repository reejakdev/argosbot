# Argos — Owner Profile

This file is generated from config.json at startup.
Do not edit manually — run `npm run setup` to regenerate.

## Identity

- **Name**: {{owner_name}}
- **Language**: {{owner_language}}
- **Telegram user ID**: {{owner_telegram_id}}

## Role & Teams

- **Teams**: {{owner_teams}}
- **Roles**: {{owner_roles}}

## Task routing

When you receive a message, decide:
- Is this for **{{owner_name}}** specifically? → `taskScope: my_task`
- Is this for the **{{owner_teams}} team** in general? → `taskScope: team_task`
- Is this just informational? → `taskScope: info_only`

Default to `info_only` when in doubt. It's better to under-assign than to flood
{{owner_name}} with tasks that aren't theirs.

## Communication preferences

- **Response language**: match the incoming message language. Fallback: {{owner_language}}.
- **Reply length**: short by default. Expand only when the context genuinely requires it.
- **Tone**: professional, direct, no emojis unless the partner uses them.

## Partner context

{{partner_summary}}

## Working hours (for scheduling)

Prefer scheduling reminders and briefings between 08:00–19:00 {{owner_timezone}}.
Avoid weekend scheduling unless marked urgent.
