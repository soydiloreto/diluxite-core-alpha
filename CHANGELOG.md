# Changelog

All notable changes to Diluxite Core are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-alpha.31] — 2026-06-02

**Wizard `install.sh` — hints de SSO post-install en server mode** (Fase #45, paso 1).

Cuando el operator elige `2) Server` en el wizard, el resumen final ahora
incluye un bloque **Enterprise SSO (optional)** que explica los tres backends
de auth disponibles más allá del email+password del admin bootstrap:

1. **Email + password** (ya configurado por el wizard).
2. **OIDC SSO** (Okta / Entra / Google / Authentik / Auth0). Muestra las 4 env
   vars exactas a agregar al `docker-compose.yml` del install path
   (`DILUXITE_OIDC_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT_URI`)
   y aclara que tras `docker compose up -d` aparece el botón **"Sign in with SSO"**
   en la pantalla de login.
3. **Identity-Aware Proxy** (Cloudflare Access / Authelia / Pomerium):
   `DILUXITE_TRUSTED_IDENTITY_HEADER` + advertencia explícita sobre el modelo
   de confianza — TODO el tráfico tiene que pasar por el proxy o el header
   puede ser falsificado.

Además aclara cómo cargar la lista inicial de usuarios por **CSV bulk-import**
(Admin Console → Users → "Import CSV") y dónde está la **default auth policy**
(`allow_unknown_as_member`, configurable en Settings → Auth).

El bloque NO aparece en modo `local` (no aplica — local mode bypassa auth).

Próximos pasos pendientes en Fase #45 (no en esta release): mover el prompt
de modo arriba del wizard, y agregar prompts inline opcionales para OIDC y
trusted-header en lugar de instrucciones post-install.

## [1.0.0-alpha.30] — 2026-06-02

**Fase 1.3 — Settings UI para auth policy** + endpoints REST.

### Endpoints

`GET  /api/admin/orgs/:orgId/auth-policy` → `{ policy }`
- Members + admins pueden leer (UX: ver el valor actual).
- 404 cuando OIDC no está habilitado en el server (la policy no aplica).
- 403 cuando el caller no es miembro de la org.

`PUT  /api/admin/orgs/:orgId/auth-policy` con body `{ policy }`
- Solo admin/super_admin pueden cambiar.
- 400 con policy desconocida (whitelist enforced).
- Idempotente (escribir el mismo valor 3x → OK).
- 403 para member roles.
- 404 cuando OIDC no está configurado.

### UI

`apps/web/src/shell/admin/AuthPolicyTab.tsx`:
- Carga la policy actual al mount.
- 3 radio buttons con título + descripción humana.
- Las opciones restrictivas (`deny_unknown`, `pre_provisioned_only`)
  muestran un warning amarillo "import the user CSV first" para que
  el admin no se bloquee a sí mismo.
- Selección dispara save inmediato (no botón Save aparte).
- Confirmation message visible tras un save exitoso.
- Loading + error states friendly.

### Client API

`api.ts` agrega `getAuthPolicy(orgId)` + `setAuthPolicy(orgId, policy)` +
`AuthPolicyValue` type. `fakeApi` los implementa con estado in-memory.

### Tests (+20)

**11 integration** (`auth-policy-api.integration.test.ts`):
- GET default (allow_unknown_as_member) cuando no hay row.
- GET persistido después de PUT.
- GET 403 para non-member.
- PUT admin con los 3 valores válidos.
- PUT idempotente (3x mismo valor).
- PUT 400 con policy unknown / missing field.
- PUT 403 para member rol.
- GET/PUT 404 cuando deps.oidc no está wireado.

**9 UI** (`AuthPolicyTab.test.tsx`):
- Loading → 3 opciones, current marked.
- Click otro → llama setAuthPolicy con el valor.
- Confirmation visible post-save.
- Newly-selected stays checked.
- Errors: getAuthPolicy throw → alert; OIDC null → friendly message;
  setAuthPolicy throws → alert + previo se mantiene.
- UX: opciones restrictivas tienen warning, la default no.

Total: 417/417 verde, 0 regresiones.

### Pendiente del Fase 1.5

- HTTPS por default (Caddy sidecar) — alpha.31+.
- CSRF token explícito — alpha.31+.
- Mejorar wizard install.sh.

## [1.0.0-alpha.29] — 2026-06-02

**Fase 1.5 parte 1 — Security headers via `@fastify/helmet`**.

`apps/api/src/app.ts` registra Helmet con config conservadora:

- **CSP**: `default-src 'self'`, script-src estricto (sin unsafe-inline →
  XSS-resistant), style-src 'self' + 'unsafe-inline' (Vite genera CSS
  con tags inline para critical-CSS), connect-src `'self' ws: wss:`,
  img-src `'self' data: blob:`, **frame-ancestors `'none'`** (anti
  clickjacking).
- **HSTS** 1 año + includeSubDomains.
- **X-Content-Type-Options**: nosniff.
- **Referrer-Policy**: strict-origin-when-cross-origin.
- **Cross-Origin-Opener-Policy** + **Cross-Origin-Resource-Policy**:
  same-origin.

Opt-out vía `DILUXITE_HELMET_DISABLED=1` (la suite integration global lo
setea por default para no inflar los tests con headers).

### Tests (+7)

`apps/api/src/security-headers.integration.test.ts`:

- CSP presente + default-src 'self' + script-src sin unsafe-inline +
  frame-ancestors 'none'.
- HSTS max-age >= 1 año + includeSubDomains.
- X-Content-Type-Options: nosniff.
- Referrer-Policy: strict-origin-when-cross-origin.
- COOP: same-origin.
- CORP: same-origin.
- Opt-out flag: con DILUXITE_HELMET_DISABLED=1 NO se agregan headers.

Total: 397/397 verde.

### Pendiente del Fase 1.5

- **HTTPS por default** (Caddy sidecar en docker-compose.template +
  install.sh prompt de dominio) — próximo alpha.
- **CSRF token** (double-submit cookie pattern) — próximo alpha.

## [1.0.0-alpha.28] — 2026-06-02

**Fase 1.4 — TrustedHeaderAuthProvider** (port del patrón de Diluxclaw).

Permite poner Diluxite detrás de un Identity-Aware Proxy (Cloudflare
Access, Authelia, Pomerium, oauth2-proxy, traefik-forward-auth) que
autentica al user upstream y nos pasa la identidad en un header firmado
por la red.

### Cambios

`packages/core/src/auth.ts`:
- Nueva interface `UsersRepoForTrustedHeader` (minimal contract sin
  acoplarnos a `@diluxite/db`).
- `AuthPolicy` type exportado para reusar en otros providers.
- `TrustedHeaderAuthProvider` con resolve() que cubre todas las ramas:
  - Header missing/empty/array-empty → null (delega).
  - Email malformed → null.
  - User existing + active → touchLastLogin + identity.
  - User existing + active=false → null (gate cierra el API a 401).
  - User unknown + policy `allow_unknown_as_member` → JIT create con
    provider='trusted_header'.
  - User unknown + policy `deny_unknown` / `pre_provisioned_only` → null.

`apps/api/src/services.ts`: opcionalmente activa el provider al boot si
`DILUXITE_TRUSTED_IDENTITY_HEADER` está seteado. Lo encadena con el
SessionAuthProvider: si la sesión cookie/Bearer NO resuelve, el header
hace de fallback. Si ambos resuelven (caso raro), gana la sesión
explícita.

### Trust model documentado

Cualquiera que pueda alcanzar el puerto del API SIN pasar por el proxy
puede spoofear el header e impersonar usuarios. Es **responsabilidad
del operator** garantizar que el path de red obliga a todos los
requests a pasar por el proxy (listener privado / firewall). El
provider y la doc lo dicen explícitamente.

### Tests (+23 furiosos)

**14 unit** (`packages/core/src/trusted-header-auth.test.ts`):
- Header presence: missing, empty string, empty array, multi-value
  (toma el primero).
- Email shape: malformado → null, lowercase + trim, multi-value.
- Existing user: active → identity + touchLastLogin; soft-disabled →
  null + NO touch.
- JIT under policy: allow_unknown → JIT create+touch; deny_unknown →
  null sin create/touch; pre_provisioned_only desconocido → null;
  pre_provisioned_only con user pre-cargado vía CSV → identity.
- Config: header name custom, NO honra el default Cloudflare si está
  configurado distinto.

**9 integration** (`apps/api/src/trusted-header.integration.test.ts`):
- End-to-end Fastify + DB real:
  - Header con email válido + JIT → GET /api/spaces returns 200.
  - User existing csv_import → header lo resuelve sin sobreescribir
    provider.
  - last_login_at se actualiza en cada request.
  - No header → 401.
  - Header malformed → 401.
  - User active=false → 401.
  - Policy deny_unknown + email desconocido → 401, user NO se crea.
  - Policy pre_provisioned_only + email desconocido → 401.
  - Header name custom → solo respeta ESE header (no el default).

Total: 390/390 verde, 0 regresiones.

### Pendiente del backlog

- Fase 1.3: UI Settings → Auth tab para cambiar policy desde admin
  (queda como tarea separada — el endpoint para set policy también).
- Fase 1.5: HTTPS default + security headers + CSRF.
- Wizard install mejorado.

## [1.0.0-alpha.27] — 2026-06-01

**Fase 1.2 — Bulk CSV import de usuarios**. Endpoint + UI + parser + 44
tests con la política tests-furiosos.

### Parser (`packages/core/src/csv-users.ts`)

`parseUsersCsv(text)` — sin dep externa, AGPL-friendly:
- Auto-detecta separador (`,` o `;` — Excel locale es).
- Quotes RFC 4180 con escape `""`.
- BOM UTF-8 stripeado.
- CRLF y LF.
- Headers case-insensitive con sinónimos (e-mail, correo, nombre, apellido,
  rol, given_name, family_name, etc.).
- Solo `email` es required.
- Roles validados contra el enum (admin/super_admin/member/editor/viewer).
- Per-row errors con line number 1-based + raw text para reporte UI.
- Detecta duplicados intra-CSV.

### API endpoint

`POST /api/admin/orgs/:orgId/users/import-csv`
  - Body: `{ csv: string, dryRun?: boolean }`
  - Permite SOLO admin/super_admin de la org → 403 para el resto.
  - Validates body shape → 400.
  - 413 si > 2 MB.
  - Dry-run: parse + return preview, no DB writes.
  - Apply: upsert por email vía `users.upsertFromCsv`, devuelve counts
    created/updated.
  - Per-row parse errors NO abortan el batch — las filas buenas se aplican.

### UI (`apps/web/src/shell/admin/UsersImportCsv.tsx`)

Componente standalone reutilizable:
- Drag-drop zone + file picker + textarea (3 formas de cargar el CSV).
- Botón Preview → muestra tabla con primeras 100 rows + bloque de errors
  expandible.
- Apply visible solo después de un Preview exitoso con ≥1 row.
- Resultado con counts created/updated + callback `onImported` para que
  el parent refresque la lista de users.
- Separator detectado se muestra al user.

### Tests (+44)

**24 unit tests** del parser (`csv-users.test.ts`):
- Happy paths: comma + semicolon, synonyms, mixed-case headers, only-email,
  quoted-with-separator-inside, doubled-quote escape, BOM, CRLF, blank
  lines, unknown columns tolerated.
- Errors: missing email header, empty CSV, malformed email, empty email,
  invalid role, duplicate emails, line numbers correct.
- Adversarial: header-only, 1000 rows, whitespace trimming, embedded
  semicolons in quoted fields, separator reported back.

**10 integration tests** del endpoint (`csv-import.integration.test.ts`):
- Dry-run no escribe.
- Apply crea + reporta counts.
- Re-running es idempotente (0 created, N updated).
- Per-row errors no abortan el batch.
- 400 sin csv / con non-string.
- 413 con > 2 MB.
- 403 cuando el caller no es admin.
- Line numbers 1-based.
- Preserva provider existente (CSV no sobrescribe 'oidc' → 'csv_import').

**10 UI tests** (`UsersImportCsv.test.tsx`):
- Render inicial (dropzone + textarea, no preview).
- Paste → Preview → tabla con rows.
- Apply → counts + invoca onImported.
- Errors: malformed emails muestran bloque, header faltante hides Apply.
- Guards: Apply oculto cuando rows=0, CSV se preserva entre Preview/Apply.
- Adversarial: separator visible en preview, cap de 100 rows con "+N more".

### Client API

`apps/web/src/api.ts` gana `importUsersCsv(orgId, csv, { dryRun? })` +
`CsvImportResult` exportado. `fakeApi.ts` usa el parser real de
`@diluxite/core` (nueva dep workspace) para fidelidad.

Total: 367/367 verde, +44 tests, 0 regresiones.

## [1.0.0-alpha.26] — 2026-06-01

**Tests súper exhaustivos del flow OIDC end-to-end.** Cubre los huecos que
quedaron en alpha.25 ("se valida con smoke real" — Pablo pidió, con
razón, NO confiar en eso).

Política nueva en `docs/PATTERNS.md` (extensión §9): cada feature trae
unit + integration + adversarial. Cero "later".

### Mock OIDC issuer real (`apps/api/test/oidc-mock-issuer.ts`)

Fastify in-process que firma id_tokens con `jose` y RSA real:
- `GET /.well-known/openid-configuration` — discovery
- `GET /jwks.json` — JWKS público con la good key
- `GET /authorize` — 302 a redirect_uri con code o error según config
- `POST /token` — valida PKCE (S256), genera id_token RS256 firmado
- Config per-test: claims, forgedIssuer, tokenError, authorizeError,
  signWithBadKey.

NO mockea openid-client — la lib usa el endpoint de verdad para discovery,
JWKS fetch y validación de claims. Si la lib upstream cambia, el test
falla.

### Tests E2E (`apps/api/src/oidc-e2e.integration.test.ts`) — +18

**Happy paths (4)**:
- JIT crea brand-new user con claims, set HttpOnly+SameSite cookie.
- Existing user no re-creates (mismo id en login #2).
- `last_login_at` se actualiza en cada login (mide >30ms drift).
- Lowercases el email claim antes de matchear.

**auth_policy enforcement (4)**:
- `deny_unknown` → 403, user NO se crea.
- `pre_provisioned_only` → 403 con mensaje friendly "talk to admin".
- `pre_provisioned_only` + user pre-cargado vía CSV → entra OK, provider
  queda 'csv_import' (no se sobrescribe a 'oidc').
- `allow_unknown_as_member` (default) → JIT 302.

**Soft-disable (1)**:
- `active=false` → IdP autentica pero Diluxite responde 403 "your admin
  disabled this account". Verificado con dos logins separados:
  primero exitoso, despues admin disables, segundo intento rechaza.

**Adversarial (7)**:
- Callback con state desconocido → 400 "unknown or expired".
- Callback sin state param → 400 "missing state".
- IdP returns error=access_denied → 400.
- `id_token` con `iss` forjado (no matchea discovery) → 400.
- `id_token` sin email claim → 400.
- `id_token` con email no-string → 400.
- `id_token` con email sin `@` → 400.

**Token endpoint errors (1)**:
- Token endpoint devuelve `invalid_grant` → 400.

**Ceremony single-use (1)**:
- Replay del callback URL → primer 302, segundo 400 (DELETE-RETURNING
  hace la ceremony single-use).

### Otros cambios

- `oidc.ts`: `buildOidcClient` acepta `DILUXITE_OIDC_ALLOW_INSECURE=1`
  para permitir `http://localhost` en tests/dev (default OFF en prod).
- `test/helpers.ts`: `buildTestApp` ahora retorna también `defaultOrgId`
  y `userId` (necesarios para los tests OIDC).

Total: 323/323 verde, +18 OIDC E2E exhaustivos.

## [1.0.0-alpha.25] — 2026-06-01

**Fase 1.1 — OIDC SSO** funcional (Entra/Okta/Google/Authentik/Auth0).

### Plomería

- `openid-client@6` + `jose@6` agregadas a `apps/api`.
- `apps/api/src/oidc.ts` — helpers `readOidcConfig`, `buildOidcClient`,
  `buildAuthorizeUrl` (state + nonce + PKCE S256), `handleCallback`
  (validate + extract claims).
- Migration `0011`: tabla `oidc_ceremonies` (state PK, nonce,
  code_verifier secret, expires_at TTL 10 min).
- `DrizzleOidcCeremoniesRepository` con save / consume (atomic delete+return
  → single-use replay safety) / sweepExpired.
- `AppDeps.oidc?` opcional con config + client + ceremonies + orgSettings + orgId.
- `services.ts` discover el IdP al boot si env vars completas
  (`DILUXITE_OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI`).
- `Info.oidcEnabled` flag para que el frontend sepa si mostrar "Sign in with SSO".

### Endpoints

`GET /api/auth/oidc/login` (rate-limited 10/min/IP):
  - genera state + nonce + PKCE verifier
  - persiste ceremony
  - 302 al IdP authorize endpoint

`GET /api/auth/oidc/callback` (rate-limited 10/min/IP):
  - consume ceremony (single-use)
  - intercambia código por id_token (con PKCE) y valida vs JWKS
  - extrae email/given_name/family_name del id_token
  - **JIT + policy enforcement** según `org_settings.auth_policy`:
    - `deny_unknown` → 403
    - `pre_provisioned_only` → 403 con mensaje "talk to admin"
    - `allow_unknown_as_member` → crea user con provider='oidc'
  - chequea `users.active` (admin pudo deshabilitarlo)
  - `touchLastLogin`
  - **mintea cookie de sesión LOCAL** (no se pasa el JWT al browser)
  - 302 a `/`

### Frontend

- `LoginScreen.tsx`: fetch `/api/info` al mount, lee `oidcEnabled`. Si
  true, muestra botón "Sign in with SSO" debajo del passkey. Click →
  full-page redirect a `/api/auth/oidc/login` (necesita salir del SPA
  para que el IdP haga su flow con sus cookies).
- `Info` interface gana `oidcEnabled?: boolean`.

### Tests

- `apps/api/src/oidc.integration.test.ts` (+6):
  - save+consume roundtrip de state/nonce/codeVerifier
  - consume single-use (replay refuses)
  - unknown state → null
  - expired ceremony → null (no devuelve aún si tiene expires en pasado)
  - sweepExpired solo borra expirados, retorna count
  - org_settings default a allow_unknown_as_member si no hay row

Total: 305/305 verde.

### Cómo prueba un admin que tiene Okta/Entra

1. Levanta Diluxite en modo `server`.
2. En su IdP crea una "Application" tipo OIDC con redirect URI
   `https://diluxite.acme.com/api/auth/oidc/callback`.
3. Setea env vars en su compose:
   ```
   DILUXITE_AUTH_MODE=server
   DILUXITE_OIDC_ISSUER=https://login.microsoftonline.com/{tenant}/v2.0
   DILUXITE_OIDC_CLIENT_ID=...
   DILUXITE_OIDC_CLIENT_SECRET=...
   DILUXITE_OIDC_REDIRECT_URI=https://diluxite.acme.com/api/auth/oidc/callback
   ```
4. `docker compose up -d`. La login screen muestra "Sign in with SSO".
5. Click → IdP autentica + MFA → callback → JIT crea user en Diluxite (si
   `allow_unknown_as_member`) o lo rechaza (otras policies).

### Próximos pasos (alpha.26+)

- CSV import endpoint + UI (Fase 1.2)
- Settings → Auth tab para cambiar policy desde la UI (Fase 1.3)
- TrustedHeaderAuthProvider (Fase 1.4)
- HTTPS + headers + CSRF (Fase 1.5)
- Wizard installer mejorado

## [1.0.0-alpha.24] — 2026-06-01

**Fase 1.0 — Foundation enterprise-ready auth**. Schema + repos para
poder enchufar OIDC (Okta/Entra/Google/Authentik), CSV import de users,
soft-disable, y políticas de admisión configurables.

### Schema changes (migration 0010)

`users` gana:
- `first_name`, `last_name` (text, nullable). Poblados por CSV import o
  por claims del id_token de OIDC.
- `active` (boolean default true). Soft-disable preservando historial —
  preferido sobre DELETE porque conserva la autoría de las notes.
- `last_login_at` (timestamp nullable). Cheap telemetría para reports de
  "users que no entraron en 90 días" → deprovision.
- 2 índices para queries comunes (`active=false`, `last_login_at`).

`org_settings` nueva tabla:
- `org_id` (PK, FK organizations).
- `auth_policy` (text default 'allow_unknown_as_member'). Tres valores
  válidos enforced por CHECK constraint:
    - `deny_unknown`: rechaza 403 a quien pasa SSO pero no está en users.
    - `allow_unknown_as_member`: JIT-crea con role mínimo (default).
    - `pre_provisioned_only`: rechaza con mensaje friendly "hablá con tu
      admin".

### Tipos / repos

- `User` interface (en `spaces-repository.ts`) ampliada con los 4 campos
  nuevos.
- `DrizzleUsersRepository` agrega:
    - `setActive(userId, active)` — soft-disable.
    - `touchLastLogin(userId)` — llamado por el `AuthProvider.resolve()`
      en cada login exitoso.
    - `createFromExternal({ email, firstName, lastName, provider })` —
      entry point JIT (provider = 'oidc' | 'trusted_header' | …).
    - `upsertFromCsv({ email, firstName?, lastName? })` — idempotente,
      preserva fields existentes cuando el CSV los pasa null. Retorna
      `{ user, outcome: 'created' | 'updated' }` para reportar counts en
      la UI.
- `DrizzleOrgSettingsRepository` nuevo, con `getAuthPolicy(orgId)` (fall-
  back al default si la row no existe) + `setAuthPolicy(orgId, policy)`
  (upsert con `ON CONFLICT DO UPDATE`).

### Tests

- `org-settings.integration.test.ts` (+6): default sparse, roundtrip
  cada policy, idempotencia, overwrite, CHECK constraint a nivel DB.
- `users-enterprise.integration.test.ts` (+8): createFromExternal lower-
  cases email + sets active=true; setActive ida y vuelta; touchLastLogin
  con timestamp +/- 2s clock skew; upsertFromCsv create vs update, null
  fields no overwriten, idempotente con 3 runs.

Total: 299/299 verde. +14 tests Fase 1.0.

### NO incluye (próximos alphas)

- alpha.25: `OidcAuthProvider` + UI login con "Sign in with SSO".
- alpha.26: CSV import endpoint + UI con drag-drop.
- alpha.27: Settings → Auth tab (dropdown de policy).
- alpha.28: `TrustedHeaderAuthProvider` (Cloudflare Access pattern de
  Diluxclaw).
- alpha.29: HTTPS default + security headers + CSRF.
- alpha.30: Wizard installer mejorado (modo local vs server al inicio).

### Aclaración importante

Todo esto **solo aplica a modo `server`**. Modo `local` (Pablo solo en su
PC, default del installer) sigue funcionando con SingleUserAuthProvider
sin login, ignorando `auth_policy` por completo.

## [1.0.0-alpha.23] — 2026-06-01

**UI del Settings → MCP** que faltaba para cerrar el hardening #2.

### Cambios en `SettingsModal → McpTab`

- Nuevo input opcional **"Expires in (days)"** junto al de nombre del
  token. Vacío = sin TTL (legacy). Numérico positivo = se aplica.
- Cada token de la lista ahora muestra su línea inferior:
  `expires: never` | `expires: 12/15/2026` | `expires: expired`.
- Botón **"Revoke all (N)"** danger junto al header de la lista, solo
  visible cuando hay ≥1 token. Abre un `dialogs.confirm` con texto
  claro de las consecuencias y, al aceptar, llama
  `api.revokeAllTokens()` y reload de la lista.
- Cancelar el confirm preserva los tokens (test explícito).

### Tests (`apps/web/src/layout/McpTab.test.tsx`)

6 nuevos:

- TTL input visible junto al nombre.
- Mint sin TTL → "expires: never".
- Mint con TTL=30 → fecha concreta (ni "never" ni "expired").
- Revoke-all hidden con 0 tokens, visible con ≥1.
- Click + accept del confirm vacía la lista.
- Click + cancel preserva.

Total: 285/285 verde, 0 regresiones.

### Hardening status

- ✅ #1 Rate limit auth endpoints (alpha.21)
- ✅ #2 Token TTL + revoke-all (alpha.22 backend + alpha.23 UI)
- ⏳ HTTPS por default (próximo)
- ⏳ CSRF token explícito
- ⏳ Audit log
- ⏳ 2FA TOTP
- ⏳ Invalidar sesiones al cambiar password (gateado: requiere endpoint)

## [1.0.0-alpha.22] — 2026-06-01

Hardening #2: **Token TTL + revoke-all** (panic button). Item #2 del plan
en `docs/SECURITY.md §9`.

### Cambios

- Migration `0009_tokens_expires_at.sql`: nueva columna `expires_at` NULL
  por default (preserva tokens existentes "sin expiración") + partial
  index sobre tokens NO null para barridos rápidos.
- `packages/db/src/schema.ts`: `tokens.expiresAt` agregado al schema.
- `DrizzleTokensRepository.create(userId, name, expiresInDays?)`:
  el tercer arg opcional setea TTL. `null` o ausente → sin expiración
  (backwards-compat con `mintToken` legacy).
- `findUserIdByToken` y `resolveToken` ahora filtran `expires_at IS NULL OR
  expires_at > NOW()`. Tokens expirados dejan de autenticar
  silenciosamente — el cliente recibe el 401 estándar como si el token no
  existiera.
- `DrizzleTokensRepository.revokeAllForUser(userId)`: panic button —
  borra TODOS los tokens del user, retorna el count.
- Nuevo endpoint `POST /api/tokens/revoke-all` → `{ revoked: N }`.
- `POST /api/tokens` acepta `expiresInDays` opcional en el body.
- `TokenInfo` (api.ts) gana campo `expiresAt: string | null`.
- API client (`api.ts` + `fakeApi.ts`) actualizado: `mintToken(name,
  expiresInDays?)` + `revokeAllTokens()`.

### Tests (`apps/api/src/tokens-api.integration.test.ts`)

- `mints with TTL — expired tokens stop authenticating`: mintea con
  `expiresInDays: 7`, fuerza expiry al pasado via SQL, verifica que el
  StoredTokenAuthProvider lo rechaza.
- `mintToken without expiresInDays returns expiresAt: null (legacy
  behaviour)`: backwards-compat explícito.
- `POST /api/tokens/revoke-all wipes every token for the caller`: mintea
  3, panic-revoke, verifica que el endpoint retorna `revoked: 3` y la
  lista queda vacía.

Total: 279/279 verde.

### Frontend NO incluido todavía

La UI del panic button + TTL chooser en Settings → MCP queda para
alpha.23. Por ahora se accede via curl/MCP client.

### Pendiente del hardening plan (orden recomendado)

- HTTPS por default en el installer (Caddy sidecar) — ~3h, requiere
  cambios al installer y al compose template.
- CSRF token explícito (double-submit) — ~2h.
- Audit log table + endpoints — ~3h.
- 2FA TOTP — ~4h.
- Invalidar sesiones al cambiar password — ~1h (gateado: requiere
  endpoint de change-password que aún no existe).

## [1.0.0-alpha.21] — 2026-06-01

Hardening #1 del plan de seguridad: **rate limiting** en los endpoints de
auth. Cubre el primer hueco del top del backlog en `docs/SECURITY.md §9`.

### Cambios

- `apps/api/src/app.ts`: registra `@fastify/rate-limit` con `global: false`
  (opt-in por ruta). `buildApp()` pasa a async porque el `app.register`
  debe completarse ANTES de declarar las rutas con `config.rateLimit`.
- `POST /api/auth/login`: 5 intentos/min/IP. 6º request → 429 con
  `Retry-After`.
- `POST /api/auth/passkey/authenticate-options` y `…/authenticate-verify`:
  10/min/IP cada uno (más laxo porque el flow WebAuthn pide ambos en
  secuencia rápida).
- Identidad del rate limit: `x-forwarded-for` (primera IP) o `req.ip` —
  funciona detrás de proxy real con `trustProxy` configurado, y
  directo cuando es self-host.
- Opt-out: `DILUXITE_RATE_LIMIT_DISABLED=1` salta el register entero.
  El setup global de tests integration lo activa por default para que
  los flood-scenarios sigan funcionando; el test dedicado lo desactiva
  per-test.

### Tests (`apps/api/src/rate-limit.integration.test.ts`)

- `returns 429 after exceeding the per-IP login budget`: 6 requests
  consecutivos al endpoint con misma IP → primeros 5 funcionan
  (404 porque authMode=local), el 6º es 429.
- `429 response includes a Retry-After header`: el cliente puede
  backoff con un valor claro.
- `does NOT rate-limit /health (10 hits in a row, all 200)`: regression
  proof de que el plugin sigue `global: false`. Si alguien lo cambia
  a `global: true` por error, monitoring se rompería silenciosamente —
  este test lo previene.

### Migración para callers de buildApp

`buildApp(deps)` ahora retorna `Promise<FastifyInstance>`. Updated
sites en este commit:
  - `apps/api/src/index.ts`
  - `apps/api/test/helpers.ts`
  - 5 test integration files

Total: 276/276 verde.

### Pendiente del hardening plan

Próximos en cola (alpha.22+):
- Token TTL + revoke-all UI
- HTTPS por default en el installer (Caddy sidecar)
- CSRF token explícito
- Audit log table
- 2FA TOTP
- Invalidar sesiones al cambiar password

## [1.0.0-alpha.20] — 2026-06-01

Cuatro entregables en un release: política de tests, doc de seguridad,
command palette enriquecido, listas grandes con filtro + cap. Todo con
tests obligatorios siguiendo la política nueva.

### docs/PATTERNS.md §9 — "Tests para todo" (política escrita)

Toda PR que toca runtime requiere tests del nivel apropiado (unit /
integration / component / e2e). Tabla por tipo de cambio, anti-patrones
explícitos, regla obligatoria de test de regresión para bugs reportados
por usuarios. Lista los tres tests de regresión vivos (collab WS sync,
TreeRow display-none, ActivityBar single-settings).

### docs/SECURITY.md — nuevo, modelo de seguridad completo

- Modos auth: `local` (SingleUserAuthProvider) vs `server`
  (SessionAuthProvider con cookies HttpOnly+SameSite+Bearer fallback).
- Cuatro capas (identidad → middleware → ACL por workspace → RLS Postgres).
- Org tokens con scopes (read/write/admin) + CHECK XOR.
- MCP usa el mismo `AuthProvider` con Bearer.
- Lo que SÍ protege (8 items) + huecos honestos (9 items con severidad y
  prioridad).
- 7-step hardening plan (rate limit, token TTL, HTTPS default, CSRF,
  audit log, 2FA, invalidation on password change) con estimaciones.
- Diagrama del flow de request → identidad → ACL → RLS.

### Command palette enriquecido (`apps/web/src/shell/TopBar.tsx`)

`>` ahora muestra:

  - New note (default, ya estaba)
  - **New folder** (si parent pasa `onNewFolder`)
  - **New workspace** (si parent pasa `onNewWorkspace`)
  - Open graph (ya estaba)
  - **Connect AI (MCP)** — deep-link a `/settings/connect`
  - **Create API key (MCP)** — deep-link a `/settings/mcp`
  - **Open Admin** — gated: solo aparece si el user tiene rol admin /
    super_admin en alguna org (calculado en `App.tsx` con `orgs.some(...)`)
  - Settings (ya estaba)

Cinco entradas nuevas, todas opcionales para no romper consumers
existentes del componente.

### Listas grandes — filter + cap + overflow hint

Para que `WorkspaceSelector` y `OrgIndicator` aguanten "lista interminable":

- **Filter input** que aparece cuando la lista pasa `FILTER_THRESHOLD = 12`.
  Auto-focus al abrir. Búsqueda case-insensitive por nombre. Se resetea
  al cerrar el dropdown.
- **Render cap** de `RENDER_CAP = 200` items visibles a la vez. Items extra
  se reportan con un hint `+N más — refiná el filtro` (no se cargan al DOM).
- Mensajes de empty state diferenciados: "No workspaces yet" (lista vacía
  global) vs "No matches" (lista no vacía, filtro vacío).

Esto NO es virtualización completa (no usa react-virtuoso). El cap fijo
es suficiente para el rango alpha (≤ 200 items renderizados visibles); si
en uso real un user tiene 500+ workspaces, swap detrás de la misma API.

### Tests nuevos (política tests-para-todo en acción)

- `WorkspaceSelector.test.tsx`: 7 tests cubriendo el small-list (trigger,
  no filter input, pick), large-list (filter visible al threshold, filtro
  case-insensitive, **N=1000 con cap + overflow hint**, filter survives
  N=1000), y bound de performance (mount < 1s contra 1000 items).
- `TopBar.test.tsx`: 2 tests nuevos para los items conditionales del
  command palette (folder/workspace/admin) + negative case (Open Admin
  oculto si no hay rol).
- `App.test.tsx`: actualizado el test del account popover al nuevo flow
  (single "Settings" button → `/settings`, no `/settings/appearance`).

Total: 273/273 verde (+13 tests).

## [1.0.0-alpha.19] — 2026-06-01

**Limpieza del avatar popover** (parte 1 del feedback sobre Settings).

Pablo: "el menu ajustes sigue existiendo raro, es como inaccesible solo
puedo acceder desde algunas opciones del menu de usuario, pero adentro si
dudando si no hay opciones duplicadas".

### Root cause

El popover del avatar (esquina inferior izquierda de la ActivityBar)
mostraba **seis entradas casi idénticas con el mismo ícono ⚙**, una por
cada tab del modal:

  Connect AI (MCP)
  Appearance
  Search preferences
  MCP connection
  Passkeys
  About

Cuando el modal abre, muestra los mismos seis nombres como pestañas de su
sidebar interno → sensación de "duplicado". Además, ningún botón "Settings"
genérico para abrir el modal sin pre-seleccionar tab.

### Fix

`apps/web/src/shell/ActivityBar.tsx`: reemplazar las 6 entradas por **un
único botón "Settings"** que llama a `onSettings()` (sin tab arg). Los
deep-links a tabs específicas siguen vivos en contextos donde tienen
sentido (WelcomePanel con "Connect AI…" y "MCP connection", links del
TopBar, etc.) — no se pierde funcionalidad, solo se desaglomera el
popover.

### Tests

`apps/web/src/shell/ActivityBar.test.tsx`:

  - Verifica que `account-menu` contiene exactamente 1 elemento con texto
    "Settings" (no 6).
  - Negative assertion: los labels viejos (Connect AI, Search preferences,
    MCP connection, Passkeys, About) NO deben aparecer en el popover. Si
    una refactorización futura los reintroduce, el test falla.
  - Click en el botón llama `onSettings()` (no `onAccount(...)`) — abre
    el modal sin pre-seleccionar tab.

### NO incluido (para alpha siguientes)

La reorganización interna del modal (Connect AI / Search / AI embeddings
como sección "Instancia" en lugar de mezclados con preferencias
personales) queda para alpha.20. Necesito la captura `19-28-55.png` que
no llegó al directorio compartido para entender exactamente qué sección
se está viendo "rara".

## [1.0.0-alpha.18] — 2026-06-01

**Fix del Explorer sidebar truncando texto antes de tiempo al redimensionar**
(reportado en uso real).

### Root cause

En `TreeRow.tsx`, las "actions" (los iconos a la derecha de cada fila —
"+ nueva nota acá", "renombrar", "borrar") estaban marcadas con
`opacity-0 group-hover:opacity-100`. **Invisible al ojo, pero seguían
ocupando ancho horizontal**. Eso roba espacio al `<button class="flex-1
truncate">` del label → el label se trunca prematuramente con `…` aunque
el sidebar todavía tenga espacio sobrante.

Es el patrón clásico "CSS dice opacity 0 pero el layout las cuenta como
si estuvieran". Hover → reaparecen → el label se acorta más.

### Fix

`hidden group-hover:flex` en vez de `opacity-0 group-hover:opacity-100`.
Las actions desaparecen del layout cuando no están visibles
(`display: none` → cero ancho), y vuelven a `flex` al hover. El label
ocupa todo el ancho disponible hasta que realmente no entra.

### Test de regresión

`apps/web/src/components/TreeRow.test.tsx` con dos assertions:

- Las actions tienen `hidden group-hover:flex` y NO `opacity-0` — si
  alguien revierte al patrón viejo el test falla.
- El label conserva `flex-1 min-w-0 truncate` (la otra mitad de que el
  truncate funcione bien dentro del flex container).

Política nueva: cualquier fix visual reportado por el user trae test de
regresión obligatorio. Documentado como parte del item "tests para todo"
del backlog (task #34).

## [1.0.0-alpha.17] — 2026-06-01

Hotfix de tres cosas pendientes de alpha.16, todas detectadas por workflows
que estaban en rojo en main:

### Fix del 500 al crear nota (chunks dimension mismatch)

Síntoma reportado: `POST /api/spaces/:id/notes` retornaba **500 Internal
Server Error** con `Failed query: insert into "chunks" ...` y un dump
gigante de embedding values. Causa raíz: el schema original fijó
`chunks.embedding vector(1536)` (la dim de Azure text-embedding-3-large),
pero el embedder Ollama default (mxbai-embed-large) retorna 1024 dims.
Cualquier instalación que arranque con Ollama de entrada o que cambie de
Azure a Ollama rompe el INSERT con "expected 1536 dimensions, not 1024".

Las notas previas del seed inicial (3000+) tienen vectores de 1536 dim y
funcionaban. El bug solo aparecía al crear una nota nueva con el embedder
activo distinto del que generó el seed.

Fix (migration `0008_chunks_vector_any_dim.sql`):

  ALTER TABLE chunks ALTER COLUMN embedding TYPE vector USING embedding::vector;
  DROP INDEX IF EXISTS chunks_embedding_idx;

`vector` sin dimension fija deja a pgvector aceptar embeddings de
cualquier dim. Conserva los 1536 viejos del seed y los 1024 nuevos de
Ollama. El precio: drop del índice HNSW (que requiere dim conocida en
CREATE INDEX). Para volúmenes de alpha (≤100k chunks) la búsqueda
secuencial corre en <100ms, aceptable.

El schema Drizzle (`packages/db/src/schema.ts`) usa ahora un `customType`
`vectorAnyDim` que codifica como `[v1,v2,…]` y decodifica como
`number[]`, sin constraint de dim.

### Typecheck verde (4 Node versions × 4 projects)

- `apps/web/src/components/CodeMirrorEditor.tsx`: el `.map().filter(...)`
  inferia `(PresenceUser | null)[]` y el type predicate del filter no se
  validaba. Reescrito como `for…of` con `users.push(...)` — mismo
  resultado, type-safe sin truco.
- `apps/web/test/render-with-ctx.tsx`: el helper de tests no incluía los
  campos `user` y `collabUrl` que `AppCtx` agregó en alpha.11 / .15.
  Agregados ambos con defaults `null`.

### Lint verde (eslint --max-warnings=0)

- `apps/web/src/components/CodeMirrorEditor.tsx`: eliminé un
  `eslint-disable-next-line react-hooks/exhaustive-deps` que apuntaba a
  una regla NO configurada en este repo. ESLint con `--max-warnings=0`
  trata "rule not found" como error. Reemplazado por comentario humano
  explicando por qué las deps son mínimas (los callbacks viven en refs).

### Sin cambios funcionales en el código existente

- Collab sigue andando igual (Hocuspocus 2.x).
- 260/260 tests verde, sin regresiones.
- Smoke gate sigue activo y verificando.

## [1.0.0-alpha.16] — 2026-06-01

**Security patch del base image** — el workflow `docker-scan.yml` falló
contra alpha.15 por **CVE-2026-6732** en `libxml2` HIGH severity, fixed
upstream en `2.13.9-r1`. La imagen `web` venía con `2.13.9-r0` heredado
del tag `nginx:alpine` que aún no había sido rebuildeado por Docker
oficial con el patch.

### Fix

Agregar `apk upgrade --no-cache` a los Dockerfiles que instalan paquetes
del index Alpine:

- `docker/web.Dockerfile` (base `nginx:alpine`) — antes del `COPY` de
  configs, así el `nginx` package + sus transitive (`libxml2`) suben a
  la última patch version disponible.
- `docker/allinone.Dockerfile` (base `node:24-alpine`) — mismo patrón,
  antes del `apk add nginx supervisor wget`. Garantiza que el `nginx`
  instalado se construye contra los libs ya parchados.
- `docker/api.Dockerfile` queda igual — no instala paquetes de Alpine
  (solo node + pnpm via corepack) y el Trivy scan de api venía
  pasando verde.

Resultado esperado: el job `Trivy scan — web` del workflow
`docker-scan.yml` vuelve a verde. El resto del release pipeline (que
ya venía verde en alpha.15) se mantiene.

### NO hay cambios funcionales

- Collab sigue andando igual (Hocuspocus 2.x).
- Tests 260/260 verde (los Trivy fixes son a nivel imagen, no código).
- Smoke gate sigue funcionando.

## [1.0.0-alpha.15] — 2026-06-01

**Fix del smoke gate** introducido en alpha.14. La imagen alpha.14 estaba
publicada en Docker Hub y funcionaba (sync OK), pero el job `smoke` del
release falló por un bug del script:

  Smoke threw: ERR_MODULE_NOT_FOUND '@hocuspocus/provider'

Causa: el script vivía en `scripts/` raíz del monorepo. Node ESM resuelve
los `import 'bare-name'` contra el directorio del script (`scripts/`), no
contra el cwd. Y `scripts/` no tiene `node_modules` propio — los providers
viven en `apps/api/node_modules`.

### Fix

- Mover `scripts/post-release-smoke.mjs` → `apps/api/scripts/post-release-smoke.mjs`.
  Ahora los `import '@hocuspocus/provider'` resuelven naturalmente contra
  `apps/api/node_modules`.
- Actualizar `.github/workflows/release.yml` para invocar `node
  scripts/post-release-smoke.mjs` con `working-directory: apps/api`.
- Doc reference actualizada en `docs/PATTERNS.md` §8.

### Verificación local antes del push

```
$ cd apps/api && node scripts/post-release-smoke.mjs 1.0.0-alpha.14
✓ postgres ready
✓ app responsive on :35173
✓ note created via REST (id=…)
✅ WS sync verified: client received "smoke seed text"
```

El smoke ahora hace lo que prometía hacer: pullea el tag publicado, lo
levanta en un container, conecta como cliente WS real, verifica que el
sync funcione. Si falla, el GitHub Release queda skipped y el operator
ve el rojo en el workflow.

## [1.0.0-alpha.14] — 2026-06-01

**Plan de pruebas de la collab, completo y honesto.** Después del incidente
de alpha.11 (collab in-process verde / collab WS roto en producción),
cerramos los huecos del proceso de QA en serio.

### Nuevos tests de Capa 3 — REAL WebSocket transport

Bloque `describe('collab integration: REAL WebSocket transport', ...)` en
`apps/api/src/collab.integration.test.ts`. Estos usan `HocuspocusProvider`
real sobre `ws://` (NO `openDirectConnection`), así que ejercitan
exactamente el mismo path que un browser:

- `two real clients see each others edits via WS sync` — regresión core
  del bug que dejó el editor vacío.
- `awareness state propagates between two real WS clients (cursors/users)` —
  cubre presence + cursores remotos, que en alpha.11 también estaban
  silenciosamente rotos por el mismo bug de transport.
- `a real WS client receives an applyServerEdit broadcast in real time` —
  cubre el MCP write path con WS real, no DirectConnection.

Total: 260/260 verde.

### Playwright en CI — `e2e.yml`

Nuevo workflow que en cada PR + push a `main`:

1. Levanta `docker compose up -d --build` (stack completo: db + api + web).
2. Instala chromium en el runner.
3. Corre `apps/web/e2e/collab.spec.ts` que abre dos `BrowserContext` en
   la misma nota y verifica edits sincronizados + chip de presencia.
4. En fallo: dump de logs de cada container + sube el HTML report como
   artifact (retención 7 días).

### Post-release smoke contra Docker Hub — job nuevo en `release.yml`

Después de `build-and-push` y antes de `finalize`, un nuevo job `smoke`:

1. Pulla el tag exacto que acabamos de publicar (`soydiloreto/diluxite:X.Y.Z`).
2. Levanta postgres + el all-in-one container en una red Docker temporal.
3. Espera health checks.
4. Crea una nota vía REST.
5. Abre un `HocuspocusProvider` real contra `/collab` del container.
6. Verifica que el sync inicial recibe el contenido seeded.

Si el smoke falla, **el workflow del release falla**: el operator ve el
rojo y sabe que `:next` (rolling) apunta a una imagen rota antes de que
Watchtower la baje a usuarios. Esto cierra el gap que dejó pasar
alpha.11.

Script standalone: `scripts/post-release-smoke.mjs <version>`. Útil
manualmente: `node scripts/post-release-smoke.mjs 1.0.0-alpha.X`.

### Doc — `docs/PATTERNS.md` §8 (nueva sección)

Regla escrita: tests con `openDirectConnection` NO cuentan como prueba
del transport WS. Cualquier cambio en Hocuspocus version, transport
library, o WS path de `applyServerEdit` requiere actualizar el bloque
`REAL WebSocket transport`. La historia del incidente de alpha.11 queda
documentada como justificación.

## [1.0.0-alpha.13] — 2026-06-01

**Fix del bug "crear nota nueva no aparece sin F5"** (reportado en uso real).
La nota se persistía OK al backend; lo que no andaba era la apertura del tab
en el frontend.

### Root cause

`openNote(id)` lee `notes` de su closure de React (`useCallback` deps
include `notes`, así que la versión usada es la del último render). En el
flow de `createNote()`:

```ts
const n = await api.createNote(...);
await refresh(spaceId);    // schedules setNotes(...) — React batched
openNote(n.id);             // ejecuta YA, notes en su closure es el viejo
                            // → notes.find(id) → undefined → tab NO se abre
```

El sidebar SÍ reflejaba la nota (consume `notes` del context que se actualiza
en el re-render siguiente), pero el tab quedaba sin abrir. Refrescar la
página (F5) re-hidrataba todo el state desde `/api/info` + listNotes, y el
tab se abría desde la ruta.

### Fix

- `openNote(id, noteHint?: Note)`: parámetro opcional para pasar la nota
  directamente y saltear el `notes.find()` cuando ya tenemos la referencia
  fresh (caso de `createNote`).
- `createNote()` y `openByTitle()`: hacen **optimistic insert** en `notes`
  antes de llamar `openNote(n.id, n)`. El `refresh(spaceId)` que reconcilia
  con el server pasa a ser fire-and-forget (`void refresh(...)`) porque no
  necesitamos esperarlo.

### Otros cambios

Ninguno. Hotfix focal.

## [1.0.0-alpha.12] — 2026-06-01

**Hotfix crítico de la collab que NO andaba en alpha.11.** Diagnosticado en
vivo: el editor quedaba vacío después de abrir cualquier nota (preview sí
mostraba el texto). Síntoma técnico: el WebSocket del cliente se conectaba
al `/collab`, pero el sync inicial nunca llegaba — el server aceptaba el
upgrade y no enviaba el state. Era el bug de Hocuspocus 4.x con `crossws`
que ya había mordido en los tests de Sprint 1 (donde lo evité usando
`openDirectConnection`); en producción, contra clientes reales, simplemente
no funciona.

### Fix

- Downgrade `@hocuspocus/server` y `@hocuspocus/provider` de `^4.1.0` a
  `2.15.3` — la última versión que usa la library `ws` directo, sin
  `crossws`. Cambio de API menor: `new Hocuspocus()` + `.configure({...})`
  + `.listen(port)` en vez de `new Server({...})` + `.listen()` con
  `configuration.port` manual.
- Quitamos el hook `onAuthenticate` del server. En Hocuspocus 2.x, tenerlo
  registrado activa `requiresAuthentication: true`, que rechaza cualquier
  cliente sin `token` explícito en el query string. Nuestros clientes
  browser identifican por session cookie (que viaja en el handshake
  automáticamente como header). Movimos la auth resolve a
  `onLoadDocument`, que tiene acceso a los `requestHeaders` igual y NO
  está gated por el "must have token" del handshake.
- Tests: agregado `REAL WebSocket sync` integration test que abre un
  HocuspocusProvider real contra un Hocuspocus 2.x con `ws://`, verifica
  que el sync inicial completa y el yText recibe el contenido seeded.
  Esto es la regresión-proof para no volver a embarrarme con la versión
  de `@hocuspocus/server` en el futuro.

### Tests

257/257 verde (+1 regression test del WS real).

## [1.0.0-alpha.11] — 2026-06-01

Sigue alpha. Trae la edición colaborativa real-time (Yjs + Hocuspocus),
seis sprints de trabajo agregados en una sola línea de desarrollo
(`feature/yjs-collab`), mergeados acá. Mantenemos el tier `alpha` porque
el feature acaba de aterrizar y queremos seguir iterando con libertad
de breaking changes en superficies internas. Saltar a `beta` se hará
cuando el motor decante un par de releases sin sorpresas.

### Edición colaborativa (Yjs + Hocuspocus)

- **Motor**: `Y.Doc` por nota, `Y.Text` como source-of-truth durante una
  sesión activa. Hocuspocus 4.1 sirve documents por WebSocket (puerto
  3031). Persistencia en `notes.yjs_state bytea` con `yjs_updated_at`;
  cuando nadie está editando, derivamos markdown a `notes.content_md`
  para que MCP / search / export sigan viendo el mismo texto.
- **Editor**: migrado Monaco → **CodeMirror 6** + `y-codemirror.next` +
  awareness. El bundle de producción bajó de 4.5 MB a 1.4 MB (−3 MB raw,
  −746 KB gzip). Carets remotos con nombre + color renderizados por el
  binding sin código extra.
- **Presence**: chip de avatares en el header de cada nota — iniciales,
  color determinístico por user identity (hash FNV-1a → HSL), self
  marcado con (vos) y opacidad reducida, overflow `+N`.
- **Live broadcast desde MCP**: `applyServerEdit` detecta si la nota tiene
  un Y.Doc cargado y abre una `openDirectConnection` para que la
  mutación aparezca en vivo en los clientes conectados. Sin live doc,
  fallback al path DB tradicional. Cubierto por integration test.
- **No offline edits** (decisión de producto): cuando el WS se cae,
  `editable` se reconfigura a `false` y aparece banner rojo
  "🔴 Desconectado…". Reconnect automático con backoff exponencial del
  provider. Si la sesión expira, banner distinto "🔒 Tu sesión
  expiró…" con instrucción de refrescar.
- **Runtime config**: `/api/info` retorna `collabUrl` (default `/collab`;
  null si `DILUXITE_COLLAB_DISABLED=1`; override absoluto con
  `DILUXITE_COLLAB_PUBLIC_URL`). El frontend no requiere env vars de
  build — la misma imagen del web sirve para collab on/off.
- **nginx routing**: location `/collab` agregado a `nginx.allinone.conf`
  y `nginx.conf` (modo sibling), con headers Upgrade + read_timeout 1d
  para no romper awareness pings idle.
- **GC**: confiamos en Yjs nativo (`gc: true` default + snapshot encode
  en cada save). Documentado en `collab.ts`.

### Tooling

- **Batch migration CLI** (`apps/api/src/migrate-yjs-cli.ts`):
  idempotente, seedea `yjs_state` para todas las notas legacy con
  `content_md` no nulo. Útil después de upgrade desde `alpha.x`. Lazy
  seed en `onLoadDocument` ya las cubre on-demand también.
- **Playwright E2E** (`apps/web/e2e/collab.spec.ts`): suite chromium
  multi-context — texto tipeado en context A aparece en context B + chip
  de presencia. NO corre en CI todavía (browsers + stack arriba), local
  con `pnpm --filter @diluxite/web e2e`.
- **Opt-out**: `DILUXITE_COLLAB_DISABLED=1` skipea el listener de :3031
  + retorna `collabUrl: null` en `/api/info`. Para single-user installs
  o entornos con puerto ocupado.

### Tests

256/256 verde entre core + db + api integration + web unit. +18 tests
nuevos para collab (9 unit + 5 integration + 4 components + auxiliares).

### Breaking changes

- **No hay**. Notas existentes hidratán desde `content_md` automáticamente
  al primer open colaborativo. El editor cambia visualmente (CM6 en vez
  de Monaco) pero el contrato externo (markdown source) es idéntico.

### Migración

```bash
# Después de pullear la imagen 1.0.0-beta.0:
docker compose pull && docker compose up -d
# Opcional, pero recomendado para evitar lazy seeds:
docker exec -it diluxite-api pnpm exec tsx /app/apps/api/src/migrate-yjs-cli.ts
```

## [1.0.0-alpha.10] — 2026-06-01

Cierra el bug de "crear nota tarda 5 segundos". Era cold-start de Ollama: el
provider por default descarga el modelo de RAM tras 5 min idle, así que la
primera nota después de cualquier pausa pagaba la carga completa del modelo
(3-5s para `mxbai-embed-large`). El patrón de uso de Diluxite (sesiones cortas
intermitentes a lo largo del día) caía justo en este peor caso.

### Fix

- `OllamaEmbeddingProvider` ahora envía `keep_alive: '24h'` en cada request
  (configurable via `keepAlive` opt). Ollama mantiene el modelo cargado entre
  llamadas, eliminando el cold-start. Costo: ~600 MB de RAM constantes en el
  proceso Ollama (aceptable en cualquier máquina con ≥4 GB).
- Tests unitarios para el default `'24h'` y para override custom (`'-1'` =
  forever, `'5m'` = comportamiento legacy).

## [1.0.0-alpha.9] — 2026-06-01

Cierra otro engaña-pichanga: el "auto-update via Watchtower" que el README prometía
NO funcionaba — el installer pinneaba la imagen a la versión exacta (`:1.0.0-alpha.X`),
así que aunque levantaras Watchtower con `--profile autoupdate`, no actualizaba nada
(los tags pin no reciben rolling updates). Ahora el installer pregunta de entrada y
configura el compose en consecuencia.

### Installer — nuevo Step 6 / 9: Auto-update
- Default **Yes** (opt-out), filosofía "siempre al día". El user puede responder `N`
  si prefiere reproducibilidad estricta.
- **Auto-update ON**: el compose usa el tag rolling (`:next` o `:latest` según el
  channel del Step 5) y levanta Watchtower como servicio default. Watchtower revisa
  cada 6 h y reconcilia. Sin acción del user.
- **Auto-update OFF**: el compose pinea la versión exacta (ej. `1.0.0-alpha.9`) y
  deja Watchtower detrás del profile `autoupdate` (opt-in via `docker compose
  --profile autoupdate up -d`). El banner amarillo en la UI avisa cuando hay nueva.
- Mensajes en EN/ES/PT.
- Resumen final del installer ahora muestra "Auto-update: ON / OFF" y los comandos
  útiles cambian según la elección (oculta el `--profile autoupdate` cuando ya está
  ON, agrega "forzar update ahora" en su lugar).

### Compose template
- Nuevo placeholder `__WATCHTOWER_PROFILES__` que el installer reemplaza por vacío
  (Watchtower siempre arriba) o por `    profiles: ["autoupdate"]` (opt-in legacy).
- Comentarios actualizados.

### Renumeración de steps
- Todos los pasos van ahora `X / 9` (antes había inconsistencia: pasos 1-5 decían
  `/ 7`, pasos 6-8 decían `/ 8`, sin contar server mode). Ahora siempre `/ 9`.
- Step 6 = nuevo Auto-update. Step 7 = Mode (antes 6/8). Step 8 = Generating
  (antes 7/8). Step 9 = Starting (antes 8/8).

### README
- Sección "Actualizar" reescrita: documenta los dos flows según la elección del
  installer, en vez de presentar solo el opt-in manual.

[1.0.0-alpha.9]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.9

## [1.0.0-alpha.8] — 2026-05-31

Cierre del invariante "local = single-tenant" + UI de creación de organizaciones en server mode.

### Backend — mode guards (no engaña-pichanga)
- `POST /api/organizations` y `DELETE /api/organizations/:orgId` ahora devuelven `403 { error: 'organization creation/deletion requires server mode' }` cuando `deps.info?.authMode !== 'server'`. El guard corre **antes** de validar el body (no hay leakage del modo vía mensajes de error distintos).
- `POST /api/organizations/:orgId/tokens` y `DELETE /api/organizations/:orgId/tokens/:id` reciben el mismo trato (`org tokens require server mode`). En local mode, las API keys personales (`/api/api-keys`) ya cubren el caso single-user; los org tokens serían redundantes. `GET` queda abierto (read-only, útil para inspección).
- **Fail-closed**: si `deps.info` viene undefined, los 4 endpoints también devuelven 403. Mejor refusar que permitir silenciosamente.
- Nuevo test suite `auth-mode-org-guards.integration.test.ts` con 11 casos (local rechaza, server permite, info missing rechaza, org tokens guard).

### Backend — `/api/info` ya expone authMode + version real
- Ya venía propagándose vía `{ ...base }` desde `services.ts`; ahora el cliente lo consume.
- **Bug pre-existente arreglado**: `services.ts` hardcodeaba `version: '4.1.0-alpha.0'` (drift de varias alphas atrás). Ahora se lee del `apps/api/package.json` vía `import pkg from '../package.json' with { type: 'json' }` — `/api/info.version` siempre matchea lo deployado.

### Frontend — UX que refleja el modo
- `Info` interface (cliente API) + `AppCtx` + `App.tsx` boot leen `authMode: 'local' | 'server'`.
- `OrganizationTab`: la "Danger zone" se sigue mostrando para super_admins, pero el botón "Delete organization" queda **disabled + tooltip "Requires server mode"** en local, con nota explicativa debajo. La UI nunca sobrepasa lo que la API permite.
- `OrgTokensTab`: en local mode oculta el form de mint y muestra una nota que dirige al user a las API keys personales de Settings → MCP connection. Los listings + revoke quedan visibles si hubiera tokens legacy.
- `OrgIndicator`: en server mode el dropdown se abre incluso con 1 sola org y muestra footer "+ New organization". El nuevo flow `createOrgFlow` en `App.tsx` usa `useDialogs.prompt`, llama a `api.createOrganization`, refresca y switchea a la org recién creada.
- `fakeApi` ahora respeta el modo (default `local`, opt-in `{ authMode: 'server' }`) — los métodos multi-tenant (`createOrganization`, `deleteOrganization`, `mintOrgToken`, `revokeOrgToken`) throwean `HTTP 403` en local, simulando el backend real. Evita que un dev nuevo lea el mock como "siempre permitido" y arme flows que la API real rechazaría.

### Installer — Ollama install robusto en macOS
- El installer oficial de Ollama termina con `open -a Ollama`, que falla con "Unable to find application named 'Ollama'" cuando LaunchServices no indexó la app recién copiada. El installer de Diluxite ahora tolera ese exit non-zero en macOS y agrega `ensure_ollama_running` con reintentos antes del primer `ollama pull` (también cubre "Ollama instalado pero daemon apagado").

### Testing
- 3 unit tests para `OrganizationTab` (local disabled, server enabled, non super_admin no danger zone).
- 5 unit tests para `OrgIndicator` (local 1 org, local N orgs, server 1 org, server N orgs, sin onCreate prop).
- 1 unit test para `OrgTokensTab` en local mode (mint form oculto + nota visible).
- 11 integration tests para los mode guards de `/api/organizations` + `/tokens` (local + server + fail-closed). Cobertura local: 13 files / 90 tests verdes contra Postgres real, cero regresiones.

[1.0.0-alpha.8]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.8

## [1.0.0-alpha.7] — 2026-06-01

Release con las 7 fases del plan integrado: tokens org + login UI + installer modo + passkeys end-to-end.

### Tokens org (Fase 5 + 6)
- `tokens.user_id` ahora nullable + nuevo `tokens.org_id` + `scopes text[]` (migración 0005) con CHECK XOR.
- Endpoints `POST/GET/DELETE /api/organizations/:id/tokens` (require admin/super_admin), valida scopes (`read`|`write`|`admin`|`space:<id>`|`org:<id>`).
- `DrizzleTokensRepository`: `createOrgToken / listForOrg / revokeOrgToken / resolveToken`. `findUserIdByToken` ahora filtra a tokens con `user_id NOT NULL` (la auth legacy ignora los org tokens automáticamente).
- UI nuevo `OrgTokensTab` en Admin Console con badges de scope + revoke; `'My API keys'` (api-keys, miembro+) y `'Org tokens'` (org-tokens, admin+) separados en la sidebar.

### Login UI (Fase 7)
- `LoginScreen` (full-page email + password) + `AppGate` wrapper en `main.tsx` que probea `/api/info` al boot. Local mode lo atraviesa; server mode sin session → muestra login antes que cualquier otra cosa.
- `ApiClient.login / logout`.

### Installer modo local/server (Fase 8)
- `install.sh` paso 6/8 nuevo: elige modo local (passwordless) o server. Si server, pide email + password con validación (formato email, mínimo 8 chars, match de confirmación) y los inyecta como env vars `DILUXITE_AUTH_MODE` + `DILUXITE_ADMIN_EMAIL` + `DILUXITE_ADMIN_PASSWORD` al compose generado.
- `bootstrapServerAdmin` en `services.ts` aplica los env vars en el primer boot (idempotente, solo si `password_hash` está NULL).
- 3 idiomas (EN/ES/PT) cubiertos.

### Passkeys / WebAuthn (Fase 9 + 10)
- Schema (migración 0006): `passkeys` (credential_id, public_key, counter, device_type, label, transports, backed_up, last_used_at) + `webauthn_challenges` (transient state con TTL).
- `DrizzlePasskeysRepository` + `apps/api/src/passkey-routes.ts` con las 4 ceremonias estándar (`register-options/verify`, `authenticate-options/verify`) usando `@simplewebauthn/server`. Usernameless authentication: el user se resuelve desde el `credentialId` en verify, no se pide email upfront.
- RP_ID / RP_ORIGIN configurables vía env. Defaults `localhost`+`http://localhost:5173` para dev.
- Solo server mode; local mode devuelve 404 limpio.
- `GET /api/passkeys` + `DELETE /api/passkeys/:id` para gestión desde la UI.
- UI: `PasskeysTab` en Settings (Add this device + lista + revoke) + botón "Sign in with a passkey" en `LoginScreen`.
- Dependencias: `@simplewebauthn/server` (api) y `@simplewebauthn/browser` (web, import dinámico).

### Bugs (Fase 1.b)
- Delete organization ya no deja la UI con `currentOrgId` apuntando a una org borrada: `refreshOrgs` reconcilia automático y switchea a la siguiente disponible.
- Switch org: confirmado que no es bug — el dropdown solo se abre con ≥2 orgs (intentado).

### Testing
- Tests por fase con TDD: `OrgTokensTab.test`, `LoginScreen.test`, `AppGate.test`. Total 124 tests / 21 test files en unit (web+core). Backend integration en CI con `pgvector/pgvector:pg17` service container.

[1.0.0-alpha.7]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.7

## [1.0.0-alpha.6] — 2026-05-31

### Fixes
- **Delete organization** ya no deja la UI en estado fantasma: cuando borrás la org activa, `refreshOrgs` reconcilia automático y switcha a la primera disponible (o limpia `localStorage` si no quedan).

### Auth — scaffolding del modo `server` (backend listo, UI login en próximo release)
- Nuevo schema: `users.password_hash` (PBKDF2-SHA512, OWASP 210k iter) + tabla `sessions` (opaque tokens, SHA-256 hash, TTL 30d).
- Nuevo schema en `tokens`: `user_id` ahora nullable + `org_id` + `scopes text[]` + CHECK XOR (un token pertenece a un user **o** una org, no ambos). Migrations 0004 + 0005.
- `@diluxite/core`: `hashPassword` / `verifyPassword`, `SessionAuthProvider` (cookie session + Bearer fallback), `PasswordStore` / `SessionStore` interfaces.
- `services.ts`: lee `DILUXITE_AUTH_MODE` (default `local`). En `server`, bootstrapea el admin desde `DILUXITE_ADMIN_EMAIL` + `DILUXITE_ADMIN_PASSWORD` env vars (idempotente).
- `apps/api`: `POST /api/auth/login` y `POST /api/auth/logout` (HttpOnly cookie, SameSite=Lax). 404 limpio en local mode.

### UI
- **Settings movido al menú del avatar**: Connect AI, Appearance, Search preferences, MCP connection, About. El cogwheel separado del Activity Bar se eliminó.
- **AI / Embeddings → Admin Console**: nueva sección `Admin > AI / Embeddings` con el provider activo + env vars para cambiarlo (instance-wide, requiere restart + reindex).
- **Workspace selector movido a la derecha** al lado del OrgIndicator: la jerarquía "workspace → org" se lee de un vistazo.

### Pendiente para `v1.0.0-alpha.7`
- Pantalla de login del modo `server` (UI).
- Endpoints + UI para tokens a nivel org (Fase 2.b — el schema ya está listo).
- Passkeys / WebAuthn en `server` mode (Fase 4).

[1.0.0-alpha.6]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.6

## [1.0.0-alpha.5] — 2026-05-31

### Security — bundled npm purgado de las imágenes runtime

Trivy seguía marcando 12 HIGH CVEs después del bump de esbuild (alpha.4): no eran del código de Diluxite ni de sus deps directas, sino del **npm que viene bundled con `node:24-alpine`** (vendored copies viejas de `glob`, `minimatch`, `tar`, y el propio `pnpm`). Mis overrides de pnpm no afectan ese tree (vive en `/usr/local/lib/node_modules/npm/`, fuera del workspace).

Fix definitivo en una capa Docker:

```dockerfile
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx
```

Solo aplica a `docker/api.Dockerfile` y `docker/allinone.Dockerfile` runtime stages (web.Dockerfile runtime es `nginx:alpine`, sin Node). Diluxite no usa npm — usa pnpm via corepack — así que el comando `pnpm exec tsx` sigue funcionando.

Plus: pnpm bumpeado de 9.15.9 a 10.27.0 (cierra CVE-2025-69262 RCE y CVE-2025-69263 lockfile bypass). Override de `glob`, `minimatch`, `tar` en `package.json` para forzar las latest en cualquier dep transitiva del workspace.

[1.0.0-alpha.5]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.5

## [1.0.0-alpha.4] — 2026-05-31

### Security

- Bump `esbuild` 0.25.12 → **0.28.0** via pnpm `overrides` para cerrar 4 CVEs HIGH/CRITICAL del runtime Go con el que esbuild estaba compilado (CVE-2026-42499, CVE-2026-39836, CVE-2026-39826, CVE-2026-39825). esbuild llega como dep transitiva de vite/tsx/vitest — el override fuerza la versión en todo el árbol.

[1.0.0-alpha.4]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.4

## [1.0.0-alpha.3] — 2026-05-31

### Dependencies — bump TODO a latest (8 majors)

- **typescript** 5.9.3 → 6.0.3
- **vite** 7.3.3 → 8.0.14 + **@vitejs/plugin-react** 4 → 6
- **vitest** 3.2.4 → 4.1.7 + **jsdom** 25 → 29
- **marked** 14 → 18 · **zod** 3 → 4
- **tailwindcss** 3.4.19 → **4.3.0** (+ nuevo `@tailwindcss/postcss`; `postcss.config.js` reescrito; `styles.css` usa `@import "tailwindcss"` + `@config` para preservar `tailwind.config.ts` sin migrar a CSS-first)
- **@types/node** 22 → 25
- Patches: eslint, tsx, lucide-react, drizzle-kit

`tsconfig.base.json` actualizado: `lib` ES2022 → ES2023 + `types: ["node"]` (vitest 4 dejó de inyectar tipos Node implícitamente). Cero cambios visuales en la UI. `pnpm outdated -r` ahora devuelve vacío.

[1.0.0-alpha.3]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.3

## [1.0.0-alpha.2] — 2026-05-31

### Installer fixes (3)

- **Healthcheck**: el installer pegaba a `/api/health` (no existe) y `:3030/health` (puerto no expuesto en el compose all-in-one). Ahora chequea `/api/update/check` vía nginx en `:5173`, que ES la señal canónica de "API + nginx + ruteo OK".
- **`pnpm seed` en el container**: el script usaba `--env-file=.env` (REQUIRED), y `.env` no existe en la imagen → tsx fallaba. Cambiado a `--env-file-if-exists=.env` (env vars del container ya alcanzan vía `process.env`; `.env` solo aplica para dev local).
- **`scripts/` faltaban en la imagen all-in-one**: `docker compose exec diluxite pnpm seed` no encontraba `scripts/seed-demo.ts`. Agregado `COPY scripts scripts` en `docker/allinone.Dockerfile`.

[1.0.0-alpha.2]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.2

## [1.0.0-alpha.1] — 2026-05-31

### Distribution

- **Imagen all-in-one publicada**: `soydiloreto/diluxite` (api + nginx + web estática en un container vía supervisord). El installer default usa esta — un solo container app + Postgres. Las imágenes separadas `soydiloreto/diluxite-api` y `soydiloreto/diluxite-web` se mantienen para escalado (Cloud, orgs grandes).
- **Installer unificado** (`install.sh` único): soporta Linux / macOS / WSL2 / Git Bash en Windows. Eliminado `install.ps1`. En Windows el user lo corre desde WSL2 o Git Bash.
- **Docker missing → browser + abort**: el installer abre la página oficial de descarga en el browser del user (xdg-open / open / cmd.exe) y aborta sin intentar instalar Docker silently.
- **Ollama auto-install**: si elegís Ollama y no lo tenés, el installer te ofrece `curl ollama.com/install.sh | sh` con confirmación (default Y). En Windows nativo abre la página de descarga.
- **README de Docker Hub automatizado**: cada release pushea el README correspondiente (`docker/hub-readme-{allinone,api,web}.md`) a cada repo en Docker Hub vía la API (peter-evans/dockerhub-description). Solo en releases estables — los pre-releases no churnean la página pública.
- **`release.yml` matrix expandida**: ahora buildea las 3 imágenes en paralelo (`allinone`, `api`, `web`) con `matrix.include` que mapea cada una a su Dockerfile + Docker Hub repo + README.
- **`docker-scan.yml`**: Trivy scan también cubre las 3 imágenes.

[1.0.0-alpha.1]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.1

## [1.0.0-alpha.0] — 2026-05-31

First public alpha. Diluxite es la memoria de tu IA: notas Markdown + búsqueda híbrida (FTS español + pgvector) + servidor MCP nativo. Distribuido por Docker Hub (`soydiloreto/diluxite-api` + `soydiloreto/diluxite-web`, multi-arch amd64/arm64). Edición Core (este repo) open-source AGPL-3.0; edición Cloud privada hostea el mismo motor multi-tenant.

### Distribución y onboarding

- Imágenes en Docker Hub publicadas por release.yml al taggear `vX.Y.Z` (estable) o `vX.Y.Z-(alpha|beta|rc|dev)[.N]` (pre-release). Estable tagea `:X.Y.Z + :X.Y + :latest`; pre-release tagea `:X.Y.Z + :next`.
- Installer `install.sh` (Linux / macOS / WSL2) e `install.ps1` (Windows + Docker Desktop): detecta plataforma, valida pre-requisitos (Docker daemon, Compose v2, puertos libres, ≥ 3 GB), pregunta dónde guardar los datos (bind-mount), qué embedder usar (Ollama local con `mxbai-embed-large:335m` recomendado, Azure OpenAI o determinista), y si querés arrancar con vault vacío o seed demo de 1500 notas. Pulla las imágenes, levanta el stack, hace el seed si corresponde.
- `docker-compose.template.yml` con placeholders + profile opt-in `autoupdate` (Watchtower con `--label-enable`, poll 6 h, TZ Buenos Aires).
- `UpdateBanner` en la web: polling de `/api/update/check` (compara versión local vs la última GitHub Release del repo); endpoint `GET /api/update/check` en la API. Sin exponer Docker socket — el banner muestra el comando, el usuario lo ejecuta.

### CI / CD blindados

- Workflows separados estilo `wpm-user-sync` / `dilux-cloud-storage`: `lint.yml`, `typecheck.yml` (matrix Node 20/22/24), `tests-unit.yml` (matrix), `tests-integration.yml` (con `pgvector/pgvector:pg17` service), `version-alignment.yml` (los 5 `package.json` + entrada literal en CHANGELOG).
- Seguridad en 3 capas: `codeql.yml` (TS, `security-extended`, weekly Lunes), `security-audit.yml` (pnpm audit --prod --audit-level=high, weekly Martes), `docker-scan.yml` (Trivy contra ambas imágenes con `severity HIGH,CRITICAL`, `ignore-unfixed`, weekly Miércoles).
- `release.yml`: validación STRICT del tag (rechaza `1.0.0`, `v1.10`, `v1.0.0+meta`), verifica que los 5 `package.json` matcheen el tag, verifica entrada `## [X.Y.Z]` en CHANGELOG, build multi-arch con `docker/build-push-action` + GHA cache, push a Docker Hub, GitHub Release con `prerelease` auto-detectado.
- `.github/copilot-instructions.md` con arquitectura completa, modelo de datos, pipeline de búsqueda, anti-patrones y prioridades de review (Copilot Code Review usa este archivo automáticamente).
- `.github/dependabot.yml` con grouping (npm prod + dev separados, github-actions, docker base images), weekly Buenos Aires.
- `CODEOWNERS`, PR template, issue templates.
- Branch protection en `main` con 4 required status checks + `required_conversation_resolution`.

### Motor

- **Embeddings pluggable** (`packages/core/src/providers.ts`): `DeterministicEmbeddingProvider` (default OSS), `OllamaEmbeddingProvider` (local, sin claves, sin nube, `/api/embed` batch), `AzureOpenAIEmbeddingProvider`. `pickEmbedder()` en `apps/api/src/services.ts` con prioridad Azure > Ollama > determinista por env.
- **Pipeline de búsqueda**: tags + wikilinks + chunking heading-aware (512 / overlap 64) + `EmbeddingProvider.embed` + RRF (k=60) + reranker pluggable (`IdentityReranker` en Core, Cohere/cross-encoder en Cloud).
- **MCP server** Streamable HTTP, stateful por `Mcp-Session-Id`, 10 tools: `search_memory`, `list_notes`, `read_note`, `write_note`, `list_spaces`, `list_tags`, `search_by_tag`, `recent_notes`, `backlinks_of`, `append_to_note`.
- **Multi-tenant**: organizations + spaces + memberships; cross-tenant isolation por `space_id` en cada query.
- **Frontend**: React 19 + Vite 7 + Tailwind + Dockview + Monaco + cmdk + lucide. Shell estilo VS Code (Activity Bar + Sidebar + Dockview + Status Bar). Cmd/Ctrl+K Quick Switcher. Editor con Neighbors panel (outlinks + backlinks + suggested vía pgvector) y splitters movibles persistidos en prefs.

### Seguridad

- Bump `drizzle-orm` de 0.38.4 a 0.45.2 — resuelve SQL injection [GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9).

[Unreleased]: https://github.com/soydiloreto/diluxite-core-alpha/compare/v1.0.0-alpha.0...HEAD
[1.0.0-alpha.0]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.0
