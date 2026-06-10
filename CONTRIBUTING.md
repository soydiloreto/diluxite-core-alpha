# Contributing to Diluxite Core

Thanks for your interest! Diluxite Core is the open-source engine behind the
self-hosted "memory for your AI". This guide gets you productive fast.

## Development setup

Requirements: **Node ≥ 24** (see [`.nvmrc`](./.nvmrc)), **pnpm ≥ 10**, and Docker
(only for Postgres + pgvector).

```bash
cp .env.example .env
pnpm install
pnpm db:up                          # docker compose up -d (db + api + web; Adminer only with --profile tools)
pnpm --filter @diluxite/api dev     # API + MCP  → http://localhost:3030
pnpm --filter @diluxite/web dev     # Web UI     → http://localhost:5173
```

## Tests — the bar is high

Diluxite ships with a thorough test suite (850+ green). **Every change comes with
tests**, and the gates below must pass before a PR can merge:

```bash
pnpm test:unit        # unit (core + web + api) — fast, no DB
pnpm test:int         # integration (db + api) — needs `pnpm db:up`
pnpm test:installer   # install.sh lifecycle, with mocked docker/curl
pnpm typecheck
pnpm lint             # eslint --max-warnings=0 (any warning fails)
```

- **Unit** tests live next to the source as `*.test.ts` (core/web) or `*.unit.test.ts` (api).
- **Integration** tests are `*.integration.test.ts` and run against a real Postgres.
- **End-to-end**: Playwright (`apps/web/e2e/`) for the web/collab flow, and a bash
  lifecycle suite (`test/installer/`) for `install.sh` with mocked `docker`/`curl`.

The test philosophy ("furious, detail-obsessed") is documented in
[`docs/PATTERNS.md`](./docs/PATTERNS.md) §9.

## Conventions

- **Code and comments in English.** UI strings are localized in 6 locales (en/es/pt/it/ca/zh).
- **Conventional commits**: `feat:`, `fix:`, `chore:`, `test:`, `docs:`, …
- `main` is protected (required status checks). Open a PR from a feature branch;
  don't push to `main` directly.
- Keep changes focused; match the style of the surrounding code.
- Don't disable or skip a test to make CI green — fix the root cause.

## Architecture & product context

- Technical reference: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- Product spec: [`docs/PRD.md`](./docs/PRD.md)
- Roadmap: [`docs/ROADMAP.md`](./docs/ROADMAP.md)
- Security model: [`docs/SECURITY.md`](./docs/SECURITY.md)
- Front-end patterns: [`docs/PATTERNS.md`](./docs/PATTERNS.md)

## Reporting bugs & ideas

Open an issue at
[github.com/soydiloreto/diluxite-core-alpha/issues](https://github.com/soydiloreto/diluxite-core-alpha/issues).
For security vulnerabilities, **do not open a public issue** — see
[`.github/SECURITY.md`](./.github/SECURITY.md).

## License

By contributing you agree your contributions are licensed under the project's
**[AGPL-3.0](./LICENSE)** license.
