<div align="center">

# Diluxite 🪨

### The memory your AI uses on its own.

**Diluxite is not just another note editor — it's the memory your AI reads, writes, and searches by meaning.** Store knowledge once and **Claude, Copilot, Codex, and any MCP client recall it across sessions and across tools.** A loose `.md` file can't do that: your AI can't remember it or search it semantically.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](.nvmrc)
[![Docker image](https://img.shields.io/badge/Docker%20Hub-soydiloreto%2Fdiluxite-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/soydiloreto/diluxite)
[![MCP](https://img.shields.io/badge/MCP-native%20server-7C3AED)](#-connect-claude--copilot--codex-mcp)
[![Tests](https://img.shields.io/badge/tests-850%2B%20green-success)](#-tests)

</div>

> **Core edition** (this repo): open source, self-hosted, single-user. The **Cloud edition** (multi-user, Google/Microsoft sign-in, hosted) is built on this exact same engine.

---

## What you get

- Your AI **remembers your context** (decisions, notes, projects) without re-explaining everything every time.
- **Search by meaning**, not just exact words: "the Microsoft cloud" finds your note about "Azure".
- **Connect Claude / Copilot / Codex over MCP** and they share one persistent memory.

## Features

- 📝 Markdown notes with editor + **live preview**.
- 🔗 **Wikilinks** `[[Note]]`, **backlinks**, and a knowledge **graph**.
- 🏷️ **Tags** `#tag` with filtering.
- 🔎 **Hybrid search** (keyword + meaning, fused with RRF) — switchable: hybrid / keyword-only / semantic-only.
- 🧠 **Native MCP server** with ten tools (see below).
- 🔑 **Per-user tokens** to connect your AI.
- 👥 Multi-user by workspace (isolation + sharing) — ready in the engine.
- ⚙️ Real **settings**: Appearance (theme/color), Editor, AI Connection (MCP), Security, About.
- 🛠️ **Smart installer** with a management menu (update, reconfigure, backup, restore, seed, uninstall).
- 🔐 Server mode with **email + password**, **Cloudflare Access (verified JWT)**, or a trusted-header proxy.
- 👯 **Real-time collaborative editing** (Yjs + Hocuspocus): live cursors, presence avatars, conflict-free merges.
- 🗑️ **Trash with soft-delete**: restore or purge notes, per-workspace trash view.
- 🪪 **OIDC SSO** (any standards-compliant IdP, PKCE) for server mode.
- 🔏 **Passkeys (WebAuthn)** and **2FA TOTP** for password accounts.
- 🧾 **Audit log** of security-relevant events, with retention.
- 🌍 UI localized in **6 languages**: English, Spanish, Portuguese, Italian, Catalan, Chinese.

### MCP tools (the "second brain" API)

`search_memory` · `read_note` · `write_note` · `append_to_note` · `delete_note` · `purge_note` · `list_notes` · `list_tags` · `search_by_tag` · `backlinks_of` · `recent_notes` · `list_spaces`

## Stack

Node + TypeScript · pnpm workspaces · Fastify · Drizzle · PostgreSQL + pgvector · MCP SDK · React + Vite · Vitest.

Full technical reference: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) · product [`docs/PRD.md`](./docs/PRD.md) · roadmap [`docs/ROADMAP.md`](./docs/ROADMAP.md) · runbook [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) · security [`docs/SECURITY.md`](./docs/SECURITY.md) · multi-tenant [`docs/MULTI-TENANT.md`](./docs/MULTI-TENANT.md) · Kubernetes [`docs/DEPLOY-KUBERNETES.md`](./docs/DEPLOY-KUBERNETES.md) · vs Obsidian [`COMPARISON.md`](./COMPARISON.md).

---

## 🚀 Quick start

### Option A — Guided installer (one script, all platforms)

Linux / macOS / WSL2 / Git Bash on Windows:

```bash
curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
```

On native Windows, run it from **WSL2** (Docker Desktop already uses it as its backend) or from **Git Bash**. There's no separate `install.ps1` — one installer for everything.

The wizard:

1. Detects your platform and checks prerequisites (Docker daemon, Compose v2, a free web port, ≥ 3 GB disk).
2. If Docker is missing, opens the official download page in your browser and stops (Docker on Mac/Windows can't be installed silently).
3. Offers **Install** or **Restore from a backup** (a backup carries mode, embedder, domain, secrets, and TLS cert — so restoring on a new machine asks nothing).
4. Asks where to store your data (bind-mounted to disk — it survives even if you remove the container). If a database already exists at that path, it asks whether to **reuse** it or **start fresh**.
5. Offers **local Ollama with `mxbai-embed-large:335m`** (recommended: high quality, multilingual, no keys) / Azure OpenAI / deterministic. If you pick Ollama and don't have it, it installs and warms it up for you.
6. Empty vault or a 1500-note demo seed.
7. Pulls the [`soydiloreto/diluxite`](https://hub.docker.com/r/soydiloreto/diluxite) all-in-one image + Postgres and brings the stack up. Web at http://localhost:5173.

### 🛠️ Managing your install

Re-run the installer (or pass a flag) and, since it detects an existing install, you get a **management menu** instead of the wizard:

```text
1) Update            (pull + up, same config)
2) Reconfigure       (channel, HTTPS, SSO, embedder, local↔server mode…)
3) Status / logs     (read-only: version, containers, health, notes, MCP, system)
4) Backup            (pg_dump + config + manifest + Caddy cert → .tar.gz)
5) Restore           (from a backup; bootstraps a fresh machine)
6) Uninstall         (bring the stack down, option to wipe data)
7) Seed test data    (load demo notes; pick the workspace if there are several)
8) Reconfigure HTTPS (change domain or TLS mode — ACME / internal / off)
0) Quit
```

Everything is also scriptable and non-interactive:

```bash
install.sh --status
install.sh --update
install.sh --reconfigure                    # channel, HTTPS, SSO, mode, embedder…
install.sh --reconfigure-https              # jump straight to the HTTPS submenu
install.sh --export-caddy-ca [--out file]   # export Caddy's local root CA (tls internal)
install.sh --backup [--out file.tar.gz]
install.sh --restore --in file.tar.gz      # works on a brand-new machine
install.sh --channel latest|next
install.sh --autoupdate on|off
install.sh --reset-admin                    # break-glass for server mode
install.sh --seed
install.sh --uninstall                      # bring the stack down, option to wipe data
install.sh --install-dir DIR                # non-default install location
install.sh --yes                            # non-interactive: skip confirmations
install.sh --help
```

### 🔐 Authentication modes (server mode)

By default the installer sets up **local mode** (no login, single user — perfect for your own machine). Switch to **server mode** (Reconfigure → Switch mode) for multi-user, and pick how people sign in:

| Method | What it is |
|---|---|
| **Email + password** | Admin bootstrapped from env; the password is written to the DB as a PBKDF2 hash and **scrubbed from the compose file** (no plaintext at rest). |
| **Cloudflare Access (JWT)** | The signed `Cf-Access-Jwt-Assertion` is **verified** (RS256 against your team's certs + AUD). Cryptographic trust → **no tunnel required**; a spoofed header has no valid signature. |
| **Trusted-header proxy** | Plain email header (Authelia/Pomerium). Insecure unless **all** traffic is forced through the proxy — the installer warns you. |

Switching `local → server` **promotes your existing single user to the super admin**, so you keep all your notes.

### ♻️ Auto-update (opt-in)

Auto-update is **off by default**. If you opt in, the installer first warns you it's **not recommended in production** and that Watchtower mounts the Docker socket (**full Docker access = host root**), then asks for explicit confirmation. It uses the maintained [`nickfedor/watchtower`](https://github.com/nicholas-fedor/watchtower) fork (the original `containrrr/watchtower` was archived in Dec 2025 and breaks on Docker ≥ 29).

Prefer manual updates? Just run **Update** from the menu (or `install.sh --update`) whenever you want.

### Option B — Manual Docker run / compose

```bash
docker pull soydiloreto/diluxite:latest
```

Full snippets (compose + env vars) in the [Docker Hub README](https://hub.docker.com/r/soydiloreto/diluxite).

**To scale out** (separate API and web containers — Cloud, large orgs): [`soydiloreto/diluxite-api`](https://hub.docker.com/r/soydiloreto/diluxite-api) + [`soydiloreto/diluxite-web`](https://hub.docker.com/r/soydiloreto/diluxite-web).

**For Kubernetes** (AKS / EKS / GKE / on-prem): see [`docs/DEPLOY-KUBERNETES.md`](./docs/DEPLOY-KUBERNETES.md).

### Option C — Dev mode with hot reload

Requirements: Node ≥ 24 (see [`.nvmrc`](./.nvmrc)), pnpm ≥ 10, Docker (only for Postgres + pgvector).

```bash
cp .env.example .env
pnpm install
pnpm db:up                          # docker compose up -d (db + api + web; Adminer only with --profile tools)
pnpm --filter @diluxite/api dev     # API + MCP  → http://localhost:3030
pnpm --filter @diluxite/web dev     # Web UI     → http://localhost:5173
```

---

## 🔌 Connect Claude / Copilot / Codex (MCP)

1. In the web app, go to **Settings → AI Connection (MCP)**, copy the endpoint (`http://localhost:3030/mcp`) and **generate a token**.
2. In your client (Claude, VS Code Copilot, Codex…) add a remote MCP connector with that URL (+ token if your instance requires it).
3. Your AI can now read, write, and search your memory with the ten tools above.

## 🌱 Demo data

```bash
pnpm seed              # 1500 technical notes (ADRs, runbooks, postmortems…) spanning ~3 years
RESET=1 pnpm seed      # wipe + reseed
COUNT=200 pnpm seed    # smaller corpus
```

From a running install you can also use the **Seed test data** menu option, which lets you pick the target workspace when there's more than one. Details + an MCP smoke test in [`docs/RUNBOOK.md`](./docs/RUNBOOK.md).

## 🧠 Quality embeddings (optional)

The default is **deterministic local** embeddings (no keys, ideal for tests and dev). Priority when env vars are present: **Azure OpenAI** > **Ollama (local)** > deterministic.

**Azure OpenAI** (top quality, needs an account):

```
AZURE_OPENAI_ENDPOINT=...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=text-embedding-3-large
```

**Ollama (local, 100% offline)** — requires [Ollama](https://ollama.com) running:

```
OLLAMA_EMBEDDING_MODEL=mxbai-embed-large:335m   # 1024 dims (installer default)
OLLAMA_EMBEDDING_DIMENSIONS=1024
# OLLAMA_ENDPOINT=http://localhost:11434         # optional
```

## ✅ Tests

```bash
pnpm test:unit        # 428 unit tests (core + web + api) — fast, no DB
pnpm test:int         # 335 integration tests (db + api) — needs `pnpm db:up`
pnpm test:installer   # 90 bash assertions — install.sh lifecycle, mocked docker/curl/ollama
pnpm typecheck
pnpm lint
```

**850+ tests green** at `v1.0.0-alpha.62`. CI runs unit + integration + Playwright e2e + the installer suite + lint + typecheck + CodeQL + container scans on every PR.

## 📦 Editions & license

- **Diluxite Core** (this repo) — the open-source engine. Self-hosted, single-user out of the box, server mode available. Licensed under **[AGPL-3.0](./LICENSE)**.
- **Diluxite Cloud** — the hosted, multi-tenant SaaS built on this engine (separate private repo).

Contributions welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md).

---

<div align="center">

Built by **Pablo Ariel Di Loreto** · [@soydiloreto](https://github.com/soydiloreto)
Questions, issues, ideas → [github.com/soydiloreto/diluxite-core-alpha](https://github.com/soydiloreto/diluxite-core-alpha)

</div>
