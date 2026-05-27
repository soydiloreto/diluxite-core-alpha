# Changelog

All notable changes to Diluxite Core are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Refactor — v4.0 internationalization

Diluxite v4.0 ships a major rename: all internal identifiers move from Spanish to
English (DB schema, types, API paths, MCP tool names, file names, class names).
The UI keeps full i18n support — English remains the default locale and Spanish
is a first-class supported locale. See [`SPANISH_INVENTORY.md`](./SPANISH_INVENTORY.md)
for the full naming map.

This is a **breaking change**: existing Claude/Copilot clients connected via MCP
must reconfigure tool names, and any external consumer of the REST API must update
their payloads. Single-user OSS instances can migrate by updating their database
schema (see migration notes below) and reconnecting their MCP clients.

#### Planned slices (executed in order)

- [x] **Slice 0** — Discovery: `SPANISH_INVENTORY.md` published.
- [x] **Slice 0.5** — Foundation: this changelog + version bump to `4.0.0-alpha.0`.
- [x] **Slice 1** — Backend rename (DB schema + core types + repos + REST API wire format): `notas → notes`, `carpetas → folders`, `usuarios → users`, `espacios → spaces`, `miembros → memberships`, `nota_tags → note_tags`, `nota_links → note_links`; columns to English with `created_at` / `updated_at`; types `Nota → Note`, `Carpeta → Folder`, `Espacio → Space`, `Usuario → User`; API paths (`/folders`, `/notes/:id/favorite`) and request bodies (`title`, `contentMd`, `folderId`, `name`, `parentId`, `favorite`, `content`) all in English. **Migration history collapsed** for alpha — existing v3.x installations must `docker compose down -v` or dump/restore. **Frontend (`apps/web`) intentionally lagging** — it still speaks the old Spanish wire format and will break at runtime until [Slice 5].
- [ ] **Slice 2** — *merged into Slice 1.*
- [ ] **Slice 3** — *merged into Slice 1.*
- [x] **Slice 4** — MCP tools renamed (hard cutover, no compatibility aliases). Tool descriptions and parameter names also translated to English. **Existing Claude/Copilot clients must reconfigure** — old tool names no longer respond.
  - `buscar_memoria → search_memory` (params: `espacio → space`)
  - `listar_notas → list_notes`
  - `leer_nota → read_note`
  - `escribir_nota → write_note` (params: `titulo → title`, `contenido → content`)
  - `listar_espacios → list_spaces`
  - `listar_tags → list_tags`
  - `buscar_por_tag → search_by_tag`
  - `notas_recientes → recent_notes` (params: `limite → limit`)
  - `backlinks_de → backlinks_of`
  - `agregar_a_nota → append_to_note` (params: `contenido → content`)
- [x] **Slice 5a** — Frontend rename: `apps/web` types (`Carpeta → Folder`, `titulo → title`, `contenidoMd → contentMd`, `favorita → favorite`, `nombre → name`, `padreId → parentId`, `espacioId → spaceId`, etc.) and API client methods (`createCarpeta → createFolder`, `setFavorita → setFavorite`, etc.) updated to consume the English backend. File rename `NotasTree.tsx → NotesTree.tsx`. Theme values `'oscuro'/'claro' → 'dark'/'light'`. The web app is again functional in runtime against the backend (was deliberately lagging since slice 1).
- [x] **Slice 5b** — Frontend i18n migration: homegrown `translate()` replaced with `i18next` + `react-i18next`. Catalogs moved to `apps/web/src/locales/{en,es}.json` (nested JSON with `topbar`, `dock`, `editor`, `dialog`, `empty`, `status`, `settings` sections). Interpolation syntax migrated from `{name}` to i18next's `{{name}}`. Hardcoded Spanish strings in `SettingsModal.tsx` (Connect AI / Búsqueda / IA / Conexión MCP / Espacio / Acerca de tabs) extracted into `settings.connect.*`, `settings.search.*`, `settings.ai.*`, `settings.mcp.*`, `settings.space.*`, `settings.about.*` keys. `useT()` kept as a thin wrapper over `useTranslation` for backwards-compatible call sites.
- [x] **Slice 6** — Docs refresh. `PRD.md` updated from v2 to v4.0.0-alpha (acknowledges the VS Code stack from v3.x and the i18n refactor of v4.0). `ARCHITECTURE.md` rewritten where it cites identifiers: data model (§4), MCP tools (§6), REST API (§8), implementation status (§14) all in English. `ROADMAP.md` drops the “rename to English” constant item (done) and updates the snapshot. `RUNBOOK.md` and `README.md` use English tool names in their examples. Documentation prose stays in Spanish per [[pablo-english-code]].
- [x] **Slice 7** — CI + ESLint guard. `eslint.config.mjs` (flat config) with `typescript-eslint` recommended rules plus a `no-restricted-syntax` rule that fails when a Spanish identifier from a curated deny list (`Carpeta`, `titulo`, `contenidoMd`, `setFavorita`, `buscar_memoria`, the 10 legacy MCP tool names, etc.) is introduced. `.github/workflows/ci.yml` runs Node 22 + pnpm 9 with a `pgvector/pgvector:pg17` service container and four steps: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:int`. PRs to `main` block on this workflow.

## [0.0.1] — pre-v4.0 baseline

Pre-v4.0 state of Diluxite Core, captured at commit `ed102ef`.

- Monorepo: `apps/api` (Fastify 5 + MCP), `apps/web` (React 19 + Vite 7 + Tailwind + Monaco + Dockview + cmdk + lucide), `packages/core` (domain), `packages/db` (Drizzle + Postgres 17 + pgvector).
- 137 tests across the monorepo (17 web + 120 monorepo).
- Hybrid search: Spanish FTS + pgvector cosine + RRF reranking. Modes: hybrid, keyword, semantic.
- 10 MCP tools (Spanish names, to be renamed in v4.0).
- Single-user `local@diluxite` bootstrap; multi-tenant ready in the engine.
- Docker Compose for full stack; Adminer optional via `--profile tools`.

[Unreleased]: https://github.com/soydiloreto/diluxite/compare/ed102ef...HEAD
