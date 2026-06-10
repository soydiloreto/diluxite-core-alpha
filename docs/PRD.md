# PRD — Diluxite (v4.0)

> **Product Document.** Functional source of truth. Accompanies [`ARCHITECTURE.md`](./ARCHITECTURE.md) (technical context). Together they allow rebuilding the project from scratch.

| | |
|---|---|
| Version | **v1.0.0-alpha.62** (v4.0 engine + enterprise hardening alphas — see §20) |
| Date | 2026-06-02 |
| Author | Pablo Di Loreto (Dilux) |
| Status | Living — keep updated with every change. |
| Brand | Diluxite · color `#008671` · 🪨 |

> **Quick read:** this PRD describes the product in two layers. Sections **1-19** are the v4.0 engine (notes + MCP + hybrid search + multi-tenant + VS Code-style UX) that was finalized in alpha.0. Section **§20 (Appendix)** covers all the **enterprise hardening** added between alpha.21 and alpha.62 (multi-backend auth incl. Cloudflare Access JWT, OIDC, 2FA, audit, CSRF, HTTPS Caddy, sessions UI, real-time collab, forgot-password, trash bin, installer management mode with backup/restore). For release-by-release detail see `CHANGELOG.md`. For the pending roadmap see `ROADMAP.md`.

**Brief history:** v1 = engine (notes + MCP + hybrid search + tokens + multi-tenancy). v2 = Obsidian-like layout + Tailwind + folders + quick-switcher. v3.x = VS Code stack (Activity Bar + Dockview + Monaco + cmdk + lucide). v4.0 = i18n refactor: DB schema, types, REST paths, MCP tools and UI catalogs in English, keeping Spanish as a supported locale in the UI. **alpha.10+ = Yjs collaborative editing + 31 enterprise hardening alphas (see §20)**.

---

## 1. Executive summary

**Diluxite is your AI's memory.** A service where knowledge is stored as notes and where Claude, Copilot and any MCP client **read, write and search by meaning** autonomously. It solves AI amnesia: your AI finally remembers — across sessions and across tools. It is not "yet another note editor": a loose `.md` is useless to your AI.

v2 hardens the **user experience** (Obsidian-style layout, design system coherent with Tailwind + the `ui/` library, organization for many notes) without losing the hybrid search engine + native MCP that was already solid.

## 2. Problem and opportunity

- **AI doesn't remember.** Every session starts from scratch; context gets re-explained.
- **Knowledge is scattered** and **not consumable by AI** in a structured, semantic way.
- **There is no shared memory** across AI tools.
- **Validated category** ("AI memory": Mem0, Zep, Supermemory). Diluxite differentiates through: **native MCP, open-core, multi-user, Azure-native, Spanish-first** and — since v2 — **Obsidian-level UX**.

## 3. Vision

> A **digital brain** that your AI uses on its own: you capture knowledge once and all your AIs remember it, expand it, and find it when needed. With an interface that feels *familiar* (Obsidian-style) and holds up to thousands of notes.

## 4. Value proposition

| For | Gains |
|---|---|
| Power user / dev | Their AI remembers across sessions and tools. Stops re-explaining |
| Team | Shared institutional memory (Cloud) |
| Self-hoster | Their own instance with `docker compose up` |

**Differentiators:**
- vs loose `.md`: no semantics and no MCP.
- vs Obsidian: local, single-user, no native MCP, no semantic search.
- vs ChatGPT memory: tied to a single product; Diluxite is agnostic and exportable.

## 5. Editions (open-core)

| | **Core** (OSS, AGPL-3.0) | **Cloud** (SaaS, private) |
|---|---|---|
| Access | auto-bootstrapped "local admin", no login | Google/MS (Entra) login |
| Hosting | `docker compose up` | Azure |
| Extras | The engine + full UX | + multi-tenant + billing |

Same engine (see ARCHITECTURE §3).

## 6. UX v2 — Obsidian-style layout

**The major change in v2:** drop the top tabs and adopt the Obsidian pattern:

```
┌──────────────────────────────────────────────────────────────────┐
│ ┌─ Left Dock ────┐  ┌── Main (Editor / Grafo) ────────────────┐ │
│ │ 🔎 Buscar       │  │  título · meta · editor + preview      │ │
│ │ ▼ Notas (árbol) │  │                                        │ │
│ │ ▶ Tags          │  │                                        │ │
│ │ ▶ Recientes     │  │                                        │ │
│ │ ▶ Favoritas     │  │                                        │ │
│ └─────────────────┘  └────────────────────────────────────────┘ │
│ ┌─ Status bar ─────────────────────────────────────────────────┐│
│ │ ⚙ Ajustes · 🟢 MCP · Espacio: Mi espacio · 👤 admin local    ││
│ └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

- **Left dock**: collapsible sections — Search (quick input), Notes (tree with folders), Tags, Recent, Favorites. Resizable.
- **Main**: the active view (Editor or Graph).
- **Status bar at the bottom**: ⚙ opens **Settings as a modal**, **MCP** indicator (green/red), active space, **user** ("local admin" in Core; the real one in Cloud).
- **Settings = Obsidian-style modal** with a side menu of sections: Appearance · Editor · AI Connection (MCP) · Security · About. Closes with `Esc`.

## 7. Design system (Tailwind + `ui/`)

**We adopt Tailwind CSS** (the same approach `dilux-claw-alpha` already has in internal production), and every new component is built with reusable primitives in `apps/web/src/ui/`:

- `Button`, `IconButton`, `Input`, `Field`, `Select`, `Modal`, `Section` (collapsible), `Sidebar`, `SidebarSection`, `ListItem`, `TreeItem`, `StatusBar`, `Toast`, `Tooltip`, `EmptyState`.
- Centralized tokens in `tailwind.config` (`--brand` colors, etc.).
- Rule: **no loose CSS in screens**, everything through Tailwind utilities + `ui/` primitives.

## 8. Personas

Power user / dev · Technical team · Self-hoster · **AI Agent** (first-class client via MCP).

## 9. Key use cases

1. "Claude, what did I decide about architecture X?" → `search_memory`.
2. "Note this down in my memory" → `write_note` / `append_to_note`.
3. Find a note with `Ctrl/Cmd+K` and open it instantly.
4. Organize 500+ notes into folders; cross-cutting tags.
5. Mark as favorites the ones used frequently.

## 10. Glossary

- **Note**: title + Markdown text.
- **Folder**: hierarchical grouping of notes (tree).
- **Space**: container of folders/notes; unit of permissions.
- **Wikilink `[[Nota]]`** / **Backlink**.
- **Tag `#tag`**.
- **Favorite**: note marked for quick access.
- **Outline**: index of the note's headings.
- **Chunk / Embedding / Hybrid (FTS + vector, RRF) / MCP / Token** — see ARCHITECTURE.

## 11. Functional requirements (v2)

> `RF-x`. Status: ✅ done · 🟡 this v2 sprint · 🔜 next.

### 11.1 Notes
- **RF-1..5** ✅ CRUD + wikilinks + autosave + delete confirmation + append.

### 11.2 **Organization (v2)** — for large vaults
- **RF-6** ✅ **Folders** (hierarchical tree): create, rename, move, delete.
- **RF-7** ✅ **Quick switcher** (`Ctrl/Cmd+K`): fuzzy by title, opens instantly.
- **RF-8** ✅ **Favorites (pin)**: mark/unmark; section in the left dock.
- **RF-9** ✅ **Outline**: panel with the current note's headings, navigable.
- **RF-10** ✅ **Multi-selection + bulk delete** (with confirmation showing the count).
- **RF-11** ✅ Tags `#tag`. **RF-12** ✅ Backlinks. **RF-13** ✅ Graph.

### 11.3 Spaces and multi-user
- **RF-14..16** ✅ Multiple spaces; invite = full access; tested isolation.

### 11.4 Search
- **RF-17..21** ✅ Hybrid + modes + interface reranking + heading-aware chunking + configurable embeddings (local/Azure).

### 11.5 MCP
- **RF-22..25** ✅ Native MCP server + 10 tools + per-user tokens + per-space authorization.

