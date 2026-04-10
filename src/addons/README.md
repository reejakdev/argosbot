# Argos Addons

> User-extensible folder for personal skills, cron handlers, channels, workers, and any
> other registry-based extension to Argos. Anything you put here is auto-loaded at
> boot but **excluded from the public Argos build** via `tsconfig.public.json`.

## Why this exists

Argos ships a set of generic built-in skills (`web_search`, `crypto_price`, `notion_db_query`,
`eth_encode_function`, `verify_protocol_address`, …) that work for everyone. But if you
want to add **your own** company-specific or workflow-specific automation — like a
custom CoinGecko form filler, an internal address verifier, a specialized token tracker,
or anything that's not generic enough to ship publicly — `src/addons/` is the place.

## How it works

At boot, the skill registry calls `loadAddons()` which dynamically imports
`src/addons/index.ts` (if present). That index file is **yours** to write — it can
import any number of addon modules and call `registerSkill()`, `registerCronHandler()`,
or any other Argos extension hook.

Failures are silent: if there's no `index.ts` in `src/addons/`, Argos boots normally
without addons.

## File layout

```
src/addons/
├── README.md            ← this file (committed)
├── index.ts             ← YOUR entry point (gitignored)
├── example.ts           ← reference example (committed)
└── <your stuff>.ts      ← your custom files (gitignored)
```

## Quick start

1. Copy `example.ts` → `index.ts`:
   ```bash
   cp src/addons/example.ts src/addons/index.ts
   ```

2. Edit `src/addons/index.ts` to register your custom skills.

3. Enable each skill in `~/.argos/.config.json` under `skills`:
   ```json
   {
     "skills": [
       { "name": "my_custom_skill", "enabled": true }
     ]
   }
   ```

4. Restart Argos. You should see in the logs:
   ```
   [skills] N built-in skill(s) loaded
   [addons] M addon module(s) loaded
   ```

## Available extension hooks

Inside an addon file you can import and call:

```typescript
import { registerSkill } from '../skills/registry.js';
import { registerHandler, upsertCronJob } from '../scheduler/index.js';
import { registerChannel } from '../ingestion/channels/registry.js';
import { createLogger } from '../logger.js';
```

- **`registerSkill(skill)`** — adds a tool the LLM can call
- **`registerHandler(name, fn)` + `upsertCronJob(...)`** — schedule a recurring job
- **`registerChannel(channel)`** — add a new ingestion channel
- **`createLogger('addon:name')`** — namespaced logger

See `example.ts` for a working skill template.

## Public build (excluding addons)

Two npm scripts are provided:

```bash
# Standard build (includes addons — for personal use)
npm run build

# Public build (excludes src/addons/** — for distribution)
npm run build:public

# Full public build with webapp client
npm run build:all:public
```

The public build uses `tsconfig.public.json` which excludes `src/addons/**` entirely,
so none of your personal code lands in `dist/` when shipping.

## Privacy / hygiene

- **`.gitignore`** excludes everything in `src/addons/` except `README.md` and `example.ts`
- Don't put secrets or API keys in addon files — use `~/.argos/.secrets.json` or env vars
- The same security model applies to addons as to built-ins: `read by default`, `approve
  before action`, no autonomous execution without `config.readOnly = false`

## Examples of things to put here

- Company-specific listing form fillers (CoinGecko, DeBank, DeFiLlama)
- Internal API integrations behind your VPN
- Custom address whitelist verifiers tied to your protocol's docs
- One-off cron handlers for personal reminders or monitoring
- Channel adapters for proprietary chat systems
- Specialized tx encoders for your protocol's contracts
