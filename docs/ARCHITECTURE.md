# ARCHITECTURE — Diluxite (technical context)

> Living technical doc. Companion to [`PRD.md`](./PRD.md). Lets you rebuild the project from scratch. Last updated: **2026-06-09** (`v1.0.0-alpha.62`).
>
> For the rationale behind each enterprise decision (auth, audit, CSRF, HTTPS, collab) see `CHANGELOG.md` per release.

## 1. Stack

- **Language**: TypeScript 6 (Node ≥ 24), ESM. **pnpm 10** workspaces monorepo.
- **Backend API**: **Fastify 5** + **Drizzle 0.45** + **PostgreSQL 17 + pgvector**.
- **Collab WS**: **Hocuspocus 2.x** + **Yjs** (CRDT). Internal port `:3031`, path `/collab` routed via nginx.
- **MCP server**: `@modelcontextprotocol/sdk` (Streamable HTTP, stateful per session).
- **Embeddings**: pluggable provider. Auto-detected by env: Azure OpenAI > Ollama (with `keep_alive: '24h'`) > deterministic.
- **Frontend**: **React 19** + **Vite 8** + **Tailwind 4** + **CodeMirror 6** (editor) + Dockview + cmdk + lucide. i18n via `i18next` (en default; 6 locales: en/es/pt/it/ca/zh).
- **Tests**: **Vitest 4** (per-package projects) + Testing Library (web) + real MCP client (E2E) + Playwright (real browser, post-release smoke in CI).
- **Security middleware**: `@fastify/helmet` (CSP/HSTS), `@fastify/rate-limit`, custom double-submit CSRF.
- **Auth backends**: password (PBKDF2-SHA512), passkeys (`@simplewebauthn/server`), OIDC (`openid-client` with PKCE S256), **Cloudflare Access JWT verified with `jose` (RS256 vs team certs + AUD)**, trusted-header proxy, TOTP RFC 6238.
- **Infra**: Docker Compose (Postgres + Diluxite + optional Caddy HTTPS sidecar + optional Watchtower auto-update).

## 2. File structure

```
diluxite-core-alpha/             PUBLIC, AGPL-3.0 — engine + OSS UI
  apps/
    api/    Fastify: REST + MCP + collab WS + audit retention job
    web/    React + Vite + Tailwind + CodeMirror + Yjs binding
  packages/
    core/   pure domain (notes, embeddings, search, auth providers, totp, csv parser, …)
    db/     Drizzle: schema, 17 migrations, repos, RLS bootstrap
  docker/
    api.Dockerfile · web.Dockerfile · allinone.Dockerfile · hub-readme-*.md
  docker-compose.template.yml    → installer generates the real one in ~/diluxite/
  install.sh                     (9 steps, EN/ES/PT; also generates the Caddyfile
                                  inline for the HTTPS sidecar — no template file)
```

## 3. Pluggable interfaces

Every critical concern lives behind an interface in `@diluxite/core`, and every one of
them ships with a working implementation — nothing here is a stub waiting for a
second product. The right-hand column is what a deployment *could* swap in when
it has the credentials for it; those are alternatives, not a paid tier.

| Port | Shipped | Possible alternative |
|---|---|---|
| `AuthProvider` | `SingleUserAuthProvider` (local) or `SessionAuthProvider` (server mode, optionally chained with `CfAccessJwtAuthProvider` and/or `TrustedHeaderAuthProvider` — see §7) | `EntraAuthProvider` |
| `EmbeddingProvider` | `DeterministicEmbeddingProvider` / `OllamaEmbeddingProvider` / `AzureOpenAIEmbeddingProvider` (auto by env) | Azure OpenAI |
| `EmailProvider` | `NoopEmailProvider` (default — logs to stdout for dev) or `SmtpEmailProvider` (nodemailer transport, auto if `DILUXITE_SMTP_HOST` set) | Azure Communication Services or SendGrid |
| `Reranker` | `IdentityReranker` | Cohere / cross-encoder (future) |
| `SpaceAccess`, `TokenStore`, `SessionStore`, `PasskeyStore`, `TotpStore`, `AuditStore`, `OidcStore` | `Drizzle*Repository` for each | same |

