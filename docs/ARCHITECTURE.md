# ARCHITECTURE — Diluxite (contexto técnico)

> Doc técnico vivo. Acompaña al [`PRD.md`](./PRD.md). Permite reconstruir el proyecto desde cero. Última actualización: **2026-06-02** (`v1.0.0-alpha.40`).
>
> Para el porqué de cada decisión enterprise (auth, audit, CSRF, HTTPS, collab) ver `CHANGELOG.md` por release.

## 1. Stack

- **Lenguaje**: TypeScript 6 (Node ≥ 24), ESM. Monorepo **pnpm 10** workspaces.
- **Backend API**: **Fastify 5** + **Drizzle 0.45** + **PostgreSQL 17 + pgvector**.
- **Collab WS**: **Hocuspocus 2.x** + **Yjs** (CRDT). Puerto interno `:3031`, ruta `/collab` ruteada via nginx.
- **MCP server**: `@modelcontextprotocol/sdk` (Streamable HTTP, stateful por sesión).
- **Embeddings**: provider pluggable. Auto-detect por env: Azure OpenAI > Ollama (con `keep_alive: '24h'`) > determinista.
- **Frontend**: **React 19** + **Vite 8** + **Tailwind 4** + **CodeMirror 6** (editor) + Dockview + cmdk + lucide. i18n via `i18next` (en default, es/pt soportados).
- **Tests**: **Vitest 4** (proyectos por paquete) + Testing Library (web) + cliente MCP real (E2E) + Playwright (browser real, post-release smoke en CI).
- **Security middleware**: `@fastify/helmet` (CSP/HSTS), `@fastify/rate-limit`, CSRF double-submit propio.
- **Auth backends**: password (PBKDF2-SHA512), passkeys (`@simplewebauthn/server`), OIDC (`openid-client` con PKCE S256), trusted-header proxy, TOTP RFC 6238.
- **Infra**: Docker Compose (Postgres + Diluxite + opcional Caddy sidecar HTTPS + opcional Watchtower auto-update).

## 2. Estructura de archivos

```
diluxite-core-alpha/             PÚBLICO, AGPL-3.0 — motor + UI OSS
  apps/
    api/    Fastify: REST + MCP + collab WS + audit retention job
    web/    React + Vite + Tailwind + CodeMirror + Yjs binding
  packages/
    core/   dominio puro (notes, embeddings, search, auth providers, totp, csv parser, …)
    db/     Drizzle: schema, 14 migraciones, repos, RLS bootstrap
  docker/
    api.Dockerfile · web.Dockerfile · allinone.Dockerfile · hub-readme-*.md
    Caddyfile.template  (alpha.33+, sidecar HTTPS)
  docker-compose.template.yml    → installer genera el real en ~/diluxite/
  install.sh                     (9 steps, EN/ES/PT)

diluxite-saas/                   PRIVADO — edición Cloud
  src/server.ts                  multi-tenant que importa @diluxite/api
  src/entra.ts                   EntraAuthProvider
```

## 3. Open-core: interfaces enchufables

Cada concern crítico vive detrás de una interfaz en `@diluxite/core`. Cloud reemplaza impls; Core las trae todas funcionales.

| Puerto | Core (este repo) | Cloud |
|---|---|---|
| `AuthProvider` | `SingleUserAuthProvider` (local mode) o `SessionAuthProvider` (server mode, opcional chained con `TrustedHeaderAuthProvider`) | `EntraAuthProvider` |
| `EmbeddingProvider` | `DeterministicEmbeddingProvider` / `OllamaEmbeddingProvider` / `AzureOpenAIEmbeddingProvider` (auto por env) | Azure OpenAI |
| `EmailProvider` | (roadmap — necesario para forgot-password / SSO invites / audit alerts) | Azure Communication Services o SendGrid |
| `Reranker` | `IdentityReranker` | Cohere / cross-encoder (futuro) |
| `SpaceAccess`, `TokenStore`, `SessionStore`, `PasskeyStore`, `TotpStore`, `AuditStore`, `OidcStore` | `Drizzle*Repository` para cada uno | idem |

## 4. Modelo de datos (alpha.40)

Identifiers en inglés desde v4.0. 14 migraciones aplicadas (`packages/db/migrations/`).

