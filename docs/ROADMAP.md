# Diluxite — Roadmap

Lista viva del proyecto. Lo que cierra acá se mueve al `CHANGELOG` del commit
correspondiente. Convertir fechas relativas a absolutas.

## Estado actual (2026-06-02, `v1.0.0-alpha.40`)

- **Core OSS (este repo)**: API + MCP + Web UI en producción contra
  `v1.0.0-alpha.40` en Docker Hub. Dos modos: `local` (single-user
  passwordless `local@diluxite`) y `server` (multi-auth: password +
  passkey + OIDC SSO + trusted-header proxy + 2FA TOTP opcional).
- **Stack runtime**: Node 24, pnpm 10, TypeScript 6, Fastify 5,
  Drizzle 0.45, Postgres 17 + pgvector, React 19, Vite 8, Tailwind 4,
  CodeMirror 6 + Yjs/Hocuspocus.
- **Multi-tenant**: shared-schema + tenant column + RLS (`SET LOCAL
  app.current_user_id`). Org tokens scoped, passkeys per-user,
  CSRF double-submit, security headers (helmet), HTTPS Caddy sidecar
  con ACME.
- **Compliance baseline**: audit log append-only con retention configurable,
  active sessions UI, password change con session invalidation, rate-limit
  en endpoints de auth, MFA optional. `docs/SECURITY.md §8` con todos los
  gaps "alta/media" cerrados (alpha.21+).
- **Tests**: **316 unit + 273 int = 589 verdes** (1 flake conocido en
  `UsersImportCsv.test.tsx` que pasa en isolation — TBD). Typecheck clean
  en 4 packages.

## Hecho desde alpha.10 (resumen por bloque)

### Auth multi-backend
- alpha.20+: bootstrap server-mode admin + token TTL + revoke-all.
- alpha.21: rate-limit `/api/auth/login` (5/min por IP) — extendido luego a
  `/api/auth/login/totp` y `/api/auth/password`.
- alpha.23: MCP token TTL chooser + panic button.
- alpha.25: OIDC SSO con JIT provisioning (Fase 1.1).
- alpha.26: tests E2E OIDC con mock issuer real + jose.
- alpha.27: CSV bulk import users (Fase 1.2).
- alpha.28: TrustedHeaderAuthProvider (Cloudflare Access / Authelia /
  Pomerium) — port del patrón Diluxclaw.
- alpha.29: security headers via `@fastify/helmet`.
- alpha.30: Settings UI Admin → Auth policy (Fase 1.3).
- alpha.31: install.sh post-install SSO hints en server mode.
- alpha.32: **CSRF double-submit cookie** (cierra gap SECURITY.md §8).
- alpha.33: **HTTPS Caddy sidecar** + wizard inline OIDC/trusted-header.
- alpha.36+37: **2FA TOTP** (RFC 6238 + backup codes + login flow + UI).
- alpha.39: **Active sessions UI** — list + revoke + revoke-others.
- alpha.40: **Password change** + session invalidation.

### Audit & compliance
- alpha.34: schema `audit_events` append-only + repo + endpoint admin
  + UI AuditTab.
- alpha.35: full coverage de eventos (logout, OIDC denied paths, token
  mint/revoke, etc).
- alpha.38: retention job (`DILUXITE_AUDIT_RETENTION_DAYS`).

### Wizard installer
- alpha.31+33+45: instalador interactivo con prompts inline para domain
  HTTPS, OIDC, trusted-header. Caddyfile auto-generado con ACME.
- Post-install summary muestra estado real de auth backends.

## Pendiente

### Para cerrar alpha → 1.0-beta (3-4 días focado)

Lo siguiente sería un sprint corto de UX/usabilidad antes de declarar beta:

| | Esfuerzo | Por qué |
|---|---|---|
| **Trash bin / soft delete** | 1-2 días | DELETE actual es hard. User espera "deshacer". |
| **Forgot password / reset por email** | 2 días | Hoy solo via `docker exec`. |
| **Email service abstraction** (SMTP/SES/Mailgun) | 1 día | Backbone para reset, SSO invites, alertas. |
| **Backup / restore CLI** | 2 días | `diluxite backup --out file.tar` con todo. Compliance must. |
| **i18n del backend** (errores localizados por `Accept-Language`) | 1 día | Hoy mezcla ES/EN. |
| **Accessibility audit** WCAG AA | 2 días | Roles ARIA, keyboard nav, contraste. |
| **Fix flake `UsersImportCsv` test** | <1 hora | Pasa en isolation, falla bajo CPU load. |