## 4. Data model (alpha.62)

Identifiers in English since v4.0. **17 migrations applied** (`packages/db/migrations/`, 0000–0016).

```
users          id · email(unique) · provider · created_at
               first_name · last_name · active · last_login_at        (alpha.24 / mig 0010)
spaces         id · name · owner_id · org_id · created_at
organizations  id · name · slug · created_at
org_settings   org_id (PK) · auth_policy                              (alpha.24 / mig 0010)
memberships    (space_id, user_id) pk · role(owner|member)
org_memberships (org_id, user_id) pk · role(org_admin|admin|member)
folders        id · space_id · parent_id (self-ref) · name · created_at
notes          id · space_id · folder_id · title · content_md ·
               favorite · created_at · updated_at
               yjs_state(bytea) · yjs_updated_at                      (alpha.10 / mig 0007)
               deleted_at (soft delete / trash bin)                   (alpha.43 / mig 0016)
chunks         id · note_id(cascade) · space_id · text · position ·
               embedding vector (dim any)                             (alpha.17 / mig 0008)
               indexes: GIN to_tsvector('spanish',text) · HNSW vector_cosine_ops · (space_id)
note_tags      (note_id, tag) pk · space_id · tag(lower)
note_links     (note_id, target) pk · space_id · target(lower)
tokens         id · user_id · token_hash(unique) · name · created_at
               expires_at (alpha.22 / mig 0009) · org_id · scopes (alpha.6)
passkeys       id · user_id · credential_id · public_key · counter · ...
sessions       id · user_id · token_hash · expires_at · created_at
               ip · user_agent · last_seen_at                         (alpha.39 / mig 0014)
oidc_ceremonies state(PK) · nonce · code_verifier · expires_at        (alpha.25 / mig 0011)
audit_events   id(bigserial) · at · org_id · actor_id · action ·
               resource · ip · user_agent · metadata(jsonb)           (alpha.34 / mig 0012)
               4 indexes (action, actor, at-desc, org)
totp_secrets   user_id(PK) · secret · confirmed_at · backup_codes[]   (alpha.36 / mig 0013)
password_resets id · user_id(cascade) · token_hash(unique) ·
               expires_at · consumed_at · requested_ip                (alpha.42 / mig 0015)
```

**Multi-tenant model**: shared-schema + tenant column + Postgres RLS. Full details in [`MULTI-TENANT.md`](./MULTI-TENANT.md). Every query runs with `SET LOCAL app.current_user_id = '<uuid>'` and the RLS policies filter by membership.

**Cascade delete**: `folders.parent_id` self-ref with `onDelete: 'cascade'`; `notes.folder_id` as well. To keep a note before deleting its folder, move it with `PUT /api/notes/:id { folderId: null }`.

**Notes are SOFT-DELETED** since alpha.43 (`deleted_at` non-null = in trash). The DELETE endpoint sets `deleted_at`; the trash view (`/api/spaces/:id/trash`) shows them; `/restore` un-trashes; `/purge` is the only path that drops rows.

## 5. Hybrid search

Pipeline:
- **On save**: `parseTags()` + `parseLinks()` + `chunkMarkdown` (heading-aware, ~512 tokens / overlap 64; short ones kept whole) + `embedder.embed` + `indexChunks`.
- **On search** (`mode: hybrid|keyword|semantic`):
  1. Keyword: Postgres Spanish FTS.
  2. Vector: pgvector cosine.
  3. RRF (k=60) merge.
  4. Best chunk per note.
  5. `Reranker.rerank` (identity in Core).
  6. Top-K (default 5).

## 6. MCP server

- `/mcp` Streamable HTTP, stateful per `Mcp-Session-Id`.
- On `initialize`: `auth.resolve(headers)` → identity + default space.
- **17 tools** (all in English): `search_memory`, `list_notes`, `read_note`, `read_notes` (batch, one round trip), `write_note`, `write_notes` (bulk upsert, created/updated per item) (optional `folder` path, created on demand, applied only to a note it creates), `list_spaces`, `list_tags`, `search_by_tag`, `recent_notes`, `backlinks_of`, `append_to_note`, `move_note` (refiles an existing note by path), `delete_note` (soft → trash), `purge_note` (permanent, must be trashed first), `list_folders` (paths + direct note counts), `delete_folder` (permanent, cascades to notes — never the trash — and refuses a non-empty folder without `recursive: true`).
- Each tool authorizes by membership; mutations via MCP also trigger `applyServerEdit()` in Yjs if there are clients connected to that note (changes show up live in open browsers).