```
users          id · email(unique) · provider · created_at
               first_name · last_name · active · last_login_at        (alpha.24 / mig 0010)
spaces         id · name · owner_id · org_id · created_at
organizations  id · name · slug · created_at
org_settings   org_id (PK) · auth_policy                              (alpha.24 / mig 0010)
memberships    (space_id, user_id) pk · role(owner|member)
org_memberships (org_id, user_id) pk · role(super_admin|admin|member)
folders        id · space_id · parent_id (self-ref) · name · created_at
notes          id · space_id · folder_id · title · content_md ·
               favorite · created_at · updated_at
               yjs_state(bytea) · yjs_updated_at                      (alpha.10 / mig 0007)
chunks         id · note_id(cascade) · space_id · text · position ·
               embedding vector (dim any)                             (alpha.17 / mig 0008)
               índices: GIN to_tsvector('spanish',text) · HNSW vector_cosine_ops · (space_id)
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
               4 índices (action, actor, at-desc, org)
totp_secrets   user_id(PK) · secret · confirmed_at · backup_codes[]   (alpha.36 / mig 0013)
```

**Multi-tenant model**: shared-schema + tenant column + Postgres RLS. Detalle completo en [`MULTI-TENANT.md`](./MULTI-TENANT.md). Toda query corre con `SET LOCAL app.current_user_id = '<uuid>'` y las políticas de RLS filtran por membership.

**Borrado cascada**: `folders.parent_id` self-ref con `onDelete: 'cascade'`; `notes.folder_id` también. Para conservar nota antes de borrar carpeta: moverla con `PUT /api/notes/:id { folderId: null }`. Hard delete por ahora (trash bin/soft delete en roadmap).

## 5. Búsqueda híbrida

Pipeline:
- **Al guardar**: `parseTags()` + `parseLinks()` + `chunkMarkdown` (heading-aware, ~512 tokens / overlap 64; cortas enteras) + `embedder.embed` + `indexChunks`.
- **Al buscar** (`mode: hybrid|keyword|semantic`):
  1. Keyword: FTS español de Postgres.
  2. Vector: pgvector cosine.
  3. RRF (k=60) merge.
  4. Mejor chunk por nota.
  5. `Reranker.rerank` (identity en Core).
  6. Top-K (default 5).

## 6. MCP server

- `/mcp` Streamable HTTP, stateful por `Mcp-Session-Id`.
- En `initialize`: `auth.resolve(headers)` → identity + default space.
- **10 tools** (todas en inglés): `search_memory`, `list_notes`, `read_note`, `write_note`, `list_spaces`, `list_tags`, `search_by_tag`, `recent_notes`, `backlinks_of`, `append_to_note`.
- Cada tool autoriza por membership; mutations vía MCP también disparan `applyServerEdit()` en Yjs si hay clientes conectados a esa nota (cambios se ven en vivo en browsers abiertos).

## 7. Auth y multi-tenant (server mode)

Detalle exhaustivo en [`SECURITY.md`](./SECURITY.md). Resumen:

- **Modo `local`** (default `DILUXITE_AUTH_MODE=local`): `SingleUserAuthProvider` → toda request es el user bootstrap `local@diluxite`. Sin login screen.
- **Modo `server`**: `SessionAuthProvider` lee cookie HttpOnly `diluxite_session` o `Authorization: Bearer <token>`. Sesiones opacas (no JWT) con hash SHA-256 en DB.
  - Opcional **chained** con `TrustedHeaderAuthProvider` si `DILUXITE_TRUSTED_IDENTITY_HEADER` está set — para reverse proxies que ya autenticaron (Cloudflare Access, Authelia, Pomerium).
- **4 backends de login** (server mode):
  1. Email + password (PBKDF2-SHA512, salt random).
  2. WebAuthn passkeys.
  3. **OIDC SSO** (alpha.25): PKCE S256, claims extraction + JIT provisioning según `org_settings.auth_policy` (`deny_unknown` / `allow_unknown_as_member` (default) / `pre_provisioned_only`). Probado con Entra/Okta/Google/Authentik.
  4. **TrustedHeader** (alpha.28): identity desde header inyectado por reverse proxy.
