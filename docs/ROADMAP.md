# Diluxite — Roadmap

Living list for the project. Whatever gets closed here moves to the `CHANGELOG`
of the corresponding commit. Convert relative dates to absolute ones.

## Current status (2026-06-09, `v1.0.0-alpha.62`)

- **Core OSS (this repo)**: API + MCP + Web UI in production against
  `v1.0.0-alpha.62` on Docker Hub. Two modes: `local` (single-user
  passwordless `local@diluxite`) and `server` (multi-auth: password +
  passkey + OIDC SSO + **Cloudflare Access JWT (signature-verified)** +
  trusted-header proxy + optional 2FA TOTP).
- **Runtime stack**: Node 24, pnpm 10, TypeScript 6, Fastify 5,
  Drizzle 0.45, Postgres 17 + pgvector, React 19, Vite 8, Tailwind 4,
  CodeMirror 6 + Yjs/Hocuspocus 2.x (locked — see SECURITY/PATTERNS).
- **Multi-tenant**: shared-schema + tenant column + RLS (`SET LOCAL
  app.current_user_id`). Scoped org tokens, per-user passkeys,
  CSRF double-submit, security headers (helmet), HTTPS Caddy sidecar
  with ACME.
- **Compliance baseline**: append-only audit log with configurable retention,
  active sessions UI, password change with session invalidation, rate-limit
  on auth endpoints, optional MFA. `docs/SECURITY.md §8` with all the
  "high/medium" gaps closed (alpha.21+).
- **Installer**: management mode (re-run shows update/reconfigure/status/
  backup/restore/uninstall/seed) + non-interactive flags + state in
  `.diluxite-install.env`. Auto-update is **opt-in** (default off, double
  warning, uses maintained `nickfedor/watchtower` fork). Backup/restore
  carries mode/embedder/domain/secrets + Caddy TLS cert + can bootstrap
  a fresh machine.
- **Tests**: **850+ green** (unit + integration + 90 installer e2e
  bash assertions). No known flakes. Clean typecheck across 4 packages.

## Done since alpha.10 (summary by block)

### Multi-backend auth
- alpha.20+: server-mode admin bootstrap + token TTL + revoke-all.
- alpha.21: rate-limit `/api/auth/login` (5/min per IP) — later extended to
  `/api/auth/login/totp` and `/api/auth/password`.
- alpha.23: MCP token TTL chooser + panic button.
- alpha.25: OIDC SSO with JIT provisioning (Phase 1.1).
- alpha.26: OIDC E2E tests with a real mock issuer + jose.
- alpha.27: CSV bulk import users (Phase 1.2).
- alpha.28: TrustedHeaderAuthProvider (Authelia / Pomerium) — plaintext
  identity header, INSECURE unless all ingress is forced through the proxy.
- alpha.29: security headers via `@fastify/helmet`.
- alpha.30: Settings UI Admin → Auth policy (Phase 1.3).
- alpha.31: install.sh post-install SSO hints in server mode.
- alpha.32: **CSRF double-submit cookie** (closes gap SECURITY.md §8).
- alpha.33: **HTTPS Caddy sidecar** + inline OIDC/trusted-header wizard.
- alpha.36+37: **2FA TOTP** (RFC 6238 + backup codes + login flow + UI).
- alpha.39: **Active sessions UI** — list + revoke + revoke-others.
- alpha.40: **Password change** + session invalidation.
- alpha.42: **Email service abstraction** (Noop/SMTP) + **forgot-password**
  reset flow with rate-limit and token consumption tracking.
- alpha.49+: **Cloudflare Access JWT (verified)** — `CfAccessJwtAuthProvider`
  verifies the signed `Cf-Access-Jwt-Assertion` against the team's public
  keys (RS256 + AUD). Modular auth chain in `services.ts`:
  session → CF-Access-JWT → trusted-header. Secure even without a tunnel
  (a spoofed header has no valid signature).
- alpha.50+: **Mode switch local ↔ server** with super-admin onboarding
  (promotes `local@diluxite`, bootstrap-then-scrub of the password so the
  plaintext never persists). Sub-modes: Cloudflare-JWT / email+password /
  trusted-header. `--reset-admin` flag.

### Audit & compliance
- alpha.34: append-only `audit_events` schema + repo + admin endpoint
  + AuditTab UI.
- alpha.35: full event coverage (logout, OIDC denied paths, token
  mint/revoke, etc).
