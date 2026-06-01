# Diluxite — Roadmap

Lista viva del proyecto. Lo que cierra acá se mueve al `CHANGELOG` del commit
correspondiente. Convertir fechas relativas a absolutas.

## Estado actual (2026-06-01, v1.0.0-alpha.10 + rama `feature/yjs-collab`)

- **Core OSS (este repo)**: API + MCP + Web UI funcionando contra
  `v1.0.0-alpha.10` en Docker Hub. Tres modos: `local` (single-user
  passwordless `local@diluxite`) y `server` (email+password + sessions
  + passkeys WebAuthn opcionales).
- **Stack runtime**: Node 24, pnpm 9, TypeScript 6, Fastify 5, Drizzle 0.45,
  Postgres 17 + pgvector, React 19, Vite 8, Tailwind 4. **CodeMirror 6** (no
  Monaco) como editor — migrado en `feature/yjs-collab` para soportar collab.
- **Multi-tenant**: shared-schema + tenant column + RLS (`SET LOCAL
  app.current_user_id`). Org tokens scoped (read/write/admin), passkeys por
  usuario.
- **Collab (en rama `feature/yjs-collab`, pendiente de merge)**: Yjs +
  Hocuspocus, awareness con cursores remotos + avatares de presencia,
  read-only banner en disconnect, live broadcast desde MCP, runtime config
  via `/api/info`. Sin offline edits (decisión de producto).
- **Tests**: 256/256 verdes entre core + db + api integration + web unit.
  E2E Playwright multi-context escrito, pendiente de correr en CI.

## Próximas iteraciones

### v1.0.0-alpha.11+ — collab + polish dentro de alpha
- `alpha.11` (este release): merge de `feature/yjs-collab` → Yjs +
  Hocuspocus + CodeMirror 6 + awareness + cursores + presence + read-only
  banner + live MCP broadcast + runtime config + migration CLI.
- Releases siguientes en `alpha.N` mientras el motor decanta. Bugs reales
  reportados por uso → fix → bump.
- Salto a `beta` cuando dos releases consecutivas no rompan nada
  reportable. El contador del tier resetea a 0 (convención Vue/Vite/
  Drizzle): `beta.0 > alpha.999` por orden de tier.

### v1.0.x — polish post-beta
- Playwright CI: instalar browsers en el GitHub Actions runner y correr
  `e2e:` en cada PR.
- Documentación final: `ARCHITECTURE.md` + `RUNBOOK.md` + `MULTI-TENANT.md`
  refrescados (siguen referenciando v4.0.0-alpha pre-reset).
- Atender los 8 Dependabot moderates pendientes.
- Notificaciones reales (🔔 abre popover vacío hoy).
- Scope selector en TopBar (filtrar por workspace).
- Tabla `activity_log` para que el Timeline muestre eventos reales (no
  derivados de `notes.{createdAt,updatedAt}`).

### v1.1 — Kubernetes
- Manifests YAML crudos (Deployment + Service + Ingress + Secret + ConfigMap)
  validados en `kind` localmente.
- Postgres → Azure DB Flexible Server (out-of-cluster).
- Embeddings → Azure OpenAI (no Ollama en cluster).
- Auth: server mode obligatorio (no `local`).
- Sticky sessions para WebSocket (Hocuspocus state vive en pod, no en Redis
  todavía).

### v1.2 — cloud-hosted (privado, fuera de este repo)
- `soydiloreto/diluxite-cloud` repo aparte (AGPL → comercial).
- Entra ID (Google + Microsoft) para login.
- Multi-tenant production con RLS ya probado.
- Billing stub + dashboard de cuotas.
- AKS + Azure Front Door.

## Decisiones tomadas (ADR mini)

- **Open-core**: motor y UI AGPL-3.0. Cloud (multi-tenant, billing, Entra)
  queda privado.
- **Stack web**: `dockview-react` (tabs/splits), **CodeMirror 6** + `y-codemirror.next`
  (editor + collab binding), `cmdk` (palette), `lucide-react` (iconos).
  Monaco se descartó al meter collab — el binding `y-monaco` es flaky y CM6
  baja el bundle 3 MB.
- **MCP transport**: Streamable HTTP con sesión por usuario; identidad
  derivada del token validado.
- **Chunking**: heading-aware, ~512 tokens con ~64 overlap. Notas ≤ 400
  tokens se embeben enteras.
- **Embeddings**: provider pluggable. Default Ollama (con
  `keep_alive: '24h'` para matar el cold-start, ver alpha.10). Opcional
  Azure OpenAI por env vars. Fallback determinístico.
- **Collab**: Yjs CRDT + Hocuspocus WebSocket server. **NO** edición offline
  — disconnect = editor read-only (decisión de producto: no exponer al
  user a conflicts complejos por ahora).
- **GC del CRDT state**: confiamos en Yjs (`gc: true` default + encode
  snapshot en cada save). No hay loop de compaction custom.

## Cosas que NO vamos a hacer

- Aplicación Electron / desktop nativo. Web-first; el usuario instala como
  PWA si quiere.
- ~~Real-time collaborative editing~~ — **revertido**, se hace en
  `feature/yjs-collab` (beta).
- Plugin system al estilo Obsidian. Extensibilidad vía MCP tools.