- **2FA TOTP** (alpha.36+37): RFC 6238 con backup codes. Opt-in en Settings → Two-factor authentication; login flow se gating cuando está activo.
- **Rate-limit** (alpha.21): 5/min/IP en `/api/auth/login`, `/login/totp`, `/auth/password`. Plugin `@fastify/rate-limit`.
- **CSRF** (alpha.32): double-submit cookie `diluxite_csrf` (NO-HttpOnly) + header `X-CSRF-Token`. Bearer requests skip check.
- **Security headers** (alpha.29): `@fastify/helmet` con CSP, HSTS (cuando HTTPS), Referrer-Policy, X-Frame-Options.

**Authz por workspace**: cada handler que toca space hace `requireMember(spaceId, userId)` antes de la query. La defensa en profundidad la cierra la RLS de Postgres.

## 8. API REST (wire format en inglés)

```
GET    /health · /health/db
GET    /api/info                            {embedder, version, user, authMode, oidcEnabled, …}

# Notes
GET    /api/spaces · POST /api/spaces · POST /api/spaces/:id/members
GET    /api/spaces/:id/notes[?tag=&folder=]
POST   /api/spaces/:id/notes                {title, contentMd, folderId?}
GET    /api/spaces/:id/tags · /graph · /stats
GET    /api/spaces/:id/folders              árbol completo
POST   /api/spaces/:id/folders              {name, parentId?}
PUT    /api/folders/:id                     {name?, parentId?}
DELETE /api/folders/:id
GET    /api/notes/:id · PUT · DELETE · GET /api/notes/:id/backlinks
POST   /api/notes/:id/append                {content}
PUT    /api/notes/:id/favorite              {favorite: bool}
POST   /api/notes/delete-many               {ids: [...]}
POST   /api/search                          {query, spaceId?, topK?, mode?}

# Tokens (user-scoped y org-scoped)
POST   /api/tokens                          {name, expiresInDays?}
GET    /api/tokens · DELETE /api/tokens/:id
POST   /api/tokens/revoke-all               panic button — alpha.22
POST   /api/orgs/:orgId/tokens              org-scoped, alpha.6
GET    /api/orgs/:orgId/tokens
DELETE /api/orgs/:orgId/tokens/:id

# Auth — server mode only
POST   /api/auth/login                      {email, password}    rate-limit
POST   /api/auth/logout
POST   /api/auth/password                   {currentPassword, newPassword}   alpha.40
GET    /api/auth/sessions                   list active sessions             alpha.39
DELETE /api/auth/sessions/:id               revoke individual
POST   /api/auth/sessions/revoke-others     sign out other devices

# OIDC SSO                                  alpha.25
GET    /api/auth/oidc/login                 → 302 al IdP
GET    /api/auth/oidc/callback              JIT + cookie sesión

# TOTP 2FA                                  alpha.36+37
GET    /api/auth/totp/status
POST   /api/auth/totp/enroll                start enroll
POST   /api/auth/totp/verify-enroll         confirm 6-digit + backup codes
DELETE /api/auth/totp                       disable
POST   /api/auth/login/totp                 step-2 después de password
                                              rate-limit

# Passkeys                                  alpha.7
POST   /api/auth/passkey/register-options · register-verify
POST   /api/auth/passkey/authenticate-options · authenticate-verify
GET    /api/passkeys · DELETE /api/passkeys/:id

# Admin                                     alpha.24+
GET/PUT /api/admin/orgs/:orgId/auth-policy
POST    /api/admin/orgs/:orgId/users/import-csv   alpha.27 multipart
GET     /api/admin/orgs/:orgId/audit              alpha.34 — filtros action/actor/fecha/IP
```

## 9. Frontend (React 19 + Vite 8 + Tailwind 4)

