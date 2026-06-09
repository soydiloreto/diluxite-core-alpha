# TODO — session handoff (cross-machine)

> This file is the **handoff** between work sessions on Diluxite Core. It is
> meant to be self-contained: starting on another machine, reading this (plus
> `CHANGELOG.md` and `docs/ROADMAP.md`) should be enough to know where things
> stand.

Last updated: **2026-06-08** (post `v1.0.0-alpha.61`, docs refresh + flaky seed test fix).

## Current state

- **Published version:** `1.0.0-alpha.61` on Docker Hub (`:1.0.0-alpha.61` + `:next`).
- **`main` is clean** at commit `ca94e24` — CI 10/10 green.
- **Tests:** **830 green** — 428 unit (core + web + api-unit) + 335 integration
  (db + api) + 67 installer e2e (bash asserts). Typecheck + lint clean.
  No known flakes.
- **Node:** runtime ships on `node:24-alpine`; CI matrices test on `[20, 22, 24]`;
  `.nvmrc` pins 24 for local dev.

## What shipped between alpha.49 and alpha.61

All released, on Docker Hub. See `CHANGELOG.md` for the per-release breakdown.

- **Auth — Cloudflare Access (verified JWT).** `CfAccessJwtAuthProvider` verifies
  the signed `Cf-Access-Jwt-Assertion` (RS256 vs team certs + AUD). Modular auth
  chain in `services.ts`: session → CF-Access-JWT → plaintext trusted-header.
- **Installer management mode** (`install.sh`): on an existing install it shows a
  menu (update / reconfigure / status / backup / restore / uninstall / seed) plus
  non-interactive flags. State persisted in `.diluxite-install.env` (no secrets).
- **Mode switch local↔server** with super-admin onboarding (promote
  `local@diluxite`, bootstrap-then-scrub password = no plaintext at rest),
  sub-modes Cloudflare-JWT / email+password / trusted-header; `--reset-admin`.
- **Backup + restore** carry mode/embedder/domain/secrets + Caddy TLS cert;
  restore can bootstrap a fresh machine. Restore sets up Ollama (install + pull)
  and ends with the same health check + summary as a fresh install.
- **Robustness fixes:** uninstall removes install artifacts (no "phantom" install)
  and actually deletes the root-owned Postgres data; fresh install detects an
  existing DB at the path and asks reuse/wipe; status shows the real running
  version + System/MCP/Workspaces + flags unhealthy containers; consistent `y/n`
  prompts with defaults in brackets.
- **Auto-update is OPT-IN** (default off) with a double warning (not for
  production + Docker socket = host root) and explicit confirmation; uses the
  maintained `nickfedor/watchtower` fork (the archived `containrrr/watchtower`
  crash-loops on Docker ≥ 29).
- **Seed targeted to a chosen workspace** via `DILUXITE_SEED_SPACE_ID` (fixes
  the old "first workspace" pick in multi-space DBs); installer "Seed test data"
  menu + `--seed`.
- **Seed adds "Knowledge Hub"** — a root MOC note with 50 outlinks + 50 backlinks
  so the Neighbors panel has a real-world demo. Plus a few trashed notes for the
  trash bin UI.
- **UI polish (alpha.45-48):** Neighbors panel dockable + accordion in sidebar,
  editor/preview splitter drag fix, settings security UX tidy-up, deeplink fixes.
- **Tests/CI:** installer e2e suite (`test/installer/`, mocked docker/curl/ollama,
  `installer-test.yml`); hardened MCP integration (all 10 tools + auth + authz);
  passkey integration; seed-target integration; admin-promote integration.
- **Docs:** README + all `docs/*` + Docker Hub READMEs are English and current;
  added `CONTRIBUTING.md` and `.github/SECURITY.md`.

## Bring Diluxite up on a new machine

### Use it (quick install)

```bash
curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
```

Web → `http://localhost:5173`. Install folder → `~/diluxite/`. Re-running the
installer gives the management menu (it detects the existing install).

### Work on the code (dev mode)

```bash
git clone https://github.com/soydiloreto/diluxite-core-alpha.git ~/repos/diluxite-core
cd ~/repos/diluxite-core
pnpm install
pnpm db:up                              # Postgres + pgvector via Docker
pnpm --filter @diluxite/api dev         # API + MCP on :3030
pnpm --filter @diluxite/web dev         # Web on :5173
```

Tests:

```bash
pnpm test:unit         # 428 (core + web + api-unit). No DB.
pnpm test:int          # 335 (db + api). Needs `pnpm db:up`.
pnpm test:installer    # 67 bash asserts — install.sh lifecycle (mocked docker/curl/ollama).
pnpm typecheck && pnpm lint
```

> Integration tests need a Postgres on host `5432`. If the install's `:next`
> container holds the name, run a throwaway: `docker run -d --name diluxite-test-db
> -p 5432:5432 -e POSTGRES_USER=diluxite -e POSTGRES_PASSWORD=diluxite
> -e POSTGRES_DB=diluxite pgvector/pgvector:pg17`.

## Notes for the next session

- GitHub account is **`soydiloreto`** (`gh auth login` on each new machine).
- Branch protection on `main` with required status checks. Admins can bypass on
  direct push; CI runs regardless.
- **Conventions:** code/comments in English; UI strings localized (en/es/pt);
  auto-update is opt-in with a risk gate; tests are *furious and detail-obsessed*
  (`docs/PATTERNS.md` §9); NEVER skip git hooks.
- **DOCKERHUB_USERNAME / DOCKERHUB_TOKEN** are GitHub repo secrets; only
  `soydiloreto` rotates them. Never accept credentials via chat.
- **To cut a release:**
  1. Bump the 5 `package.json` (root + `packages/core` + `packages/db` +
     `apps/api` + `apps/web`).
  2. Move `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD` in `CHANGELOG.md`.
  3. `git commit && git tag vX.Y.Z`.
  4. `git push origin main && git push origin vX.Y.Z`.
  5. CI builds the 3 images (api / web / all-in-one) to Docker Hub (~5 min).

See `CHANGELOG.md` for the full per-release detail and `docs/ROADMAP.md` for
what's next.
