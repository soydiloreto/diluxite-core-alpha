# ARCHITECTURE — Diluxite (contexto técnico, v4.0)

> Documento técnico. Acompaña al [`PRD.md`](./PRD.md). Permite reconstruir el proyecto desde cero. Estado al 2026-05-27 (v4.0.0-alpha — refactor a identifiers en inglés terminado).

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

## 4. Modelo de datos (v4.0)

Todos los nombres en inglés desde v4.0 (ver `SPANISH_INVENTORY.md` para el mapping completo desde v3.x).

```
users        id · email(unique) · provider · created_at
spaces       id · name · owner_id → users · created_at
memberships  (space_id, user_id) pk · role(owner|member)
folders      id · space_id · parent_id (self-ref, null=root) · name · created_at
notes        id · space_id · folder_id (null=root) · title · content_md ·
             favorite(bool default false) · created_at · updated_at
chunks       id · note_id(cascade) · space_id · text · position ·
             embedding vector(1536)
             índices: GIN to_tsvector('spanish',text) · HNSW vector_cosine_ops · (space_id)
tokens       id · user_id(cascade) · token_hash(unique) · name · created_at
note_tags    (note_id, tag) pk · space_id · tag(minúscula)
note_links   (note_id, target) pk · space_id · target(título destino, minúscula)
```

- `folders` con `parent_id` self-ref (árbol por espacio). `notes.folder_id` (null = raíz).
- **Borrar una carpeta cascade-elimina su contenido**: las subcarpetas se borran por el FK self-ref con `onDelete: 'cascade'`, y las notas también por `notes.folder_id` con `onDelete: 'cascade'`. Para conservar una nota antes de borrar la carpeta hay que moverla (`PUT /notes/:id { folderId: null }`).
- `notes.favorite` boolean (en Core es global por nota; Cloud puede mover a tabla `favorites(user_id, note_id)` cuando haga falta).
- El FTS sigue usando el diccionario `'spanish'` de Postgres porque el contenido de las notas es mayormente en castellano — solo los identifiers cambiaron a inglés.

## 5. Búsqueda

Pipeline idéntico a v1, sin cambios.
- Al guardar: `setTags(parseTags)` + `setLinks(uniqueTargets)` + `chunkMarkdown` (heading-aware, 512/overlap 64; cortas enteras) + `embedder.embed` + `indexChunks`.
- Al buscar (`mode='hybrid'|'keyword'|'semantic'`): keyword (FTS) + vector (pgvector cosine) → RRF (k=60) → mejor chunk por nota → rerank → top topK.

## 6. MCP

- `/mcp` Streamable HTTP, stateful (`Mcp-Session-Id`).
- En `initialize`: `auth.resolve` → identidad + default space.
- Tools (10, todas en inglés desde v4.0): `search_memory`, `list_notes`, `read_note`, `write_note`, `list_spaces`, `list_tags`, `search_by_tag`, `recent_notes`, `backlinks_of`, `append_to_note`. Cada tool autoriza por membresía. **Breaking v3 → v4**: los nombres viejos (`buscar_memoria`, etc.) ya no responden — los clientes Claude/Copilot deben reconfigurar.

## 7. Auth y multi-tenant

- Hook `preHandler` en `/api`: `auth.resolve(headers)` → `req.identity`; 401 si null.
- Authz por espacio en cada operación (`requireMember` / `loadAuthorizedNote`).
- Invitar: solo `owner`. Tokens: Bearer; SHA-256 hash.
- Tests cruzados confirman aislamiento.

## 8. API REST (v4.0 — wire format en inglés)

```
GET    /health · /health/db
GET    /api/info                       {embedder, version, user:{email}}
GET    /api/spaces · POST /api/spaces · POST /api/spaces/:id/members
GET    /api/spaces/:id/notes[?tag=&folder=]
POST   /api/spaces/:id/notes           {title, contentMd, folderId?}
GET    /api/spaces/:id/tags · /graph · /stats
GET    /api/spaces/:id/folders         árbol completo
POST   /api/spaces/:id/folders         {name, parentId?}
PUT    /api/folders/:id                {name?, parentId?}                             -- rename/move
DELETE /api/folders/:id
GET    /api/notes/:id · PUT · DELETE · GET /api/notes/:id/backlinks
POST   /api/notes/:id/append           {content}
PUT    /api/notes/:id/favorite         {favorite: bool}
POST   /api/notes/delete-many          {ids: [...]}
POST   /api/search                     {query, spaceId?, topK?, mode?}
POST   /api/tokens                     {name} · GET · DELETE /api/tokens/:id
```

**Breaking v3 → v4**: paths `/carpetas` y `/favorita` removidos; bodies usan `title/contentMd/folderId/name/parentId/favorite/content` en lugar de `titulo/contenidoMd/carpetaId/nombre/padreId/favorita/contenido`.

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

## 14. Estado de implementación (v4.0.0-alpha)

- `packages/core`: types/clases en inglés (`Note`, `CreateNoteInput`, `NotesRepository`, `Folder`, `Space`, `User`, etc.). Migration de v3.x: ver `SPANISH_INVENTORY.md`.
- `packages/db`: schema completo en inglés. Migration history colapsada a `0000_initial.sql` (alpha breaking — instalaciones v3.x deben `docker compose down -v` o dump/restore).
- `apps/api`: handlers + MCP tools + wire format en inglés.
- `apps/web`: stack VS Code (Dockview + Monaco + cmdk + lucide). i18n con `i18next` + `react-i18next`, catálogos JSON en `src/locales/{en,es}.json`, default inglés con español como locale soportado.
- `diluxite-saas`: absorbe el rename al actualizar la dep del core. Requiere reconfigurar clientes MCP.