```
apps/web/
  vite.config.ts · tailwind.config.ts · postcss.config.js
  src/
    main.tsx · App.tsx · api.ts · fakeApi.ts · markdown.ts · useSettings.ts
    shell/
      AppContext.tsx                  estado global + invalidators (PATTERNS §1-2)
      AppGate.tsx                     loading → authenticated | login-required | error
      ActivityBar.tsx · TopBar.tsx · Sidebar.tsx · DockShell.tsx
      OrgIndicator.tsx · WorkspaceSelector.tsx · UpdateBanner.tsx
      LoginScreen.tsx                 password + passkey + OIDC + TOTP step 2
      SessionsTab.tsx                 active sessions + password change   (alpha.39+40)
      TwoFactorTab.tsx                TOTP enroll / disable               (alpha.37)
      admin/
        AdminConsole.tsx · AdminSidebar.tsx · AdminTabBar.tsx
        OrganizationTab.tsx · WorkspacesTab.tsx · OrgMembersTab.tsx
        OrgTokensTab.tsx · UsersImportCsv.tsx                              (alpha.27)
        AuditTab.tsx                  audit log con filtros + paginación   (alpha.34)
        AuthPolicyTab.tsx             JIT policy dropdown                  (alpha.30)
      views/
        FavoritesView.tsx · RecentView.tsx · SearchView.tsx
    layout/
      SettingsModal.tsx               tabs: connect / appearance / search / ai / mcp / space / passkeys / twofactor / sessions / about
    ui/
      Button · Input · Field · Modal · Section · Sidebar · ListItem · TreeItem · StatusBar · Toast · Tooltip · EmptyState · dialogs.tsx (prompt/confirm)
    icons.ts · router.ts · useIsMobile.ts · i18n.ts · lib/*
    locales/en.json · es.json · pt.json
```

**Convenciones**: ver [`PATTERNS.md`](./PATTERNS.md). Reglas clave:
- State global en `AppContext`, no prop-drilling (§1).
- Mutate → invalidator (`refreshAll`, `refreshOrgs`, `refreshSpaces`), nunca patch local (§2).
- Un solo sidebar slot, Activity Bar swaps content (§3).
- Mobile-first, breakpoints opt-in (§4).
- Errors in-view, no `alert()` (§5).
- Tests para todo (§9) — política blocking.

## 10. Edición colaborativa (Yjs + Hocuspocus)

- **Núcleo**: Hocuspocus server WS en `:3031` ruta `/collab`. Un `Y.Doc` en memoria por nota conectada.
- **Persistencia**: `notes.yjs_state (bytea)` (`Y.encodeStateAsUpdate`) escrita en `onStoreDocument` (debounced) y leída en `onLoadDocument`. Cuando se cae el último cliente, último flush.
- **Server-side edits**: mutations vía API/MCP llaman `applyServerEdit()` para que browsers conectados vean el cambio en vivo (no stale read).
- **Frontend**: `y-codemirror.next` binding con CodeMirror 6 + awareness (cursores remotos + avatares). Read-only banner cuando WS se cae.
- **Config**: `DILUXITE_COLLAB_PUBLIC_URL` (override del WS URL), `DILUXITE_COLLAB_DISABLED=1` (opt-out — vuelve a DB-only edits).

