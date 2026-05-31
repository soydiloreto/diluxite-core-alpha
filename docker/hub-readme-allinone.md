# Diluxite — la memoria de tu IA

**Self-hosted second brain for your AI assistants.** Markdown notes + hybrid search (Postgres FTS + pgvector semantic) + native MCP server, all in one container. Connect Claude / GitHub Copilot / any MCP client and they read, write, and search your notes by meaning, persisting between sessions and across tools.

- Repo · [github.com/soydiloreto/diluxite-core-alpha](https://github.com/soydiloreto/diluxite-core-alpha)
- Licence · AGPL-3.0
- Architectures · `linux/amd64`, `linux/arm64`

## What's in this image

This is the **all-in-one** build — one container running:

- Fastify API + MCP server on internal port `3030`.
- nginx on port `5173` serving the React SPA *and* reverse-proxying `/api/*` and `/mcp/*` to the API.

You only expose **one port** (`5173`) and get web UI, REST API, and MCP all behind the same URL. Process supervision via `supervisord`.

Need to scale API replicas independently of the web tier (Cloud, large orgs)? Use the separated images instead: [`soydiloreto/diluxite-api`](https://hub.docker.com/r/soydiloreto/diluxite-api) + [`soydiloreto/diluxite-web`](https://hub.docker.com/r/soydiloreto/diluxite-web).

## Quick start (guided installer — recommended)

Linux / macOS / WSL2 / Git Bash on Windows:

```bash
curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
```

The installer detects your platform, validates prerequisites (Docker daemon, Compose v2, free ports, disk), offers to install Ollama for you, pulls `mxbai-embed-large:335m`, generates a `docker-compose.yml`, and brings the stack up. Open `http://localhost:5173`.

## Quick start (compose, copy-paste)

```yaml
services:
  db:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    environment:
      POSTGRES_USER: diluxite
      POSTGRES_PASSWORD: diluxite
      POSTGRES_DB: diluxite
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U diluxite -d diluxite"]
      interval: 5s

  diluxite:
    image: soydiloreto/diluxite:latest
    restart: unless-stopped
    depends_on:
      db: { condition: service_healthy }
    ports:
      - "5173:5173"
    environment:
      DATABASE_URL: postgres://diluxite:diluxite@db:5432/diluxite
      # Optional — local Ollama embeddings (high quality, no keys):
      # OLLAMA_EMBEDDING_MODEL: mxbai-embed-large:335m
      # OLLAMA_EMBEDDING_DIMENSIONS: "1024"
      # OLLAMA_ENDPOINT: http://host.docker.internal:11434
```

```bash
docker compose up -d
# Web → http://localhost:5173
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres + pgvector connection string |
| `PORT` | `3030` | Internal API port (you don't need to change this) |
| `OLLAMA_EMBEDDING_MODEL` | — | e.g. `mxbai-embed-large:335m` (recommended) |
| `OLLAMA_EMBEDDING_DIMENSIONS` | — | dim count for the model (mxbai = `1024`, nomic = `768`) |
| `OLLAMA_ENDPOINT` | `http://localhost:11434` | Ollama daemon URL (use `host.docker.internal` from inside Docker) |
| `AZURE_OPENAI_ENDPOINT` | — | If using Azure OpenAI |
| `AZURE_OPENAI_API_KEY` | — | If using Azure OpenAI |
| `AZURE_OPENAI_DEPLOYMENT` | — | If using Azure OpenAI |

Provider selection priority: **Azure** (if all three set) → **Ollama** (if model + dims set) → **deterministic** (fallback, for testing only).

## Tags

| Tag | Stability | Use when |
|---|---|---|
| `X.Y.Z` (e.g. `1.0.0`) | Exact pin | You want zero surprises in production |
| `X.Y` (e.g. `1.0`) | Auto-update on patch | You want bugfixes but no minor changes |
| `latest` | Latest stable | You want every release |
| `next` | Latest pre-release | You're tracking alphas / betas |
| `X.Y.Z-alpha.N` etc. | Exact pre-release | Reproducible pre-release |

## Updating

The web UI shows a banner when a new release is published. From your install directory:

```bash
docker compose pull && docker compose up -d
```

For automatic updates via [Watchtower](https://containrrr.dev/watchtower/), opt-in by adding the `autoupdate` profile (the installer's `docker-compose.template.yml` includes it pre-configured with `--label-enable`).

## Backup

Stop the stack, copy your data directory (the bind-mount path you chose at install time, default `~/diluxite/data`), restart. That's the whole backup.

## Connect Claude / Copilot via MCP

In the web UI: **Settings → MCP Connection** → copy the endpoint (`http://localhost:5173/mcp`) and generate a token. Configure your MCP client (Claude / Copilot) with that URL + token. Your AI now reads, writes, and searches your memory.