- alpha.38: retention job (`DILUXITE_AUDIT_RETENTION_DAYS`).

### Notes UX (alpha.43+)
- alpha.43: **Trash bin / soft-delete** — `notes.deleted_at` (mig 0016),
  TrashView in sidebar, `/restore` + `/purge` + `/trash` endpoints.
- alpha.45+: **Neighbors panel** dockable + accordion in side sidebar,
  editor/preview splitter drag fixes, settings security UX tidy-up.
- alpha.48: Seed adds a root **"Knowledge Hub"** note with 50 outlinks +
  50 backlinks for a realistic Neighbors demo. Trashed notes in the seed.

### Installer wizard
- alpha.31+33+45: interactive installer with inline prompts for HTTPS
  domain, OIDC, trusted-header. Auto-generated Caddyfile with ACME.
- Post-install summary shows the real status of the auth backends.
- alpha.45+: **management mode** — re-running `install.sh` shows a menu
  (update / reconfigure / status / backup / restore / uninstall / seed) +
  non-interactive flags. State in `.diluxite-install.env` (no secrets).
- alpha.46+: **backup + restore** carry mode/embedder/domain/secrets +
  Caddy TLS cert; restore can bootstrap a fresh machine (installs Ollama,
  pulls the model, ends with the same healthcheck + summary as a fresh
  install).
- alpha.47+: **auto-update is OPT-IN** (default off) with a double warning
  (not for production + Docker socket = host root) and explicit
  confirmation; uses the maintained `nickfedor/watchtower` fork (the
  archived `containrrr/watchtower` crash-loops on Docker ≥ 29).
- alpha.48+: **seed targets the chosen workspace** via
  `DILUXITE_SEED_SPACE_ID` (fixes the old "first workspace" pick in
  multi-space DBs); installer "Seed test data" menu + `--seed`.
