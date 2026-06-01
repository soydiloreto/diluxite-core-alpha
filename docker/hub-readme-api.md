# Diluxite API + MCP + Collab

**Backend of [Diluxite](https://github.com/soydiloreto/diluxite-core-alpha) — the self-hosted memory for your AI.** Fastify REST API + native MCP server + Hocuspocus WebSocket for real-time collaborative editing, on a single container. Reads/writes Postgres + pgvector for hybrid (FTS + semantic) search.

- Repo · [github.com/soydiloreto/diluxite-core-alpha](https://github.com/soydiloreto/diluxite-core-alpha)
- Licence · AGPL-3.0
- Architectures · `linux/amd64`, `linux/arm64`

## Ports

- `3030` — REST + MCP (HTTP).
- `3031` — Hocuspocus WebSocket (collaborative editing). Disable with `DILUXITE_COLLAB_DISABLED=1`.

## When to use this image

You probably want the **all-in-one** ([`soydiloreto/diluxite`](https://hub.docker.com/r/soydiloreto/diluxite)) instead — that bundles API + web in one container and is the simpler default.

This separated image is for when you need to scale the API independently of the web tier: multiple API replicas behind a load balancer, web served from a CDN, etc. Typical of Cloud / multi-tenant deployments. Pair it with [`soydiloreto/diluxite-web`](https://hub.docker.com/r/soydiloreto/diluxite-web).

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

  api:
    image: soydiloreto/diluxite-api:latest
    restart: unless-stopped
    depends_on:
      db: { condition: service_healthy }
    ports:
      - "3030:3030"
    environment:
      DATABASE_URL: postgres://diluxite:diluxite@db:5432/diluxite

  web:
    image: soydiloreto/diluxite-web:latest
    restart: unless-stopped
    depends_on: [api]
    ports:
      - "5173:5173"
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres + pgvector connection string |
| `PORT` | `3030` | Listen port |
| `OLLAMA_EMBEDDING_MODEL` | — | e.g. `mxbai-embed-large:335m` |
| `OLLAMA_EMBEDDING_DIMENSIONS` | — | dim count (mxbai = `1024`) |
| `OLLAMA_ENDPOINT` | `http://localhost:11434` | Ollama daemon URL |
| `AZURE_OPENAI_ENDPOINT` | — | If using Azure OpenAI |
| `AZURE_OPENAI_API_KEY` | — | If using Azure OpenAI |
| `AZURE_OPENAI_DEPLOYMENT` | — | If using Azure OpenAI |

## Tags

`X.Y.Z` · `X.Y` · `latest` · `next` (pre-releases) · `X.Y.Z-(alpha|beta|rc).N`. See the [all-in-one image](https://hub.docker.com/r/soydiloreto/diluxite) for the full tagging policy.

## Endpoints

- REST: `/api/*` (notes, folders, spaces, tags, search, tokens, ...)
- MCP: `/mcp` (Streamable HTTP, stateful by `Mcp-Session-Id`)
- Health: `/health` (cheap) · `/health/db` (touches DB)
- Update check: `/api/update/check` (compares running version vs latest GitHub release)