## 7. Auth and multi-tenant (server mode)

Exhaustive details in [`SECURITY.md`](./SECURITY.md). Summary:

- **`local` mode** (default `DILUXITE_AUTH_MODE=local`): `SingleUserAuthProvider` → every request is the bootstrap user `local@diluxite`. No login screen.
- **`server` mode**: a **modular auth chain** built in `services.ts` (highest priority first):
  1. **`SessionAuthProvider`** — always present. Reads HttpOnly cookie `diluxite_session` or `Authorization: Bearer <token>`. Opaque sessions (not JWT) with SHA-256 hash in DB.
  2. **`CfAccessJwtAuthProvider`** (alpha.49+) — added when `DILUXITE_CF_ACCESS_TEAM_DOMAIN` + `DILUXITE_CF_ACCESS_AUD` are set. Verifies the signed `Cf-Access-Jwt-Assertion` header against the team's public keys (RS256 + AUD). **Secure even without a tunnel** — a spoofed header has no valid signature.
  3. **`TrustedHeaderAuthProvider`** (alpha.28) — added when `DILUXITE_TRUSTED_IDENTITY_HEADER` is set. Plaintext email header from the reverse proxy. **INSECURE unless ALL ingress is forced through the proxy** (kept for Authelia/Pomerium operators who have that guarantee).
- **5 login backends** (server mode):
  1. Email + password (PBKDF2-SHA512, random salt).
  2. WebAuthn passkeys.
  3. **OIDC SSO** (alpha.25): PKCE S256, claims extraction + JIT provisioning per `org_settings.auth_policy` (`deny_unknown` / `allow_unknown_as_member` (default) / `pre_provisioned_only`). Tested with Entra/Okta/Google/Authentik.
  4. **Cloudflare Access JWT** (alpha.49+): signature-verified header (above).
  5. **TrustedHeader** (alpha.28): plaintext identity from a header injected by the reverse proxy.
- **2FA TOTP** (alpha.36+37): RFC 6238 with backup codes. Opt-in under Settings → Two-factor authentication; the login flow is gated when it is enabled.
- **Forgot password** (alpha.42): `POST /api/auth/forgot` → enumeration-resistant flow; `POST /api/auth/reset` consumes a one-time hashed token (1h TTL) + revokes all sessions on success.
- **Rate-limit** (alpha.21): 5/min/IP on `/api/auth/login`, `/login/totp`, `/auth/password`. `@fastify/rate-limit` plugin.
- **CSRF** (alpha.32): double-submit cookie `diluxite_csrf` (NOT HttpOnly) + header `X-CSRF-Token`. Bearer requests skip the check.
- **Security headers** (alpha.29): `@fastify/helmet` with CSP, HSTS (when HTTPS), Referrer-Policy, X-Frame-Options.

**Per-workspace authz**: every handler that touches a space runs `requireMember(spaceId, userId)` before the query. Defense in depth is closed off by Postgres RLS.

## 8. REST API (wire format in English)

