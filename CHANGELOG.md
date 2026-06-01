# Changelog

All notable changes to Diluxite Core are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
