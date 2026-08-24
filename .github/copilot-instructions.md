# Copilot custom instructions — Diluxite Core

This file is the project-wide context for GitHub Copilot (Code Review,
Chat, Coding Agent, and any other surface that reads
`.github/copilot-instructions.md`). It encodes domain knowledge,
conventions, and review priorities specific to this codebase. It is **not**
generic TypeScript / React / Fastify advice — it reflects how Diluxite is
actually written.

When you review a pull request, follow these rules. When in doubt, prefer
the project's existing patterns over textbook advice.

---

## What this repo is

**Diluxite** is a self-hostable "second brain" for your AI assistants:
markdown notes + hybrid search (FTS + semantic) + MCP server, all in one
binary. It's the engine that Claude, GitHub Copilot, or any MCP client
connects to so they can read, write, and search a user's personal memory.

Two editions of the same code:

- **Core** (this repo, AGPL-3.0, public): the engine + UI. Runs single-user
  and multi-user/multi-tenant. Distributed as `soydiloreto/diluxite-api` +
  `soydiloreto/diluxite-web` Docker Hub images. Local embeddings via Ollama or
  deterministic, optional Azure OpenAI.
- **Cloud** (private repo `diluxite-saas`): hosts the same engine
  multi-tenant with Entra External ID auth, Azure OpenAI embeddings,
  Cohere reranker, billing. The Cloud repo imports `@diluxite/api` from
  here — there is no fork. Everything that is generic enough lives here.

**Distinguishing technical decisions** (do not relitigate without
serious reason):

- **One Postgres, many roles**. Postgres holds both relational data
  (notes, folders, users, spaces) AND vectors (`chunks.embedding` via
  pgvector HNSW). No separate vector DB. Hybrid search is one query.
- **Pluggable providers via interfaces**, not feature flags.
  `EmbeddingProvider`, `Reranker`, `AuthProvider`, `SpaceAccess`,
  `TokenStore` are interfaces in `@diluxite/core`. The Core edition wires
  deterministic/Ollama/Azure embeddings + a single-user `SingleUserAuthProvider`.
  Cloud wires Azure OpenAI + `EntraAuthProvider`. **Do not add `if cloud {}`
  branches** — wire the interface differently.
- **Markdown is the source of truth**, not a render target. Notes are
  authored in markdown, stored in markdown, indexed from markdown.
  Wikilinks (`[[Other note]]`) and `#tags` are first-class — parsed at
  save time, persisted to `note_links` / `note_tags`, queryable.
- **MCP is the public surface**, not the REST API. The REST API is
  for the UI and for power users; the MCP server (`/mcp`) is what every
  AI client talks to. Breaking the MCP tool surface is a breaking change
  for clients who can't easily reconfigure.

---

## Stack

| Layer | Tech |
|---|---|
| Language | TypeScript (Node ≥ 20), ESM, strict |
| Monorepo | pnpm workspaces |
| Backend | Fastify 5 |
| DB | Postgres 17 + **pgvector** (cosine + HNSW) |
| ORM / migrations | Drizzle 0.38 |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP, stateful by session |
| Frontend | React 19 + Vite 7 + Tailwind CSS + Dockview + Monaco + cmdk + lucide |
| Tests | Vitest 3 (projects per package), Testing Library, real MCP client for e2e |
| Infra (dev) | Docker Compose: Postgres + pgvector + Adminer |
| Distribution | Docker Hub: `soydiloreto/diluxite-api`, `soydiloreto/diluxite-web` (multi-arch amd64/arm64) |

---

## Layout (monorepo)

```
diluxite-core/
  apps/
    api/    Fastify server: REST + MCP. Migrations run on boot.
    web/    React + Vite + Tailwind + ui/ primitives + Dockview shell.
  packages/
    core/   Domain logic: search, chunking, tags, wikilinks, RRF,
            interface ports (EmbeddingProvider, Reranker, AuthProvider).
            No I/O. Fully unit-tested.
    db/     Drizzle schema, migrations, repositories, bootstrap helpers.
            Postgres-only.
  docker/
    api.Dockerfile · web.Dockerfile · init.sql
  docker-compose.yml      dev mode (used in CI too)
  scripts/seed-demo.ts    1500 deterministic technical notes for demo
```

---

## Data model (v4.0+)

Everything in `packages/db/src/schema.ts`. Names are English (the v4.0
rename from Spanish identifiers is done; see `SPANISH_INVENTORY.md` for
historical mapping).

