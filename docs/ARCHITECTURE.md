# ARCHITECTURE — Diluxite (contexto técnico, v2)

> Documento técnico. Acompaña al [`PRD.md`](./PRD.md). Permite reconstruir el proyecto desde cero. Estado al 2026-05-26 (v2).

## 1. Stack

- **Lenguaje**: TypeScript (Node ≥ 20), ESM. **Monorepo**: pnpm workspaces.
- **Backend**: Fastify 5 + Drizzle 0.38 + PostgreSQL 17 + **pgvector**.
- **Búsqueda**: FTS español + pgvector (coseno) + RRF + reranking (interfaz). Modos: hybrid/keyword/semantic.
- **MCP**: `@modelcontextprotocol/sdk` (Streamable HTTP, stateful por sesión).
- **Embeddings**: `DeterministicEmbeddingProvider` (default OSS, sin claves) o `AzureOpenAIEmbeddingProvider` (auto si hay env `AZURE_OPENAI_*`).
- **Frontend**: React 19 + Vite 7 + **Tailwind CSS** (v2) + biblioteca `src/ui/` propia.
- **Tests**: Vitest 3 (proyectos por paquete) + Testing Library (web) + cliente MCP real (e2e).
- **Infra**: Docker Compose (Postgres + pgvector + Adminer).

## 2. Estructura

```
diluxite-core/                 PÚBLICO, AGPL-3.0 — motor + UI OSS
  apps/
    api/      Fastify: REST + servidor MCP
    web/      React + Vite + Tailwind + ui/ primitivos
  packages/
    core/     dominio puro
    db/       Drizzle: schema, migraciones, repos, bootstrap
  docker-compose.yml  (Postgres + Adminer :8080)
  COMPARISON.md

diluxite-saas/                 PRIVADO — Cloud
  src/server.ts   server multi-tenant que importa @diluxite/api
  src/entra.ts    EntraAuthProvider (skeleton)
  docs/           PRD.md + ARCHITECTURE.md (este doc)
```

## 3. Open-core: interfaces enchufables

| Puerto (`@diluxite/core`) | Core | Cloud |
|---|---|---|
| `AuthProvider` | `SingleUserAuthProvider` (bootstrappea "admin local") | `EntraAuthProvider` (token hoy) |
| `EmbeddingProvider` | Determinista o Azure (auto por env) | Azure OpenAI |
| `Reranker` | `IdentityReranker` | Cohere / cross-encoder (futuro) |
| `SpaceAccess`, `TokenStore` | `DrizzleSpacesRepository`, `DrizzleTokensRepository` | idem |

## 4. Modelo de datos (v2)

```
usuarios     id · email(unique) · proveedor · creado
espacios     id · nombre · dueno_id → usuarios · creado
miembros     (espacio_id, usuario_id) pk · rol(owner|member)
carpetas     id · espacio_id · padre_id (self-ref, null=root) · nombre · creado      -- NUEVO v2
notas        id · espacio_id · carpeta_id (null=root) · titulo · contenido_md ·
             favorita(bool default false) · creado · modificado                       -- v2: + carpeta_id, favorita
chunks       id · nota_id(cascade) · espacio_id · texto · orden ·
             embedding vector(1536)
             índices: GIN to_tsvector('spanish',texto) · HNSW vector_cosine_ops · (espacio_id)
tokens       id · usuario_id(cascade) · token_hash(unique) · nombre · creado
nota_tags    (nota_id, tag) pk · espacio_id · tag(minúscula)
nota_links   (nota_id, target) pk · espacio_id · target(título destino, minúscula)
```

- `carpetas` con padre_id self-ref (árbol por espacio). `notas.carpeta_id` (null = raíz).
- `notas.favorita` boolean (en Core es global por nota; Cloud puede mover a tabla `favoritos(usuario_id, nota_id)` cuando haga falta).

## 5. Búsqueda

Pipeline idéntico a v1, sin cambios.
- Al guardar: `setTags(parseTags)` + `setLinks(uniqueTargets)` + `chunkMarkdown` (heading-aware, 512/overlap 64; cortas enteras) + `embedder.embed` + `indexChunks`.
- Al buscar (`mode='hybrid'|'keyword'|'semantic'`): keyword (FTS) + vector (pgvector cosine) → RRF (k=60) → mejor chunk por nota → rerank → top topK.

## 6. MCP

- `/mcp` Streamable HTTP, stateful (`Mcp-Session-Id`).
- En `initialize`: `auth.resolve` → identidad + default space.
- Tools (10): `buscar_memoria`, `listar_notas`, `leer_nota`, `escribir_nota`, `listar_espacios`, `listar_tags`, `buscar_por_tag`, `notas_recientes`, `backlinks_de`, `agregar_a_nota`. Cada tool autoriza por membresía.

## 7. Auth y multi-tenant

- Hook `preHandler` en `/api`: `auth.resolve(headers)` → `req.identity`; 401 si null.
- Authz por espacio en cada operación (`requireMember` / `loadAuthorizedNote`).
- Invitar: solo `owner`. Tokens: Bearer; SHA-256 hash.
- Tests cruzados confirman aislamiento.

## 8. API REST (v2 amplía v1)

