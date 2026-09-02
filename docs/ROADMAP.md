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
| **4. Validity, expiry and rank — the surfaces** | 3-4 days + 3-4 days | [Design](./validity-surfaces-design.md). ADR-002 shipped the model and none of the doors: `supersede()` closes a validity window, drops the rank to `deprecated`, has its integration test — **and no caller anywhere**, so `valid_to` is never written. Four surfaces: the note's info panel (who wrote it, since when it is valid, whether it still holds, its measured rhythm) with "this no longer holds" + "set an expiry date"; three knobs in Admin → Search so ageing and expiry actually weigh in the order instead of only warning; `valid_to`/`rank` carried in the export frontmatter; and the curation queue with the owner's fifteen-minute weekly batch from *Company Brain — modo funcional*, shown as a **Review** screen in the activity bar — one card, one question, three buttons. Gated on a **usage counter** (nothing records how often something was used to answer, and the queue ranks by that). Includes an **optional generation provider** ([ADR-006](./adr/adr-006-generation-provider.md)) for drafting prose proposals — off by default, never in the ranking or answer path — because the batch has to be ready on Friday whether or not anybody opened Claude. The `asOf` half wants the live-state resolvers first. |
| ~~**3. Resolvers for live state**~~ | 4-5 days | ✅ Migration 0041. A note declares a source in a fenced ```resolver block (name / url / path / ttl) and the engine resolves at query time, bounded by the notes a search returned. **Nothing is called unless an operator allowlisted the host** — a note is user input, and without that the feature is an SSRF with a nice syntax; the note says *where*, the operator says *which hosts and how to authenticate*, so a credential never sits in a note. No redirects, a timeout, a size cap, exact host matching (a suffix match is how this check is got wrong). The rule that governs the output: **no value without the date it was true** — a source that is down serves its last value WITH ITS AGE, and one never reached says "unknown" rather than a number. Composed above the prose in `search_memory`, never fused into the ranking. |
| ~~**3b. `asOf` queries**~~ | 1-2 days | ✅ `GET /api/notes/:id/as-of?at=` and `expand_memory { ref, asOf }`. Two sources answering different halves: what the note SAID (version history) and whether it was HELD (the validity window). The limit is stated rather than hidden — once the per-note cap has dropped older snapshots the answer is *"I cannot see back to March"*, never the oldest text still lying around dressed up as the past. |
| ~~**3c. Anchoring against reality**~~ | 1 day | ✅ ADR-002's downward move, with something to move on at last. A table cell and a resolver in the same note under the same name are two claims about one thing; when the source disagrees, the answer says so — *"mrr: 99 (2 min ago) · ⚠ the note still says 42 on line 5"*. Compared loosely (`3%` vs `3.0%` is one claim written twice) because crying wolf trains everybody to ignore the warning. | The bridge half. Metrics, ticket status and dashboards are **not copied** — a note declares where to ask, and the engine resolves at query time with a cache. Source unreachable → serve the last known value **with its age**, never bare. Last of the three because it needs step 1's scaffolding to be safe and is the only one that reaches outside the product. |

| ~~**Meaning-collision detection**~~ | 1 day | ✅ Company Brain §9's third defence, which had no home. `GET /api/spaces/:id/collisions`: one key stated by two notes that do not read like they are about the same subject. The expensive failure is not the disagreement everybody can see — it is the word doing two jobs, which surfaces months later as two reports that will not reconcile. Two notes that AGREE are corroboration and are never reported; the threshold is generous because a check that cries wolf gets switched off. Starts from the vocabulary, not the corpus. |

### Organizational memory / DDW line (2026-08-26)

Where the content comes from. Retrieval over it is the section above.

| | Effort | Notes |
|---|---|---|
| **GitHub ingestion v1.1 — push-driven** | 3-4 days | Company-level connection via **GitHub App** (org installs once, read-only contents on selected repos, short-lived tokens, signed webhooks — never personal credentials). A push re-ingests only the changed files (blob-sha incremental, same contract as `scripts/ingest-ddw.ts`). UI: connect + repo picker + sync log. |
| ~~**Session capture (a client-side skill, not an engine feature)**~~ | 1 day | ✅ [`skills/session-capture`](../skills/session-capture/SKILL.md). Rides the public MCP surface and the engine needed nothing new — which is the test of whether that surface is complete. It routes anything that turned out to be wrong through `record_correction` rather than `write_note`, searches before writing so it updates instead of duplicating, titles notes as the thing itself (a title with a date is one nobody searches for), and declares live numbers with a resolver instead of pasting them. |
| ~~sc~~ | | | A distributable skill for Claude Code/Cursor that writes a session summary via the existing MCP `write_note` at session end. Diluxite needs nothing new for it — that is the point: it rides the public MCP surface, so it belongs with the agent, not in here. DDW's closeout-publish is the disciplined variant. |
| **Confluence / Jira connectors** | 4-5 days | Where organizational memory actually lives in companies today. Import pages/issues as notes with source footers, incremental by version, archive-annotate on deletion — the DDW connector's contract, new sources. |

### Settings UX / runtime configuration (post alpha.47)

| | Effort | Notes |
|---|---|---|
| ~~**Embedding model lifecycle**~~ — see [ADR-003](./adr/adr-003-embedding-model-lifecycle.md) | 2-3 days | ✅ Migration 0027. Catalogue + partitioned vectors + HNSW index shipped; the blue/green flip machinery (`activate()`) is wired end to end since 48b — route, UI and the dual write that makes it reversible. **Comes first.** `embedding_models` catalogue with one live model enforced by a partial unique index; embeddings move out of `chunks` into a table partitioned by model, each partition with a pinned dimension and an ordinary HNSW index (23× on the corpus measured); a model change is blue/green — build alongside, dual-write, atomic flip, reversible — and at most two models ever exist, the older dropped inside the flip transaction. Without this, the UI below is a button that silently breaks search. |
| ~~**AI / Embeddings configurable from the UI**~~ (alpha.48 split) | | ✅ Complete: 48a, 48b and 48c all shipped (the three rows below). It was container env vars because the provider is injected at boot; it is now per organisation, from Admin → AI, with the model change reversible. |
| ~~└ 48a: change the URL/endpoint of the current provider~~ | 1 day | ✅ Shipped. `PUT /api/organizations/:orgId/embeddings/config` takes the endpoint, Admin → AI has the field, `POST …/embeddings/test` tries it in one click before it is trusted, and #118 made the change take effect on the running process — the memoised provider is forgotten on write, endpoint-only edits included. Covered by `embedding-config-api.integration.test.ts` ("a change of endpoint alone — the one expected to take effect now"). |
| ~~└ 48c: more providers~~ (Bedrock) | ~0.5 day each | ✅ Bedrock ships (#112): bearer API key, no AWS SDK and no SigV4. Titan embeds one text per call, Cohere batches; a partial response is refused rather than stored short. OpenAI, Voyage and Cohere direct are the same shape and remain open. |
| ~~└ 48b: model switch with mass re-index~~ | 3-4 days | ✅ Migración 0034 + el flip cableado. Lo que había estaba peor que "parcial": medido, guardar un modelo nuevo dejaba la búsqueda semántica en **cero** hasta terminar el reindex, y el reindex **vaciaba** el espacio activo — un `active` sin vectores y nada a lo que volver. Ahora las lecturas siguen al modelo ACTIVO y las escrituras van a los dos espacios (el dual-write de ADR-003), así que el reindex llena el nuevo sin tocar el vivo. `activate()` tiene ruta y botón en Admin → AI, con el estado del espacio en construcción, y rechaza activar uno incompleto salvo que se fuerce. El reindex acepta `activateWhenDone` para hacer los dos pasos de un click. |
| ~~**Search config persisted server-side per org**~~ (alpha.48) | 1 day | ✅ Migration 0026: `searchMode` and `topK` live in `org_settings`. Read by any member, written by an admin, audited. |
| ~~Replace Watchtower upstream~~ | 1 day | ✅ alpha.47+ — uses the maintained `nickfedor/watchtower` fork. Auto-update also went from default-on to **opt-in with a double risk warning** (not for production + Docker socket grants host root). |

### From the original PRD v2 — "next"

| | Effort | Notes |
|---|---|---|
| **Daily notes + templates** | 1-2 days | Dedicated section in the sidebar; note templates. |
| **Attachments** (images / files → text) | 3-4 days | Upload, `__DATA_PATH__/attachments` storage, OCR/extract for semantic search. |
| DDW connector (`pnpm ingest:ddw`) | shipped (CLI) | ingests DDW-governed repos as notes: 1 family = 1 workspace, tags/wikilinks derived, incremental by blob sha; UI button pending |
| ~~**Import from Obsidian / Notion / Joplin**~~ | 2-3 days | ✅ #133. ZIP → notes + folders, wikilinks and `#tags` as they are, a dry run before anything is written. Obsidian needs no translation; Notion's 32-hex ids and relative page links are undone; everything else (Joplin's Markdown export included) is imported as plain Markdown with links untouched. Nothing is overwritten and attachments are reported as skipped rather than dropped. |
| ~~**Semantic eval**~~ (es, en, pt-BR, it) | 1 day | ✅ #124. Four corpora that are translations of each other — same six notes, same ten questions — so the numbers compare across languages. hit@1 0.80–1.00, hit@3 1.00; floors sit one question below the lowest observed run. It found the next row. |
| ~~**The lexical channel indexed every note as Spanish**~~ | 1 day | ✅ #126, migration 0033. `to_tsvector('spanish', …)` for every note, whatever it was written in: three inflection probes out of three lost per language in en/pt/it. An expression index can hold only one configuration, so the lexemes moved to a stored `tsv` computed from a per-row `fts_config`, detected from the note's function words at index time. Existing notes take their language on the next save or reindex. |

