# Contributing to Argos

## Quick Start

```bash
git clone https://github.com/argos-ai/argos && cd argos
npm install
cp config.example.json ~/.argos/.config.json
npm run dev
```

## Development

```bash
npm run dev          # hot reload (tsx watch)
npm run dev:client   # frontend dev server
npm run build        # TypeScript → dist/
npm run test         # vitest
npm run lint         # ESLint
npm run format       # Prettier
npm run doctor       # health check
npm run anon-test    # test anonymizer patterns
```

## Code Style

- **TypeScript strict** — no `any`, no `as` without justification
- **ES modules** — `import` with `.js` extension
- **Prepared statements only** — never concat SQL
- **Zod validation** — all external input validated at boundaries
- **Logging** — `import log from '../logger.js'` — never `console.log`
- **Audit trail** — `audit()` for every security-relevant event

Run `npm run lint && npm run format:check` before committing.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.

**Key rules:**
1. Raw content never stored, never sent to cloud LLM
2. Every external action requires human approval
3. Workers must respect `config.readOnly`
4. Prepared statements everywhere — zero string concat SQL

## Pull Requests

1. Branch from `main`
2. One logical change per PR
3. All checks must pass: lint, format, build, test
4. Update tests if you change behavior
5. Update ARCHITECTURE.md if you change structure

## Security

If you find a security vulnerability, **do not open a public issue**.
Email security@argos-ai.dev with details.

## License

MIT — see [LICENSE](LICENSE).