```
GET    /health · /health/db
GET    /api/info                            {embedder, version, user, authMode, oidcEnabled, …}

# Workspaces (spaces) + members
GET    /api/spaces · POST /api/spaces
GET    /api/spaces/:spaceId/members
POST   /api/spaces/:spaceId/members
PUT    /api/spaces/:spaceId/members/:userId
DELETE /api/spaces/:spaceId/members/:userId

# Organizations + members
GET    /api/organizations · POST /api/organizations
GET    /api/organizations/:orgId · PUT · DELETE
GET    /api/organizations/:orgId/members
POST   /api/organizations/:orgId/members
PUT    /api/organizations/:orgId/members/:userId
DELETE /api/organizations/:orgId/members/:userId
GET    /api/organizations/:orgId/workspaces

# Notes
GET    /api/spaces/:id/notes[?tag=&folder=]
POST   /api/spaces/:id/notes                {title, contentMd, folderId?}
GET    /api/spaces/:id/tags · /graph · /stats
GET    /api/spaces/:id/folders              full tree
POST   /api/spaces/:id/folders              {name, parentId?}
PUT    /api/folders/:id                     {name?, parentId?}
DELETE /api/folders/:id
GET    /api/notes/:id · PUT · DELETE · GET /api/notes/:id/backlinks
GET    /api/notes/:id/related               semantically related notes
POST   /api/notes/:id/append                {content}
PUT    /api/notes/:id/favorite              {favorite: bool}
PUT    /api/notes/:id/archive               {archived: bool}  out of the tree, still searchable
GET    /api/notes/:id/live                   live values this note declares, each with its as-of
GET    /api/notes/:id/as-of?at=<iso>         what it said, and whether it was held, at that moment
POST   /api/notes/delete-many               {ids: [...]}
POST   /api/search                          {query, spaceId?, topK?, mode?}

# Trash (soft delete — alpha.43+)
GET    /api/spaces/:id/trash                list trashed notes
POST   /api/notes/:id/restore               un-trash
DELETE /api/notes/:id/purge                 hard delete (only path that drops rows)
DELETE /api/spaces/:id/trash                empty the trash

# Tokens (user-scoped and org-scoped)
POST   /api/tokens                          {name, expiresInDays?}
GET    /api/tokens · DELETE /api/tokens/:id
POST   /api/tokens/revoke-all               panic button — alpha.22
POST   /api/organizations/:orgId/tokens     org-scoped, alpha.6
GET    /api/organizations/:orgId/tokens
DELETE /api/organizations/:orgId/tokens/:id

# Update check
GET    /api/update/check                    latest published version vs running

# Auth — server mode only
POST   /api/auth/login                      {email, password}    rate-limit
POST   /api/auth/logout
POST   /api/auth/password                   {currentPassword, newPassword}   alpha.40
POST   /api/auth/forgot                     start password reset (enumeration-resistant)  alpha.42
POST   /api/auth/reset                      consume one-time reset token                  alpha.42
GET    /api/auth/sessions                   list active sessions             alpha.39
DELETE /api/auth/sessions/:id               revoke individual
POST   /api/auth/sessions/revoke-others     sign out other devices

# OIDC SSO                                  alpha.25
GET    /api/auth/oidc/login                 → 302 to the IdP
GET    /api/auth/oidc/callback              JIT + session cookie

# TOTP 2FA                                  alpha.36+37
GET    /api/auth/totp/status
POST   /api/auth/totp/enroll                start enroll
POST   /api/auth/totp/verify-enroll         confirm 6-digit + backup codes
DELETE /api/auth/totp                       disable
POST   /api/auth/login/totp                 step-2 after password
                                              rate-limit

# Passkeys                                  alpha.7
POST   /api/auth/passkey/register-options · register-verify
POST   /api/auth/passkey/authenticate-options · authenticate-verify
GET    /api/passkeys · DELETE /api/passkeys/:id

# Admin                                     alpha.24+
GET/PUT /api/admin/orgs/:orgId/auth-policy
POST    /api/admin/orgs/:orgId/users/import-csv   alpha.27 multipart
GET     /api/admin/orgs/:orgId/audit              alpha.34 — action/actor/date/IP filters
```

## 9. Frontend (React 19 + Vite 8 + Tailwind 4)

