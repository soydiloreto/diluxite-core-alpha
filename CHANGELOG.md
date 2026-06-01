# Changelog

All notable changes to Diluxite Core are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