### Del PRD v2 original — "próximo"

| | Esfuerzo | Notas |
|---|---|---|
| **Daily notes + plantillas** | 1-2 días | Sección dedicada en sidebar; templates de notas. |
| **Adjuntos** (imágenes / archivos → texto) | 3-4 días | Upload, storage `__DATA_PATH__/attachments`, OCR/extract para semantic search. |
| **Import desde Obsidian / Notion / Joplin** | 2-3 días | Parser ZIP/folder → bulk createNote con preservación de wikilinks. |
| **Eval semántica español** | 1 día | Suite de queries con expected top-K — baseline reproducible. |

### Features de usabilidad que se infieren del producto

| | Esfuerzo | Notas |
|---|---|---|
| **Note versioning** (history + restore) | 3-4 días | Tabla `note_revisions`, view diff, restore. |
| **Public sharing** (read-only link) | 2 días | Token público + Share button en UI. |
| **Export markdown ZIP** del space | 1 día | Endpoint + button, frontmatter YAML + assets. |
| **Bulk operations** (multi-select tag/move/archive) | 1 día | Multi-select delete ya existe; faltan otras operaciones. |

### Enterprise / operational

| | Esfuerzo | Notas |
|---|---|---|
| **SCIM 2.0** provisioning | 4-5 días | Auto user provisioning desde Okta/Entra IdP. Heavy. |
| **Webhooks** (event → POST URL) | 2 días | `note.created`, `auth.login.failed`, etc. |
| **Observability** (Prometheus `/metrics`) | 1 día | Latencias, request counts, embedder errors. |
| **Audit log alerting** (webhook on N failed logins) | 1 día | Encima del audit + webhooks. |
| **SSO group/role mapping** | 1-2 días | Claims OIDC `groups: [...]` → asigna role. |
| **CSP nonce** (en vez de `unsafe-inline`) | 1 día | Endurece XSS defense. |
| **Performance benchmarks reproducibles** | 1 día | Baselines de search p95, list 1k notes, etc. |
| **Playwright CI** | 1 día | Suite E2E ya escrita; falta wire en GitHub Actions. |

### Por fuera del Core (van en `diluxite-saas` privado)

- **Cloud multi-tenant**: Entra real (Google + MS), billing, dashboard de
  cuotas, AKS + Azure Front Door.
- **Kubernetes manifests** (v1.1 del roadmap original).

## Decisiones tomadas (ADR mini)

- **Open-core**: motor y UI AGPL-3.0. Cloud (multi-tenant, billing, Entra)
  queda privado en `diluxite-saas`.
- **Stack web**: `dockview-react`, **CodeMirror 6** + `y-codemirror.next`,
  `cmdk`, `lucide-react`.
- **MCP transport**: Streamable HTTP con sesión por usuario; identidad
  derivada del token validado.
- **Chunking**: heading-aware, ~512 tokens con ~64 overlap. Notas ≤ 400
  tokens se embeben enteras.
- **Embeddings**: provider pluggable. Default Ollama (con
  `keep_alive: '24h'`). Opcional Azure OpenAI. Fallback determinístico.
- **Collab**: Yjs CRDT + Hocuspocus WebSocket server. **NO** edición offline.
- **Auth**: 4 backends posibles (password + passkey + OIDC + trusted-header)
  + 2FA TOTP opcional. Local mode siempre single-user passwordless.
- **CSRF**: double-submit cookie. SameSite=Lax es la primera línea,
  `X-CSRF-Token` la segunda.
- **HTTPS**: Caddy sidecar opt-in via `docker compose --profile https`.
  ACME automático. NO se intenta hacer TLS en el container `diluxite`.
- **Audit**: append-only, NO update/delete por diseño. Retention vía env.

## Cosas que NO vamos a hacer

- Aplicación Electron / desktop nativo. Web-first; PWA si el user quiere.
- Plugin system al estilo Obsidian. Extensibilidad vía MCP tools.
- Edición offline en collab — disconnect = read-only (decisión consciente
  para no exponer al user a conflicts complejos).