**Test policy crítica** (lección de alpha.11): los tests integration que usan `openDirectConnection` NO prueban el WS layer real. Cualquier cambio que toque Hocuspocus version, transport library (ws/crossws), o el WS path de `applyServerEdit` DEBE actualizar el `describe('collab integration: REAL WebSocket transport')` block. Smoke gate post-release pulla la imagen real, abre `HocuspocusProvider` Node, falla el release si sync no completa. Ver [`PATTERNS.md §8`](./PATTERNS.md#8-tests-de-websocket--collab-go-through-a-real-wire).

## 11. Audit log (alpha.34+)

- Append-only — sin `UPDATE` ni `DELETE` por diseño (retention vía `DELETE` programado en `audit-retention.ts`).
- 4 índices: action, actor_id, at DESC, org_id — pensados para los filtros del UI.
- Eventos cubiertos: `auth.login.success/failed`, `auth.password.changed`, `auth.password.change_failed`, `admin.user.role_changed`, `admin.token.revoked_all`, `admin.session.revoked`, `admin.session.revoked_all_others`, OIDC sign-in, passkey register/revoke, `admin.user.csv_imported`.
- **Retention** (alpha.38): job que corre cada hora si `DILUXITE_AUDIT_RETENTION_DAYS > 0`. Borra eventos con `at < now() - N days`. Off por default — operator decide según compliance (SOC 2 típico 365d, GDPR 90d).

## 12. Distribución

- **3 imágenes Docker** publicadas por Release CI a Docker Hub (multi-arch amd64/arm64):
  - `soydiloreto/diluxite` (all-in-one — api + nginx + web estática + collab WS via supervisord)
  - `soydiloreto/diluxite-api` (solo api + MCP + collab)
  - `soydiloreto/diluxite-web` (nginx + bundle estático)
- **Installer** `install.sh` (un solo script para Linux / macOS / WSL2 / Git Bash). 9 steps interactivos. Genera `docker-compose.yml` desde `docker-compose.template.yml` con sustitución sed.
- **Tags**:
  - Estable: `:X.Y.Z` (pin) + `:X.Y` + `:latest` (rolling).
  - Pre-release: `:X.Y.Z-alpha.N` (pin) + `:next` (rolling).
- **Auto-update**: opt-out via wizard Step 7 (default Yes). Watchtower revisa Docker Hub cada 6 h y reconcilia containers con label `com.centurylinklabs.watchtower.enable=true`.
- **HTTPS** (alpha.33): wizard opt-in offrece Caddy sidecar con ACME automático (`docker compose --profile https up -d`). TLS termina en `:443`; el container Diluxite escucha plain HTTP internamente.

## 13. Env vars (referencia)

```
# Core
PORT · DATABASE_URL · ADMIN_DATABASE_URL · TEST_DATABASE_URL

# Auth mode
DILUXITE_AUTH_MODE=local|server                     # default local
DILUXITE_ADMIN_EMAIL · DILUXITE_ADMIN_PASSWORD      # bootstrap server mode

# OIDC SSO (server only)
DILUXITE_OIDC_ISSUER · DILUXITE_OIDC_CLIENT_ID
DILUXITE_OIDC_CLIENT_SECRET · DILUXITE_OIDC_REDIRECT_URI

# Trusted-header proxy (server only, alternativa a OIDC)
DILUXITE_TRUSTED_IDENTITY_HEADER=X-Auth-Email

# Embeddings (prioridad: Azure > Ollama > determinista)
AZURE_OPENAI_ENDPOINT · AZURE_OPENAI_API_KEY · AZURE_OPENAI_DEPLOYMENT · EMBEDDING_DIMENSIONS
OLLAMA_EMBEDDING_MODEL · OLLAMA_EMBEDDING_DIMENSIONS · OLLAMA_ENDPOINT

# Collab WS
DILUXITE_COLLAB_PUBLIC_URL=wss://...                # override si proxy custom
DILUXITE_COLLAB_DISABLED=1                          # vuelve a DB-only edits

# Operacional
DILUXITE_AUDIT_RETENTION_DAYS=365                   # 0/unset = no expira
DILUXITE_HELMET_DISABLED=1                          # opt-out security headers
DILUXITE_CSRF_DISABLED=1                            # opt-out CSRF check
DILUXITE_RATE_LIMIT_DISABLED=1                      # opt-out rate-limit

# Update check
DILUXITE_LATEST_RELEASE_URL                         # override GH releases API
```

## 14. Decisiones técnicas (ADR resumidas — detalle en `ROADMAP.md`)

- **Postgres + pgvector** único motor. Hasta ~1M vectores cómodo en single instance.
- **Embeddings provider pluggable** con auto-detect por env (Azure > Ollama > determinista). Sin claves → corre.
- **Tags/links/folders/favorite** persistidos al indexar — consistencia + queries simples.
- **Open-core** con puertos enchufables; Cloud cambia auth/embeddings/billing pero el motor es el mismo.
- **Tests para todo** ([`PATTERNS.md §9`](./PATTERNS.md#9-tests-para-todo--política-de-cobertura)). Política bloqueante al merge, no "después".
- **Tailwind + `ui/` propio** (no MUI/Chakra) — coherencia visual + bundle chico.
- **Auth**: 4 backends en server mode + 2FA TOTP. Local mode siempre single-user passwordless.
- **CSRF**: double-submit cookie. SameSite=Lax primera línea, `X-CSRF-Token` segunda.
- **HTTPS**: Caddy sidecar opt-in (`--profile https`). Container Diluxite NO maneja TLS.
- **Collab**: Yjs CRDT, Hocuspocus 2.x (no 4.x — alpha.11 retracted). NO edición offline (disconnect = read-only).
- **Audit**: append-only, retention vía job + env. NO update/delete por diseño.

## 15. Estado de implementación

`v1.0.0-alpha.40`: **316 unit + 273 int = 589 tests verdes**. Typecheck clean en 4 packages. `SECURITY.md §8` con todos los gaps "alta/media" cerrados (2 quedan "by design"). Listo para sprint final hacia 1.0-beta — ver [`TODO.md`](../TODO.md) y [`ROADMAP.md`](./ROADMAP.md).
