# Spanish → English refactor inventory

> **✅ COMPLETED in v4.0.0 — historical document.** El refactor ES→EN ya terminó;
> este inventario se conserva solo como referencia y no se mantiene más.

> Working doc para el refactor `refactor/i18n-english` (target v4.0.0).
> Captura todo identifier en español del repo + su mapping a inglés.
> **Comunicación con el equipo y docs siguen en español.** Sólo el código va a inglés.

## Scope

| Capa | Estado actual | Acción |
|---|---|---|
| DB schema (tablas + columnas) | 100% español | Drizzle migration con `ALTER TABLE/COLUMN RENAME` |
| Core/domain types | Mezclado (`Note`, `Space` ya en EN; `Carpeta`, `Usuario`, `Miembro`, `Espacio` aún ES) | Rename in-place |
| API paths | Mezclado (`/spaces`, `/notes` EN; `/carpetas`, `/favorita` ES) | Rename de paths + bodies + query params |
| MCP tools (10) | 100% español | Hard cutover (sin aliases) — clientes Claude/Copilot reconfiguran |
| File names | 2 archivos ES (`carpetas-repository.ts`, `NotasTree.tsx`) | `git mv` |
| Web UI strings | 95% i18n'd (default EN, ES como locale); 3-5 strings hardcodeados | Mover a catálogo + extraer todos |
| i18n infra | Homegrown `translate()` casero | Migrar a `i18next` + `react-i18next` con namespaces |
| Docs | Español (sigue así por preferencia) | Sólo actualizar identifiers EN cuando citen código |
| Comentarios de código | Mezclado | Traducir a EN gradualmente (no bloqueante) |

## Naming map

### DB tables

| Actual (ES) | Nuevo (EN) |
|---|---|
| `usuarios` | `users` |
| `espacios` | `spaces` |
| `miembros` | `memberships` |
| `notas` | `notes` |
| `carpetas` | `folders` |
| `chunks` | `chunks` *(ya EN)* |
| `tokens` | `tokens` *(ya EN)* |
| `nota_tags` | `note_tags` |
| `nota_links` | `note_links` |

### DB columns

| Actual (ES) | Nuevo (EN) | Notas |
|---|---|---|
| `titulo` | `title` | en `notes` |
| `contenido_md` | `content_md` | en `notes` |
| `creado` | `created_at` | en todas las tablas — estándar timestamps |
| `modificado` | `updated_at` | en `notes` — estándar timestamps |
| `favorita` | `favorite` | en `notes` |
| `dueno_id` | `owner_id` | en `spaces` |
| `padre_id` | `parent_id` | en `folders` |
| `usuario_id` | `user_id` | en `memberships`, `tokens` |
| `espacio_id` | `space_id` | en muchas |
| `nota_id` | `note_id` | en `chunks`, `note_tags`, `note_links` |
| `carpeta_id` | `folder_id` | en `notes` |
| `proveedor` | `provider` | en `users` |
| `nombre` | `name` | en `spaces`, `folders`, `tokens` |
| `texto` | `text` | en `chunks` |
| `orden` | `position` | en `chunks` (mejor semántica) |
| `rol` | `role` | en `memberships` |
| `tag` | `tag` *(ya EN)* | en `note_tags` |
| `target` | `target` *(ya EN)* | en `note_links` |
| `email` | `email` *(ya EN)* | en `users` |
| `token_hash` | `token_hash` *(ya EN)* | en `tokens` |
| `embedding` | `embedding` *(ya EN)* | en `chunks` |

### Index names

| Actual | Nuevo |
|---|---|
| `chunks_espacio_idx` | `chunks_space_idx` |
| `nota_tags_space_tag_idx` | `note_tags_space_tag_idx` |
| `nota_links_space_target_idx` | `note_links_space_target_idx` |

### TypeScript types / interfaces

| Actual (ES) | Nuevo (EN) | Dónde |
|---|---|---|
| `Nota` (referenciada en wikilinks.ts comments) | `Note` (ya existe en EN en otros lados — consolidar) | `packages/db/src/notes-repository.ts` ya usa `Note` |
| `Carpeta` | `Folder` | `packages/db/src/carpetas-repository.ts`, `apps/web/src/api.ts`, `fakeApi.ts`, `App.tsx`, `AppContext.tsx`, `NotasTree.tsx` |
| `Espacio` | `Space` | `packages/db/src/spaces-repository.ts` (línea 6) |
| `Usuario` | `User` | `packages/db/src/spaces-repository.ts` (línea 57) |
| `Miembro` | `Membership` | (si existe — verificar) |