```
GET    /health · /health/db
GET    /api/info                       {embedder, version, user:{email}}              -- v2: user
GET    /api/spaces · POST /api/spaces · POST /api/spaces/:id/members
GET    /api/spaces/:id/notes[?tag=&carpeta=]                                          -- v2: carpeta filter
POST   /api/spaces/:id/notes           {titulo, contenidoMd, carpetaId?}              -- v2: carpetaId
GET    /api/spaces/:id/tags · /graph · /stats
GET    /api/spaces/:id/carpetas        árbol completo                                 -- NUEVO v2
POST   /api/spaces/:id/carpetas        {nombre, padreId?}                             -- NUEVO v2
PUT    /api/carpetas/:id               {nombre?, padreId?}                            -- NUEVO v2 (rename/mover)
DELETE /api/carpetas/:id                                                              -- NUEVO v2
GET    /api/notes/:id · PUT · DELETE · GET /api/notes/:id/backlinks · POST /append
PUT    /api/notes/:id/favorita         {favorita: bool}                               -- NUEVO v2
POST   /api/notes/delete-many          {ids: [...]}                                   -- NUEVO v2
POST   /api/search                     {query, spaceId?, topK?, mode?}
POST   /api/tokens · GET · DELETE /api/tokens/:id
```

## 9. Frontend (v2)

**Cambio mayor de v2**: layout Obsidian-like + Tailwind + biblioteca `ui/`.

```
apps/web/
  tailwind.config.ts · postcss.config.js
  src/
    main.tsx          entry React
    App.tsx           orquestador + Layout
    api.ts · fakeApi.ts · markdown.ts · useSettings.ts
    layout/
      AppLayout.tsx    LeftDock + Main + StatusBar
      LeftDock.tsx     búsqueda + secciones colapsables
      StatusBar.tsx    ⚙ + MCP + espacio + usuario
      SettingsModal.tsx  modal con sub-tabs laterales
    panes/
      NotasTree.tsx    árbol de carpetas + notas
      TagsPane.tsx · RecientesPane.tsx · FavoritasPane.tsx
      Outline.tsx
    views/
      EditorView.tsx · GraphView.tsx · EmptyState.tsx
    ui/
      Button.tsx · IconButton.tsx · Input.tsx · Field.tsx · Select.tsx
      Modal.tsx · Section.tsx · ListItem.tsx · TreeItem.tsx
      Sidebar.tsx · StatusBar.tsx · Toast.tsx · Tooltip.tsx · EmptyState.tsx
    features/
      QuickSwitcher.tsx   modal Ctrl/Cmd+K
      MultiSelectBar.tsx  barra "Borrar (n)" al multi-seleccionar
```

**Reglas:**
- **Cero CSS hand-rolled** en pantallas; solo Tailwind utilities + primitivos `ui/`.
- Cada primitivo de `ui/` testeado al menos con un smoke test.
- Vistas (EditorView/GraphView) componen panes y primitivos.

**Atajos:**
- `Ctrl/Cmd+K` Quick switcher.
- `Esc` cierra modales.

## 10. Testing

Vitest con proyectos:
- `core` (unit, sin DB).
- `db` (integración Postgres).
- `api` (integración + e2e MCP).
- `web` (jsdom + Testing Library + `@testing-library/user-event`).

Bases de test: `diluxite_test` (creada/migrada en globalSetup).

## 11. Despliegue

- **Core**: `docker compose up -d` (Postgres + Adminer :8080) + `pnpm --filter @diluxite/api dev` (:3030) + `pnpm --filter @diluxite/web dev` (:5173). Migraciones al iniciar la API.
- **Cloud**: Azure Container Apps (stateless, Streamable HTTP) + Azure Postgres Flexible (pgvector/DiskANN) + Azure OpenAI + Entra External ID + billing.

## 12. Env vars

```
PORT · DATABASE_URL · ADMIN_DATABASE_URL · TEST_DATABASE_URL
AZURE_OPENAI_ENDPOINT · AZURE_OPENAI_API_KEY · AZURE_OPENAI_DEPLOYMENT · EMBEDDING_DIMENSIONS
ENTRA_TENANT_ID · ENTRA_CLIENT_ID (Cloud futuro)
```

## 13. Decisiones técnicas

- **Postgres + pgvector** único motor (datos + vectores; hasta 1M cómodo).
- **Determinista por defecto** en OSS para correr sin claves; Azure auto si env.
- **Tags/links/carpetas/favorita** persistidas al indexar o al editar — consistencia y queries simples.
- **Open-core** con puertos enchufables; un solo motor; Cloud cambia auth/embeddings/billing.
- **Tests primero (TDD)**; typecheck como gate adicional.
- **Tailwind + `ui/` propio** (no MUI/Chakra) para coherencia visual fina con la marca Diluxite y para mantener bundle chico.

## 14. Estado de implementación (v2 en curso)

- `packages/core`: estable v1.
- `packages/db`: v2 suma `carpetas` + `notas.carpeta_id` + `notas.favorita`.
- `apps/api`: v2 suma endpoints de carpetas, favorita toggle, delete-many, `/api/info` con `user`.
- `apps/web`: **rediseñado en v2** con Tailwind + `ui/` + layout Obsidian-like.
- `diluxite-saas`: sin cambios estructurales en v2; absorbe los nuevos endpoints automáticamente al actualizar la dep del core.