```
apps/web/
  vite.config.ts · tailwind.config.ts · postcss.config.js
  src/
    main.tsx · App.tsx · api.ts · fakeApi.ts · markdown.ts · useSettings.ts
    shell/
      AppContext.tsx                  global state + invalidators (PATTERNS §1-2)
      AppGate.tsx                     loading → authenticated | login-required | error
      ActivityBar.tsx · TopBar.tsx · Sidebar.tsx · DockShell.tsx · CustomTab.tsx
      OrgIndicator.tsx · WorkspaceSelector.tsx · UpdateBanner.tsx
      LoginScreen.tsx                 password + passkey + OIDC + TOTP step 2
      ForgotPasswordScreen.tsx        request a reset link                (alpha.42)
      ResetPasswordScreen.tsx         consume the reset token             (alpha.42)
      SecurityTab.tsx                 security hub (sessions/2FA/passkeys)
      SessionsTab.tsx                 active sessions + password change   (alpha.39+40)
      TwoFactorTab.tsx                TOTP enroll / disable               (alpha.37)
      PasskeysTab.tsx                 passkey register / revoke
      admin/
        AdminConsole.tsx · AdminSidebar.tsx · AdminTabBar.tsx
        OrganizationTab.tsx · WorkspacesTab.tsx · OrgMembersTab.tsx
        OrgTokensTab.tsx · UsersImportCsv.tsx                              (alpha.27)
        AuditTab.tsx                  audit log with filters + pagination  (alpha.34)
        AuthPolicyTab.tsx             JIT policy dropdown                  (alpha.30)
        SearchConfigTab.tsx           search/embedder configuration
        CurrentWorkspaceTab.tsx       current workspace stats/admin
      panels/
        NotePanel.tsx · GraphPanel.tsx · WelcomePanel.tsx
      views/
        FavoritesView.tsx · RecentView.tsx · SearchView.tsx · TrashView.tsx
    layout/
      SettingsModal.tsx               tabs: appearance / editor / mcp ("AI Connection (MCP)") / security / about
    components/
      CodeMirrorEditor · NotesTree · TreeRow · GraphView ·
      CollabBanner · PresenceAvatars · userColor
    ui/
      Button · IconButton · Input · Field · Select · Modal · Section · ListItem ·
      TreeItem · StatusBar · Splitter · ContextMenu · EmptyState · dialogs.tsx (prompt/confirm)
    icons.ts · router.ts · i18n.ts · lib/* (useIsMobile, …) · utils/*
    locales/en.json · es.json · pt.json · it.json · ca.json · zh.json
```

**Conventions**: see [`PATTERNS.md`](./PATTERNS.md). Key rules:
- Global state in `AppContext`, no prop-drilling (§1).
- Mutate → invalidator (`refreshAll`, `refreshOrgs`, `refreshSpaces`), never local patch (§2).
- A single sidebar slot, the Activity Bar swaps content (§3).
- Mobile-first, opt-in breakpoints (§4).
- Errors in-view, no `alert()` (§5).
- Tests for everything (§9) — blocking policy.

## 10. Collaborative editing (Yjs + Hocuspocus)

- **Core**: Hocuspocus WS server on `:3031`, path `/collab`. One in-memory `Y.Doc` per connected note.
- **Persistence**: `notes.yjs_state (bytea)` (`Y.encodeStateAsUpdate`) written in `onStoreDocument` (debounced) and read in `onLoadDocument`. When the last client drops, a final flush.
- **Server-side edits**: mutations via API/MCP call `applyServerEdit()` so connected browsers see the change live (no stale read).
- **Frontend**: `y-codemirror.next` binding with CodeMirror 6 + awareness (remote cursors + avatars). Read-only banner when the WS drops.
- **Config**: `DILUXITE_COLLAB_PUBLIC_URL` (override the WS URL), `DILUXITE_COLLAB_DISABLED=1` (opt-out — falls back to DB-only edits).