### Object fields (camelCase) — afecta apps/api, apps/web, packages/

| Actual (ES) | Nuevo (EN) |
|---|---|
| `espacioId` | `spaceId` |
| `carpetaId` | `folderId` |
| `notaId` | `noteId` |
| `usuarioId` | `userId` |
| `padreId` | `parentId` |
| `duenoId` | `ownerId` |
| `contenidoMd` | `contentMd` |
| `titulo` | `title` |
| `nombre` | `name` |
| `creado` | `createdAt` |
| `modificado` | `updatedAt` |
| `favorita` | `favorite` |
| `proveedor` | `provider` |
| `texto` | `text` |
| `orden` | `position` |
| `rol` | `role` |
| `tokenHash` | `tokenHash` *(ya EN)* |

### Variables locales / colecciones

| Actual (ES) | Nuevo (EN) |
|---|---|
| `notas` (variable) | `notes` |
| `carpetas` (variable) | `folders` |
| `espacios` (variable) | `spaces` |
| `usuarios` (variable) | `users` |
| `miembros` (variable) | `memberships` |
| `notaTags` | `noteTags` |
| `notaLinks` | `noteLinks` |
| `nuevo` (en append handler) | `newContent` |
| `raiz` (en tests) | `root` |
| `mover` (método en carpetas-repo) | `move` |

### MCP tools (hard cutover — 10 tools)

| Actual (ES) | Nuevo (EN) | Descripción EN propuesta |
|---|---|---|
| `buscar_memoria` | `search_memory` | "Search memory by meaning and keywords; returns the most relevant notes." |
| `listar_notas` | `list_notes` | "List notes in a space." |
| `leer_nota` | `read_note` | "Read full content of a note by id." |
| `escribir_nota` | `write_note` | "Create or update a note by title (saves a memory)." |
| `listar_espacios` | `list_spaces` | "List spaces accessible to the current user." |
| `listar_tags` | `list_tags` | "List all tags used across notes in a space." |
| `buscar_por_tag` | `search_by_tag` | "Find notes tagged with a specific tag." |
| `notas_recientes` | `recent_notes` | "List most recently modified notes." |
| `backlinks_de` | `backlinks_of` | "List notes that link to a given note." |
| `agregar_a_nota` | `append_to_note` | "Append content to the end of an existing note." |

### MCP tool parameters

| Actual (ES) | Nuevo (EN) |
|---|---|
| `query` | `query` *(ya EN)* |
| `espacio` | `space` |
| `topK` | `topK` *(ya EN)* |
| `id` | `id` *(ya EN)* |
| `titulo` | `title` |
| `contenido` | `content` |
| `tag` | `tag` *(ya EN)* |
| `limite` | `limit` (si aparece) |

### API paths

| Actual (ES o mixto) | Nuevo (EN) | Método |
|---|---|---|
| `GET /api/spaces/:spaceId/carpetas` | `GET /api/spaces/:spaceId/folders` | árbol |
| `POST /api/spaces/:spaceId/carpetas` | `POST /api/spaces/:spaceId/folders` | crear |
| `PUT /api/carpetas/:id` | `PUT /api/folders/:id` | rename/move |
| `DELETE /api/carpetas/:id` | `DELETE /api/folders/:id` | borrar |
| `PUT /api/notes/:id/favorita` | `PUT /api/notes/:id/favorite` | toggle |
| `GET /api/spaces/:id/notes?tag=&carpeta=` | `GET /api/spaces/:id/notes?tag=&folder=` | filter |

### API request/response bodies — fields a renombrar