```
organizations id · name · created_at
spaces        id · name · org_id → orgs · owner_id → users · created_at
users         id · email(unique) · provider · created_at
memberships   (space_id, user_id) pk · role(owner|member)
folders       id · space_id · parent_id (self-ref, null=root) · name
              FK self-ref ON DELETE CASCADE
notes         id · space_id · folder_id (null=root, FK ON DELETE CASCADE)
              title · content_md · favorite(bool default false)
              created_at · updated_at
chunks        id · note_id(cascade) · space_id · text · position
              embedding vector(1536)
              indexes: GIN to_tsvector('spanish', text)
                       HNSW vector_cosine_ops
                       btree (space_id)
tokens        id · user_id(cascade) · token_hash(unique) · name · created_at
note_tags     (note_id, tag) pk · space_id · tag(lowercase)
note_links    (note_id, target) pk · space_id · target(target title, lowercase)
```

**Hard rules** (push back on PRs that break these):

- **Cascade-on-delete is intentional**: deleting a folder cascades its
  notes; deleting a note cascades its chunks. Reverse sync ("keep the
  note when the folder goes") is explicit (`folderId = null`), not
  implicit.
- **FTS dictionary is `'spanish'`**: most note content is in Spanish.
  Identifiers are English; content is mixed but FTS is tuned for ES.
  Do not change to `'simple'` or `'english'` without a migration plan.
- **`embedding vector(1536)`**: dimension is fixed at schema level. If
  you change the embedder model (and the dim with it), schema changes
  AND every chunk must be re-embedded. There is no shortcut.
- **`tags` and `links` are lowercase, always**: case-folded at write
  time. Search relies on this; don't add case-sensitive variants.

---

## Pluggable interfaces (the open-core seam)

`packages/core/src/providers.ts` and `packages/core/src/auth.ts`.

| Interface | Core implementations | Cloud implementations |
|---|---|---|
| `EmbeddingProvider` | `DeterministicEmbeddingProvider` (default), `OllamaEmbeddingProvider` (local), `AzureOpenAIEmbeddingProvider` (cloud-style) | Azure OpenAI |
| `Reranker` | `IdentityReranker` (no-op, preserves RRF order) | Cohere / cross-encoder |
| `AuthProvider` | `SingleUserAuthProvider` (bootstrapped admin user) | `EntraAuthProvider` (Entra External ID tokens) |
| `SpaceAccess` | `DrizzleSpacesRepository` | same |
| `TokenStore` | `DrizzleTokensRepository` | same |

**Provider selection lives in `apps/api/src/services.ts::pickEmbedder()`**.
Priority: Azure (if all three env vars) > Ollama (if model + dims set) >
deterministic. Never branch on a literal `cloud` flag — wire the right
implementation when constructing dependencies.

---

## Search pipeline

`packages/core/src/search.ts`. **Don't reinvent.**

- **On save** (`NotesService.save`): parse `#tags` + `[[wikilinks]]` →
  `setTags` + `setLinks` (lowercase, dedup) → `chunkMarkdown` (heading-aware,
  512 tokens / overlap 64, short notes go whole) → `embedder.embed`
  (batch) → `indexChunks`.
- **On query** (`SearchService.search`, modes `hybrid` | `keyword` |
  `semantic`):
  1. keyword: FTS over `text` (Spanish dict).
  2. vector: pgvector cosine over `embedding`.
  3. RRF fuse with k=60.
  4. Best chunk per note (dedup at note granularity).
  5. Optional rerank (Identity in Core).
  6. Top `topK` (default 8 for MCP, 20 for UI).

---

## MCP server

`/mcp` Streamable HTTP, stateful via `Mcp-Session-Id`. On
`initialize`, the server calls `auth.resolve(headers)` to obtain
identity + default space, then accepts tool calls. **16 tools, all
English from v4.0** (`buscar_memoria` etc. removed — no aliases):

```
search_memory · list_notes · read_note · write_note · list_spaces
list_tags · search_by_tag · recent_notes · backlinks_of · append_to_note
move_note · delete_note · purge_note · list_folders · delete_folder
read_notes
```

Folders are addressed by path (`Dailies/2026-08`), never by id.
`delete_folder` is the one tool that erases notes outright: the FK
cascade takes the subtree and nothing lands in the trash, so it refuses
a non-empty folder unless the caller passes `recursive: true`.

Each tool authorizes per membership. Cross-tenant access is impossible
by construction (every query carries `space_id` in the WHERE).

**Breaking change rule**: changing a tool's name, removing one, or
changing the shape of its inputs/outputs is a **major** version bump and
the CHANGELOG must call out the rename for clients.

---

## Frontend conventions

- **Tailwind utilities + `apps/web/src/ui/` primitives only.** Zero
  hand-rolled CSS in pages. Every primitive has at least a smoke test.
- **Layout owned by Dockview**, panes are `views/*View.tsx`.
- **Editor** is Monaco (`EditorView.tsx`). The Neighbors panel
  (`OutlinksTab`, `BacklinksTab`, `SuggestedTab`) lives next to it and
  its open/closed state + tab + split percentages persist in user prefs
  (`previewLayout`, `previewSplitPct`, `neighborsOpen`, `neighborsHeight`,
  `neighborsTab`).
- **Quick switcher**: cmdk, `Ctrl/Cmd+K`. Esc closes modals.
- **"+ New note" inherits the current folder**: `createNote(null)`
  resolves to `currentNote.folderId` or root. Don't reintroduce a
  variant that always creates at root.
- **Auto-link in Suggested**: each suggested note shows a "Link" button
  that appends `[[Title]]` to the current note. If the link already
  exists, show `✓ linked` instead.

---

## Removed / do NOT reintroduce

The following were tried and removed. Do not propose them back without
new motivating context:

- **Spanish identifiers** (`carpeta`, `notas`, `favorita`,
  `buscar_memoria`, etc.) — renamed to English in v4.0. The DB FTS
  dictionary stays `'spanish'` because content is in Spanish; only the
  symbols changed.
- **Dismissible drawer for the admin sidebar on mobile** — replaced
  in v4.5 by an inline horizontal tab-bar. UX feedback: drawer was
  hard to discover.
- **Setting `posts_per_page` on Loop Grid pagination** — wrong tool
  (this was a v3 cross-project pattern; if you see it referenced,
  ignore).
- **Single Template in the editor** — Astra-native rendering instead.

---

## Testing

- **Vitest with projects**: `core` (unit), `db` (integration with
  Postgres), `api` (integration + e2e MCP with a real client), `web`
  (jsdom + Testing Library).
- **`pnpm test:unit`** runs core + web (no DB) — must pass on every PR.
- **`pnpm test:int`** runs db + api (Postgres+pgvector required) — runs
  in CI with the `pgvector/pgvector:pg17` service.
- **Integration tests must NOT mock the database**. They hit a real
  Postgres `diluxite_test` created in `globalSetup`. Mocks here would
  hide schema/index/migration drift.
- **A bug fix without a test that would have caught it is not done.**

---

## Version + release rules

- Versions in 5 `package.json` (root + 4 workspaces) MUST be in sync.
  The `version-alignment.yml` workflow enforces this on every PR.
- `CHANGELOG.md` MUST have an entry for the version currently in
  `package.json`. The release workflow re-checks at tag time.
- Tag format: bare SemVer `vX.Y.Z` (e.g. `v4.10.0`). The release
  workflow refuses anything else (no `v1.10`, no `1.0.0-beta+meta`).
- Tagging `vX.Y.Z` triggers `release.yml`: build multi-arch
  amd64/arm64 → push `soydiloreto/diluxite-api:X.Y.Z`, `:X.Y`, `:latest` and same
  for `soydiloreto/diluxite-web` → publish a GitHub Release with notes.

---

## What to focus on when reviewing a PR

Prioritise these in this order:

1. **Schema / migration safety**. Any change in `packages/db/src/schema.ts`
   or `packages/db/migrations/` is high-risk. Ask: is there a migration?
   Is it reversible? Does it leave existing rows valid? Embedding
   dimension changes invalidate the index — reindex must be explicit.
2. **MCP tool stability**. Renaming, removing, or reshaping a tool
   breaks every connected Claude / Copilot client.
3. **Auth / multi-tenant isolation**. Every query that touches notes,
   folders, chunks, links, tags MUST include `space_id` in the WHERE.
   Cross-tenant leaks happen when a developer adds a "convenience"
   query without the space filter.
4. **Provider seam**. `if env.AZURE_OPENAI_*` branches outside
   `services.ts::pickEmbedder()` are a smell. Same for `if cloud {}`.
5. **Frontend primitive discipline**. Hand-rolled CSS or inline
   `style={{}}` is a smell. Tailwind utilities and `ui/` primitives.
6. **Tests**. Bug fix without a regression test = ask for one.
   Integration test that mocks the DB = ask for the real one.

When the PR is fine, say so. Don't fabricate concerns to fill a review.