**Critical test policy** (lesson from alpha.11): integration tests that use `openDirectConnection` do NOT exercise the real WS layer. Any change touching the Hocuspocus version, the transport library (ws/crossws), or the WS path of `applyServerEdit` MUST update the `describe('collab integration: REAL WebSocket transport')` block. The post-release smoke gate pulls the real image, opens a Node `HocuspocusProvider`, and fails the release if sync does not complete. See [`PATTERNS.md §8`](./PATTERNS.md#8-tests-de-websocket--collab-go-through-a-real-wire).

## 11. Audit log (alpha.34+)

- Append-only — no `UPDATE` or `DELETE` by design (retention via scheduled `DELETE` in `audit-retention.ts`).
- 4 indexes: action, actor_id, at DESC, org_id — designed for the UI filters.
- Events covered: `auth.login.success/failed`, `auth.password.changed`, `auth.password.change_failed`, `admin.user.role_changed`, `admin.token.revoked_all`, `admin.session.revoked`, `admin.session.revoked_all_others`, OIDC sign-in, passkey register/revoke, `admin.user.csv_imported`.
- **Retention** (alpha.38): job that runs hourly if `DILUXITE_AUDIT_RETENTION_DAYS > 0`. Deletes events with `at < now() - N days`. Off by default — the operator decides based on compliance (SOC 2 typically 365d, GDPR 90d).

## 12. Distribution

- **3 Docker images** published by the Release CI to Docker Hub (multi-arch amd64/arm64):
  - `soydiloreto/diluxite` (all-in-one — api + nginx + static web + collab WS via supervisord)
  - `soydiloreto/diluxite-api` (api only + MCP + collab)
  - `soydiloreto/diluxite-web` (nginx + static bundle)
- **Installer** `install.sh` (a single script for Linux / macOS / WSL2 / Git Bash). 9 interactive steps. Generates `docker-compose.yml` from `docker-compose.template.yml` with sed substitution.
- **Tags**:
  - Stable: `:X.Y.Z` (pin) + `:X.Y` + `:latest` (rolling).
  - Pre-release: `:X.Y.Z-alpha.N` (pin) + `:next` (rolling).
- **Auto-update**: **opt-in** via the wizard (default **off**, with a double risk warning — not for production + Docker socket grants host root). Uses the maintained `nickfedor/watchtower` fork (the archived `containrrr/watchtower` crash-loops on Docker ≥ 29). Watchtower polls Docker Hub every 6 h and reconciles containers labeled `com.centurylinklabs.watchtower.enable=true`.
- **Installer management mode** (alpha.45+): re-running `install.sh` on an existing install shows a menu (update / reconfigure / status / backup / restore / uninstall / seed / **reconfigure HTTPS** — item 8, alpha.62) plus non-interactive flags. State persists in `.diluxite-install.env` (no secrets).
- **Backup / restore** (alpha.46+): `install.sh --backup --out file.tar` carries mode/embedder/domain/secrets + Caddy TLS cert. `--restore --in file.tar` can bootstrap a fresh machine (installs Ollama, pulls the model, ends with the same healthcheck + summary as a fresh install).
- **HTTPS** (alpha.33): the wizard's opt-in offers a Caddy sidecar with automatic ACME (`docker compose --profile https up -d`). TLS terminates at `:443`; the Diluxite container listens on plain HTTP internally.
- **HTTPS TLS modes + DNS pre-flight** (alpha.62): `HTTPS_TLS_MODE` persisted in `.diluxite-install.env` — `acme` (default, Let's Encrypt) or `internal` (Caddy's local CA, works offline / for fake domains). Before enabling ACME, a **DNS pre-flight check** resolves the domain against a public resolver (bypassing `/etc/hosts`); on NXDOMAIN or a private IP it offers cancel / `tls internal` / continue-with-warning. New flags: `--reconfigure-https` (jump straight to the HTTPS submenu) and `--export-caddy-ca [--out FILE]` (export Caddy's local root CA to a `.crt` for the OS keychain).

## 13. Env vars (reference)

```
# Core
PORT · DATABASE_URL
ADMIN_DATABASE_URL · TEST_DATABASE_URL              # tests only (integration setup) — not read at runtime

# Auth mode
DILUXITE_AUTH_MODE=local|server                     # default local
DILUXITE_ADMIN_EMAIL · DILUXITE_ADMIN_PASSWORD      # bootstrap server mode
DILUXITE_MFA_SIGNING_KEY                            # signs the short-lived MFA step-2 token (else random per process)

# OIDC SSO (server only)
DILUXITE_OIDC_ISSUER · DILUXITE_OIDC_CLIENT_ID
DILUXITE_OIDC_CLIENT_SECRET · DILUXITE_OIDC_REDIRECT_URI
DILUXITE_OIDC_SCOPES                                # space-separated, default 'openid email profile'
DILUXITE_OIDC_ALLOW_INSECURE=1                      # allow http:// issuer (dev / lab IdPs only)

# Passkeys (WebAuthn relying party — defaults work for http://localhost:5173)
DILUXITE_RP_ID · DILUXITE_RP_NAME · DILUXITE_RP_ORIGIN

# Cloudflare Access JWT (server only — signature-verified, alpha.49+)
DILUXITE_CF_ACCESS_TEAM_DOMAIN=acme.cloudflareaccess.com
DILUXITE_CF_ACCESS_AUD=<application audience tag from CF Access>

# Trusted-header proxy (server only — PLAINTEXT, insecure unless all traffic forced through proxy)
DILUXITE_TRUSTED_IDENTITY_HEADER=X-Auth-Email

# Embeddings (priority: Azure > Ollama > deterministic)
AZURE_OPENAI_ENDPOINT · AZURE_OPENAI_API_KEY · AZURE_OPENAI_DEPLOYMENT · EMBEDDING_DIMENSIONS
OLLAMA_EMBEDDING_MODEL · OLLAMA_EMBEDDING_DIMENSIONS · OLLAMA_ENDPOINT

# Collab WS
COLLAB_PORT=3031                                    # Hocuspocus WS listen port
DILUXITE_COLLAB_PUBLIC_URL=wss://...                # override if custom proxy
DILUXITE_COLLAB_DISABLED=1                          # falls back to DB-only edits

# Email / SMTP (forgot-password reset, future SSO invites + audit alerts)
DILUXITE_SMTP_HOST                                  # set to enable SMTP; else Noop logs to stdout
DILUXITE_SMTP_PORT=587                              # 465 for TLS-on-connect
DILUXITE_SMTP_USER · DILUXITE_SMTP_PASS             # optional (servers requiring AUTH)
DILUXITE_SMTP_SECURE=1                              # TLS on connect (port 465 style)
DILUXITE_SMTP_FROM=noreply@diluxite.your-domain.com
DILUXITE_PUBLIC_WEB_URL=https://diluxite.acme.com   # used to build the reset link

# Operational
DILUXITE_AUDIT_RETENTION_DAYS=365                   # 0/unset = never expires
DILUXITE_CURATION_INTERVAL_DAYS=7                   # weekly review batch; 0 = only the button
DILUXITE_HELMET_DISABLED=1                          # opt-out of security headers
DILUXITE_CSRF_DISABLED=1                            # opt-out of CSRF check
DILUXITE_RATE_LIMIT_DISABLED=1                      # opt-out of rate-limit

# Update check
DILUXITE_LATEST_RELEASE_URL                         # override GH releases API
```

## 14. Technical decisions (ADRs summarized — details in `ROADMAP.md`)

- **Postgres + pgvector** as the single engine. Comfortable up to ~1M vectors on a single instance.
- **Pluggable embeddings provider** with env-based auto-detect (Azure > Ollama > deterministic). No keys → it runs.
- **Tags/links/folders/favorite** persisted at index time — consistency + simple queries.
- **One product** with pluggable ports: a deployment can swap auth or embeddings for its own, and the engine is unchanged either way.
- **Tests for everything** ([`PATTERNS.md §9`](./PATTERNS.md#9-tests-para-todo--política-de-cobertura)). Blocking policy at merge, not "later".
- **Tailwind + our own `ui/`** (not MUI/Chakra) — visual coherence + small bundle.
- **Auth**: 5 backends in server mode (password + passkey + OIDC + CF-Access-JWT + trusted-header) + 2FA TOTP. Local mode is always single-user passwordless.
- **CSRF**: double-submit cookie. SameSite=Lax as the first line, `X-CSRF-Token` as the second.
- **HTTPS**: opt-in Caddy sidecar (`--profile https`). The Diluxite container does NOT handle TLS.
- **Collab**: Yjs CRDT, Hocuspocus 2.x (not 4.x — alpha.11 retracted). NO offline editing (disconnect = read-only).
- **Audit**: append-only, retention via job + env. NO update/delete by design.

## 15. Implementation status

`v1.0.0-alpha.62`: **850+ green tests** (unit + integration + 90 installer e2e bash assertions). Typecheck clean across 4 packages. Lint clean. `SECURITY.md §8` with all "high/medium" gaps closed (2 remain "by design"). Ready for the final sprint toward 1.0-beta — see [`TODO.md`](../TODO.md) and [`ROADMAP.md`](./ROADMAP.md).