| Endpoint | Actual | Nuevo |
|---|---|---|
| `POST /spaces` body | `{ nombre }` | `{ name }` |
| `POST /spaces/:id/notes` body | `{ titulo, contenidoMd, carpetaId }` | `{ title, contentMd, folderId }` |
| `PUT /notes/:id` body | `{ titulo?, contenidoMd? }` | `{ title?, contentMd? }` |
| `POST /notes/:id/append` body | `{ contenido }` | `{ content }` |
| `POST /spaces/:id/folders` body | `{ nombre, padreId }` | `{ name, parentId }` |
| `PUT /folders/:id` body | `{ nombre?, padreId? }` | `{ name?, parentId? }` |
| `PUT /notes/:id/favorite` body | `{ favorita }` | `{ favorite }` |
| `POST /tokens` body | `{ nombre }` | `{ name }` |
| Note response | `{ id, titulo, contenidoMd, favorita, creado, modificado, ... }` | `{ id, title, contentMd, favorite, createdAt, updatedAt, ... }` |

### File renames

| Actual | Nuevo |
|---|---|
| `packages/db/src/carpetas-repository.ts` | `packages/db/src/folders-repository.ts` |
| `apps/web/src/components/NotasTree.tsx` | `apps/web/src/components/NotesTree.tsx` |

### Repository class names

| Actual | Nuevo |
|---|---|
| `DrizzleCarpetasRepository` | `DrizzleFoldersRepository` |
| `DrizzleEspaciosRepository` (si existe) | `DrizzleSpacesRepository` |
| `DrizzleUsuariosRepository` (si existe) | `DrizzleUsersRepository` |
| `CarpetasRepository` interface | `FoldersRepository` interface |
| `EspaciosRepository` interface | `SpacesRepository` interface (ya existe?) |

### Methods en repos

| Actual | Nuevo |
|---|---|
| `carpetas-repo.mover()` | `folders-repo.move()` |
| `setFavorita()` | `setFavorite()` |

### Web UI strings hardcodeados (no en `i18n.ts`)

Encontrados — mover al catálogo `en`/`es`:

| Archivo | Línea | String ES |
|---|---|---|
| `apps/web/src/layout/SettingsModal.tsx` | 150 | `Búsqueda` |
| `apps/web/src/layout/SettingsModal.tsx` | 224 | `Conexión MCP` |
| `apps/web/src/layout/SettingsModal.tsx` | 285 | `Espacio` |
| `apps/web/src/layout/SettingsModal.tsx` | 303 | `Acerca de` |
| `apps/web/src/layout/SettingsModal.tsx` | 308 | `Usuario activo:` |

Posible más — la migración a i18next (slice 5) hace un sweep completo con `eslint-plugin-i18next`.

### Comentarios de código en español (no bloqueante)

Muchos comments en español a lo largo del repo (ver `apps/api/src/app.ts:50,155,164,174,189,196,207`, `packages/core/src/chunking.ts`, `chunking.test.ts`, etc.). Política: **traducir oportunisticamente** cuando se toca un archivo por otra razón. No es un slice dedicado.

## Slices y orden

Ver tasks en TaskList. Resumen:

0. Discovery (este archivo) → commit
0.5. Foundation: CHANGELOG + ESLint guard + bump 4.0.0-alpha
1. DB schema rename (migration nativa)
2. Core domain types
3. API paths + bodies
4. MCP tools (hard cutover)
5. i18n migration (i18next + namespaces JSON)
6. Docs refresh (PRD a v3.1)
7. CI (GitHub Actions)

## Reglas para cada slice

- **Commit atómico**: un slice = uno o pocos commits relacionados. Conventional commits: `refactor(db): rename notas to notes`.
- **Gate antes del commit**: `pnpm typecheck && pnpm test` verde.
- **Sin compat shims**: cutover limpio (esto es v4.0.0 breaking).
- **CHANGELOG**: cada slice agrega su entrada en `Unreleased → Changed/Removed/Added`.
- **Sin nuevos identifiers en español**: la regla ESLint (slice 0.5) hace de guard.

## Counts (referencia)

- 22 test files, 137 tests reportados antes del refactor (120 monorepo + 17 web por commits)
- 5 tablas con nombre ES, 9 tablas totales
- 10 MCP tools, 100% ES
- ~30 columnas a renombrar
- 2 archivos a `git mv`
- ~6 paths/endpoints a renombrar
- ~12 fields de body a renombrar
- Identifiers ES en código (top hits): `espacioId` (173 usos), `titulo` (166), `nombre` (98), `contenidoMd` (97), `notas` (82), `carpetas` (80)