- alpha.62: **HTTPS TLS modes** — `HTTPS_TLS_MODE=acme|internal` (Let's
  Encrypt vs Caddy's local CA), **DNS pre-flight check** against a public
  resolver before enabling ACME (catches `/etc/hosts` overrides + private
  IPs), `--reconfigure-https` + `--export-caddy-ca` flags and management
  menu item 8 ("Reconfigure HTTPS").

### Tests/CI (alpha.49+)
- **Installer e2e suite** (`test/installer/`, mocked docker/curl/ollama,
  `installer-test.yml`) — 90 bash assertions covering the lifecycle.
- Hardened MCP integration (all 10 tools + auth + authz).
- Passkey integration, seed-target integration, admin-promote integration.
- Real v8-coverage pass on the genuinely thin spots (password-resets,
  passkeys, web libs).

## Pending

### To close alpha → 1.0-beta

| | Effort | Status |
|---|---|---|
| ~~Trash bin / soft delete~~ | 1-2 days | ✅ alpha.43 |
| ~~Forgot password / reset via email~~ | 2 days | ✅ alpha.42 |
| ~~Email service abstraction~~ (SMTP) | 1 day | ✅ alpha.42 (Noop + SMTP) |
| ~~Fix flake `UsersImportCsv` test~~ | <1 hour | ✅ alpha.41 |
| ~~Backup / restore CLI~~ | 2 days | ✅ alpha.46+ — integrated into `install.sh --backup` / `--restore`; manifest carries mode/embedder/domain/secrets + Caddy TLS cert. |
| ~~**Backend i18n**~~ (errors via `Accept-Language`) | 1 day | ✅ Six locales with base-language fallback, and every response carries a stable `code`. |
| ~~**Accessibility audit** WCAG AA~~ | 2 days | ✅ Audited with axe in a real browser across the app's states (`apps/web/e2e/a11y.spec.ts`, runs on every PR). Four violations found and fixed — one critical. |

### Retrieval architecture — see [ADR-001](./adr/adr-001-retrieval-architecture.md) (2026-08-27) and [ADR-002](./adr/adr-002-knowledge-model.md) (2026-08-29)

The scenario this line serves: **you are in a meeting, you ask anything, and it
answers with the best it has right now.** The decision, the survey of what other
second brains do, and the trade-offs are in the ADR; this table is only the
schedule. The order below is deliberate and is **not** the order these were
first written in — provenance comes first because the other two build a more
precise liar without it.

| | Effort | Notes |
|---|---|---|
| ~~**1. Provenance, validity and rank**~~ | — | ✅ 2026-08-29 (#95) |
| ~~**1b. Decay estimated from observed change**~~ | — | ✅ 2026-08-29 (#96, #97 — the badge) |
| ~~**2. Queryable tables (`query_facts`)**~~ | — | ✅ 2026-08-29 (#98) |
| **3. Resolvers for live state** | 4-5 days | The bridge half. Metrics, ticket status and dashboards are **not copied** — a note declares where to ask, and the engine resolves at query time with a cache. Source unreachable → serve the last known value **with its age**, never bare. Last of the three because it needs step 1's scaffolding to be safe and is the only one that reaches outside the product. |

### Organizational memory / DDW line (2026-08-26)

Where the content comes from. Retrieval over it is the section above.

| | Effort | Notes |
|---|---|---|
| **GitHub ingestion v1.1 — push-driven** | 3-4 days | Company-level connection via **GitHub App** (org installs once, read-only contents on selected repos, short-lived tokens, signed webhooks — never personal credentials). A push re-ingests only the changed files (blob-sha incremental, same contract as `scripts/ingest-ddw.ts`). UI: connect + repo picker + sync log. |
| **Session capture (a client-side skill, not an engine feature)** | 1 day | A distributable skill for Claude Code/Cursor that writes a session summary via the existing MCP `write_note` at session end. Diluxite needs nothing new for it — that is the point: it rides the public MCP surface, so it belongs with the agent, not in here. DDW's closeout-publish is the disciplined variant. |
| **Confluence / Jira connectors** | 4-5 days | Where organizational memory actually lives in companies today. Import pages/issues as notes with source footers, incremental by version, archive-annotate on deletion — the DDW connector's contract, new sources. |

### Settings UX / runtime configuration (post alpha.47)

| | Effort | Notes |
|---|---|---|
| **AI / Embeddings configurable from the UI** (alpha.48 split) | | Today it's container env vars because the embedding provider is injected at boot. Refactor the provider to make it hot-reloadable + `PUT /api/admin/orgs/:orgId/embedding-config` endpoint + persistence (likely reusing `org_settings`) + UI at `/admin/ai` with a form. **Split in 2:** |
| └ 48a: change the URL/endpoint of the current provider | 1 day | Without a model / dim change — trivial. Provider hot-reload. |
| └ 48b: model switch with mass re-index | 3-4 days | **Diagnostic + rebuild done**: `GET /api/admin/embeddings` reports the active embedder against what is stored (grouped by dimension, so a half-finished reindex is visible), and Admin → AI reindexes from the UI. What remains is the switch itself — hot-reloading the provider, and reindexing without search degrading while it runs (today it is one synchronous pass). |
| ~~**Search config persisted server-side per org**~~ (alpha.48) | 1 day | ✅ Migration 0026: `searchMode` and `topK` live in `org_settings`. Read by any member, written by an admin, audited. |
| ~~Replace Watchtower upstream~~ | 1 day | ✅ alpha.47+ — uses the maintained `nickfedor/watchtower` fork. Auto-update also went from default-on to **opt-in with a double risk warning** (not for production + Docker socket grants host root). |

### From the original PRD v2 — "next"

| | Effort | Notes |
|---|---|---|
| **Daily notes + templates** | 1-2 days | Dedicated section in the sidebar; note templates. |
| **Attachments** (images / files → text) | 3-4 days | Upload, `__DATA_PATH__/attachments` storage, OCR/extract for semantic search. |
| DDW connector (`pnpm ingest:ddw`) | shipped (CLI) | ingests DDW-governed repos as notes: 1 family = 1 workspace, tags/wikilinks derived, incremental by blob sha; UI button pending |
| **Import from Obsidian / Notion / Joplin** | 2-3 days | ZIP/folder parser → bulk createNote with wikilink preservation. |
| **Spanish semantic eval** | 1 day | Query suite with expected top-K — reproducible baseline. |

### MCP / memory efficiency (inspired by the Headroom analysis, 2026-06-18)

Two patterns worth borrowing from token-compression tooling, reframed for a
**retrieval/memory** layer (Diluxite decides *what* is relevant; it should also
control *how much* lands in the agent's context). NOT building a neural
compressor — that's a different layer and not our differentiator.

| | Effort | Notes |
|---|---|---|
| **On-demand expansion** (compact-by-default search + `expand`) | 2-3 days | `search_memory` returns compact hits (summary/best chunk) plus an opaque ref; a new MCP tool `get_memory`/`expand_memory` returns the **full note or source context** only when the agent asks. Cuts tokens per call without losing fidelity (Headroom's "reversible compression", but at the retrieval layer where we already hold the originals). Pairs with a `token_budget`/`max_tokens` arg on `search_memory` so results fit a stated budget. |
| **Learn from corrections** (typed feedback memories) | 2-3 days | MCP tool `record_correction` (+ note `type: correction`) so an agent can persist "approach X failed → do Y instead". These rank **first** for matching future queries (boost in the hybrid reranker). Lighter than Headroom's session-mining `learn`, but same payoff for a memory product: the brain gets less wrong over time. Optional later: a job that mines audit/session logs to auto-draft these. |

### Usability features inferred from the product

| | Effort | Notes |
|---|---|---|
| **Note versioning** (history + restore) | 3-4 days | `note_revisions` table, diff view, restore. |
| **Public sharing** (read-only link) | 2 days | Public token + Share button in the UI. |
| **Export markdown ZIP** of the space | 1 day | Endpoint + button, YAML frontmatter + assets. |
| **Bulk operations** (multi-select tag/move/archive) | 1 day | Multi-select delete already exists; other operations are missing. |

### Enterprise / operational

| | Effort | Notes |
|---|---|---|
| **SCIM 2.0** provisioning | 4-5 days | Auto user provisioning from Okta/Entra IdP. Heavy. |
| **Webhooks** (event → POST URL) | 2 days | `note.created`, `auth.login.failed`, etc. |
| **Observability** (Prometheus `/metrics`) | 1 day | Latencies, request counts, embedder errors. |
| **Audit log alerting** (webhook on N failed logins) | 1 day | On top of audit + webhooks. |
| **SSO group/role mapping** | 1-2 days | OIDC claims `groups: [...]` → assigns role. |
| **CSP nonce** (instead of `unsafe-inline`) | 1 day | Hardens XSS defense. |
| **Reproducible performance benchmarks** | 1 day | Baselines for search p95, list 1k notes, etc. |
| ~~Playwright CI~~ | 1 day | ✅ wired — `e2e.yml` workflow runs the multi-context collab suite on every push + PR. |

### Hosted operation (not started)

Multi-tenancy itself already ships — organizations, workspaces, roles, RLS.
What is listed here is what running it *for other people* would additionally
need.

- **Managed identity providers**: Entra External ID (Google + Microsoft) wired
  to the existing OIDC support.
- **Billing and quotas**: metering, plans, a quota dashboard.
- **Kubernetes manifests** (v1.1 of the original roadmap) and a managed
  deployment target.

## Decisions made (mini ADR)

- **One product, AGPL-3.0.** Engine, UI and everything else ship together, and
  multi-tenancy is part of the data model rather than a tier. No feature has a
  "does this belong in the paid half" question to answer, because there is no
  second half.
- **Web stack**: `dockview-react`, **CodeMirror 6** + `y-codemirror.next`,
  `cmdk`, `lucide-react`.
- **MCP transport**: Streamable HTTP with a per-user session; identity
  derived from the validated token.
- **Chunking**: heading-aware, ~512 tokens with ~64 overlap. Notes ≤ 400
  tokens are embedded whole.
- **Embeddings**: pluggable provider, auto-detected from env vars with
  priority **Azure OpenAI > Ollama > deterministic** — so the CODE default
  with no env vars set is the **deterministic** provider (no keys → it
  runs). **Ollama (with `keep_alive: '24h'`) is the installer wizard's
  default**, not the code's.
- **Collab**: Yjs CRDT + Hocuspocus WebSocket server. **NO** offline editing.
- **Auth**: 5 possible backends (password + passkey + OIDC +
  **Cloudflare Access JWT (signature-verified)** + trusted-header)
  + optional 2FA TOTP. Local mode is always single-user passwordless.
- **CSRF**: double-submit cookie. SameSite=Lax is the first line,
  `X-CSRF-Token` the second.
- **HTTPS**: opt-in Caddy sidecar via `docker compose --profile https`.
  Automatic ACME. No attempt to do TLS inside the `diluxite` container.
- **Audit**: append-only, NO update/delete by design. Retention via env.

## Things we are NOT going to do

- Electron / native desktop application. Web-first; PWA if the user wants it.
- Obsidian-style plugin system. Extensibility via MCP tools.
- Offline editing in collab — disconnect = read-only (a conscious decision
  to avoid exposing the user to complex conflicts).