### 11.6 **UX v2**
- **RF-26** ✅ **Left-dock + status-bar + Settings modal layout** (replaces top tabs).
- **RF-27** ✅ **Tailwind + `ui/` design system** (no loose CSS in screens).
- **RF-28** ✅ **"local admin" indicator** in the status bar (Core); real user in Cloud.
- **RF-29** ✅ **Explained empty state** (no blank screen).
- **RF-30** ✅ **Settings modal with side sub-tabs** (Appearance / Editor / AI Connection (MCP) / Security / About).

### 11.7 Operations
- **RF-31** ✅ Adminer :8080. **RF-32** ✅ Self-host with `docker compose up`.

## 12. Detailed UX — screens and behaviors

### 12.1 Home / Start
> In v2 it is **removed as a tab**; the "Home" content (onboarding + connect AI) moves to the Main's **empty state** when no note is open + to a **"Get started"** section inside the Settings modal.

### 12.2 Left Dock (left panel)
- **Search** (input at the top): type and suggestions (semantic) appear inline, or use `Ctrl/Cmd+K`.
- **Notes (tree)**: collapsible folders, notes inside; click opens, double-click rename, context menu (move, delete, favorite).
- **Tags**: clickable tag cloud, filters the tree.
- **Recent**: last N modified.
- **Favorites**: pinned notes.

### 12.3 Main
- **Editor**: title · meta (created/edited) · split textarea ↔ preview · backlinks below · collapsible outline on the right.
- **Graph**: canvas + node list (accessible).

### 12.4 Status Bar (bottom)
- **⚙ Settings** → opens modal.
- **🟢/🔴 MCP** status + tooltip with endpoint.
- Active **Space** (future: selector).
- **👤 local admin** (Core) or `user's email` (Cloud).

### 12.5 Settings Modal
- Left-side submenu (Appearance · Editor · AI Connection (MCP) · Security · About).
- Each section with fields + explanatory text about what it's for.
- Closes with `Esc` or click outside.

### 12.6 Quick Switcher
- `Ctrl/Cmd+K` opens a modal with input + filtered list (fuzzy by title).
- Enter opens the selected note; `Esc` closes.

### 12.7 Bulk delete
- In the notes tree: hold `Shift`/`Ctrl` to multi-select.
- "Delete (n)" button with confirmation: "Delete n notes? This action cannot be undone."

## 13. Non-functional

- **RNF-1..6** Scale 10k–1M vectors; Cloud < US$20/month initial; Spanish validated; secure multi-tenant; Docker; < 300 ms search.
- **RNF-7 (v2)**: fluid layout (< 60 ms render); the notes tree works with 1k+ entries (virtualization if needed).

## 14. Roadmap

- **v1 (done)** ✅: engine + multi-user + hybrid search + tags + backlinks + graph + MCP + tokens + Adminer + AzureProvider + SaaS repo.
- **v2** ✅ shipped: Tailwind design system + Obsidian-like layout + folders + quick switcher + favorites + outline + multi-select delete + local admin indicator + Settings modal.
- **Next** 🔜: daily notes + templates; real Entra + billing (Cloud); attachments (→ text); Spanish eval; import.

## 15. Success metrics

Recall ≥ 90% top-5 (Spanish) · activation (connect AI within 7d) · latency < 300 ms p95 · UX: the folder tree + quick switcher keep a user with 500 notes from getting lost.

## 16. Business

Core free (AGPL-3.0) · Cloud Free/Pro/Team · possible commercial dual-licensing of the Core.

## 17. Risks / mitigations

| Risk | Mitigation |
|---|---|
| "Feels poor" / doesn't scale | v2: Obsidian layout + design system + folders + quick switcher |
| Cross-tenant leakage | Hard rules + cross tests (done) |
| Claude/Copilot adoption | Well-described tools + documented CLAUDE.md template |

## 18. Out of scope (v2)

Native desktop app, multimedia attachments, canvas, native mobile, daily notes (deferred to v2.1). Real-time collaborative editing is **in scope and shipped** (alpha.10+, Yjs + Hocuspocus).

## 19. Current status