### MCP / memory efficiency (inspired by the Headroom analysis, 2026-06-18)

Two patterns worth borrowing from token-compression tooling, reframed for a
**retrieval/memory** layer (Diluxite decides *what* is relevant; it should also
control *how much* lands in the agent's context). NOT building a neural
compressor — that's a different layer and not our differentiator.

| | Effort | Notes |
|---|---|---|
| ~~**On-demand expansion**~~ (compact-by-default search + `expand`) | 2-3 days | ✅ `search_memory` quotes the **passage that matched** (it used to quote the note's opening, so a search that found its answer in the last paragraph showed the first one) and carries a `ref`; `expand_memory` returns the whole note plus how it stands, its live values and its exact rows — only when the model decides it needs them. |
| ~~superseded~~ | | | `search_memory` returns compact hits (summary/best chunk) plus an opaque ref; a new MCP tool `get_memory`/`expand_memory` returns the **full note or source context** only when the agent asks. Cuts tokens per call without losing fidelity (Headroom's "reversible compression", but at the retrieval layer where we already hold the originals). Pairs with a `token_budget`/`max_tokens` arg on `search_memory` so results fit a stated budget. |
| ~~**Learn from corrections**~~ | 2-3 days | ✅ MCP `record_correction` — "this approach failed, do Y instead". Carried by **PROV-O's activity** (`generated_by = 'correction'`), NOT by a document type: ADR-002 refuses knowledge classes as a data model, and "how did this come to exist" is a question the axes already answer. Ranks above ordinary prose (weight per organisation, 1.5 by default), and a correction that was itself superseded loses the boost — "this was wrong, do Y" that stopped being true is the worst thing to put first. |
| ~~superseded-row~~ | | | MCP tool `record_correction` (+ note `type: correction`) so an agent can persist "approach X failed → do Y instead". These rank **first** for matching future queries (boost in the hybrid reranker). Lighter than Headroom's session-mining `learn`, but same payoff for a memory product: the brain gets less wrong over time. Optional later: a job that mines audit/session logs to auto-draft these. |

### Usability features inferred from the product

| | Effort | Notes |
|---|---|---|
| ~~**Note versioning**~~ (history + restore) | 3-4 days | ✅ Migration 0023 `note_versions`, History button in the note header with a rendered preview and one-click restore. Restore is a NEW save on top, so history stays append-only. |
| **Public sharing** (read-only link) | 2 days | Public token + Share button in the UI. |
| ~~**Export markdown ZIP** of the space~~ | 1 day | ✅ `GET /api/spaces/:id/export.zip` + button in Admin → Current workspace. One `.md` per note in its folder, body verbatim, metadata in YAML frontmatter. Attachments are not a thing yet, so nothing to carry. |
| ~~**Bulk operations**~~ (multi-select tag/move) | 1 day | ✅ #132. Delete and move already existed; tagging is new, and works by editing each note's markdown — tags are derived from the body on every save, so rows written behind the text would vanish on the next edit. Idempotent, authorised per note, reported as `{updated, unchanged, refused}`. **Archive shipped separately** — see the row below. |
| ~~**Archive a note**~~ | ½ day | ✅ Migration 0035 `archived_at`. A flag on the note, not a move or a third state: it leaves the explorer tree and the recents, and keeps answering search and MCP, marked and ranked below live results (`ARCHIVED_SCORE_FACTOR`, applied after the top-K cut so archiving never removes a note from an answer). `PUT /api/notes/:id/archive` + an Archive view in the activity bar. Measured against the field: Obsidian and Joplin have no archive at all (a `_archive` folder by convention), and Bear's hides notes from search — which in a memory for an AI is a soft delete. |

### Multi-tenancy: engage the second layer

| | Effort | Notes |
|---|---|---|
| ~~**Actually run the RLS policies**~~ | 3-4 days | ✅ Migration 0028 + [ADR-004](./adr/adr-004-engaging-rls.md). Data plane runs as `diluxite_app` with the caller's identity published; proven by a suite that mocks the application guards **open** and shows a second organisation still reads nothing, through REST, search, export and MCP. Auth plane and the collab write path stay privileged, for reasons recorded in the ADR. |
| ~~No notion of **instance owner**, above organisation roles~~ | 1-2 days | ✅ Migration 0030 + [ADR-005](./adr/adr-005-tenancy-roles-and-per-org-embeddings.md). Two things closed it at once. `users.setup_admin` is the owner of the installation — it admits and removes organisations, and an installation is never left without one. And the embedding provider stopped being instance-wide: each organisation owns its vectors and chooses its own model (migration 0031), so the route that had no organisation to scope by now has one. Owning the installation is deliberately **not** owning the data in it: a `setup_admin` reading a tenant's notes still gets nothing, which `setup-admin.integration.test.ts` asserts. |
| ~~CSV import can rewrite another org's user profile~~ | 1-2 hours | ✅ Scoped to people in the caller's org, people who do not exist, and unclaimed accounts. The membership lookup runs privileged — inside the request scope RLS answered "what can I see", which for somebody else's account is nothing, and inverted the check. |
| ~~`POST /api/notes/delete-many` answers 200 to a refused caller~~ | <1 hour | ✅ 403 when nothing was allowed; partial success stays 200 and reports `refused`, because failing a twenty-note selection over one out-of-reach note is worse than deleting nineteen and saying so. |
| ~~**Occasional flakes when the two vitest projects share a database**~~ | 1 day | ✅ No eran flakes, y no eran tres cosas distintas. Dos resultaron bugs de producto — el cursor del log de auditoría (#115) y listados sin orden total (#116) — y el tercero era el cruce en sí: los proyectos corren en paralelo entre ellos y la suite de `db` trunca `users`, `notes`, `spaces` y `organizations` entre casos. Medido: con esa suite en loop, 7 de los 9 tests de `trusted-header` se ponen en rojo; solos pasan. Cada proyecto tiene ahora su base (`diluxite_test_db` / `diluxite_test_api`), derivadas de `TEST_DATABASE_URL`. |

### Enterprise / operational

| | Effort | Notes |
|---|---|---|
| **SCIM 2.0** provisioning | 4-5 days | Auto user provisioning from Okta/Entra IdP. Heavy. |
| **Webhooks** (event → POST URL) | 2 days | `note.created`, `auth.login.failed`, etc. |
| ~~**Observability**~~ (Prometheus `/metrics`) | 1 day | ✅ #129. Off unless `DILUXITE_METRICS_TOKEN` is set, and 404 rather than 401 without it. Request counts and a latency histogram by method and route, the embedding provider's calls, failures, texts and duration (from a decorator, not counters in each of the four providers), process memory and uptime, `build_info`. Routes labelled by pattern; anything unmatched is one series. No new dependency. |
| **Audit log alerting** (webhook on N failed logins) | 1 day | On top of audit + webhooks. |
| **SSO group/role mapping** | 1-2 days | OIDC claims `groups: [...]` → assigns role. |
| ~~**CSP nonce**~~ (instead of `unsafe-inline` for STYLES) | 1 day | ✅ #135 — nginx stamps `$request_id` into `index.html` per request and the policy names the nonce, so `style-src` no longer carries `'unsafe-inline'`. The document had no CSP at all — that half shipped in #128, with `script-src 'self'` and no inline. What is left is styles: Vite's critical CSS and CodeMirror both inject `<style>` tags, so dropping `'unsafe-inline'` needs a per-request nonce, which in this architecture means nginx rewriting `index.html` on every request. Its own change, with its own risk. |
| ~~**Reproducible performance benchmarks**~~ | 1 day | ✅ #130. `pnpm bench`: deterministic corpus in four languages, fixed query suite, p50/p95 per lane plus indexing throughput, measured through `SearchService` rather than hand-written SQL. The vector lane runs twice — as shipped and over a connection that cannot use an index — so ADR-003's number is reproducible: 3.4 ms against 124.6 ms at 20k×1536, where the ADR recorded 4.3 against 98.6. |
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