**`v1.0.0-alpha.62` (2026-06-09):**
- **Tests: 850+ green** (unit + integration + 90 installer e2e bash assertions). Clean typecheck across 4 packages. Lint with no warnings.
- **Runtime stack**: Node 24, pnpm 10, TS 6, Fastify 5, Drizzle 0.45, Postgres 17 + pgvector, React 19, Vite 8, Tailwind 4, CodeMirror 6 + Yjs/Hocuspocus.
- **Distribution**: 3 Docker Hub images (all-in-one + api + web) with auto-update via Watchtower (**opt-in, default off** in the wizard, with an explicit risk warning). 9-step installer EN/ES/PT.
- **Modes**: `local` (single-user passwordless) and `server` (multi-auth: password + passkey + OIDC SSO + **Cloudflare Access JWT (signature-verified)** + trusted-header + 2FA TOTP).
- **Compliance baseline**: append-only audit log with configurable retention, active sessions UI, password change with session invalidation, rate-limit on sensitive endpoints, CSRF double-submit, security headers, HTTPS Caddy sidecar with ACME.
- **`docs/SECURITY.md §8`** with all "high/medium" gaps closed (2 remain "by design").

See `CHANGELOG.md` for release-by-release detail, `ROADMAP.md` for what's pending toward 1.0-beta, and `SPANISH_INVENTORY.md` for the history of the rename to English (v3.x → v4.0).

## 20. Appendix: enterprise hardening (alpha.21 → alpha.62)

Post-v4.0 the repo kept expanding with the full security and operations
stack that an enterprise deployment needs. These requirements were NOT in
the original PRD but accumulated as `Phase 1.0..1.5` + extensions:

- **Multi-backend auth** (server mode): email+password, WebAuthn passkeys,
  OIDC SSO (Okta / Entra / Google / Authentik) with JIT provisioning + a
  configurable auth policy, **Cloudflare Access JWT (signature-verified
  with `jose` — RS256 vs team certs + AUD)**, trusted-header proxy
  (Authelia / Pomerium — plaintext, kept only for setups that force all
  ingress through the proxy), 2FA TOTP RFC 6238 with backup codes.
- **Modular auth chain** built in `services.ts`: session → CF-Access-JWT →
  trusted-header, each layer opt-in via env.
- **Forgot-password reset flow** (alpha.42) with enumeration-resistant
  `POST /api/auth/forgot`, one-time hashed tokens (1h TTL), rate-limited,
  and session invalidation on success.
- **CSRF double-submit cookie**, **HTTPS Caddy sidecar** with automatic ACME,
  **security headers** via `@fastify/helmet`, **rate-limit** on sensitive
  endpoints.
- **Append-only audit log** with configurable retention + Admin UI → Audit.
- **Active sessions UI** (list + revoke + revoke-others) + **password change**
  with session invalidation.
- **CSV bulk import** of users + **Settings UI** for auth policy.
- **Trash bin / soft-delete** for notes (alpha.43+) with restore + purge +
  empty-trash endpoints and a sidebar TrashView.
- **Real-time collab** (alpha.10-12) with Yjs + Hocuspocus 2.x WebSocket
  server, awareness/cursors, server-side edits propagated via
  `applyServerEdit()` so MCP writes appear live in connected browsers.
- **Installer management mode** (alpha.45+): re-running `install.sh` shows
  a menu (update / reconfigure / status / backup / restore / uninstall /
  seed) + non-interactive flags + state in `.diluxite-install.env`.
- **Backup + restore** (alpha.46+) carry mode/embedder/domain/secrets +
  Caddy TLS cert; restore can bootstrap a fresh machine.
- **Auto-update is OPT-IN** (alpha.47+, default off, double risk warning).
  Uses the maintained `nickfedor/watchtower` fork.

Status at `v1.0.0-alpha.62`: **850+ green tests** (unit + integration + 90
installer e2e bash assertions), clean typecheck and lint. `docs/SECURITY.md §8` with all
"high/medium" gaps closed.

For release detail and what REMAINS pending to reach beta/1.0,
see `docs/ROADMAP.md` and `TODO.md`.
