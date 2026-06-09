# Diluxite — the memory your AI uses on its own

**Self-hosted second brain for your AI assistants.** Markdown notes + hybrid search (Postgres FTS + pgvector semantic) + native MCP server, all in one container. Connect Claude / GitHub Copilot / any MCP client and they read, write, and search your notes by meaning, persisting between sessions and across tools.

- Repo · [github.com/soydiloreto/diluxite-core-alpha](https://github.com/soydiloreto/diluxite-core-alpha)
- Licence · AGPL-3.0
- Architectures · `linux/amd64`, `linux/arm64`

## What's in this image

This is the **all-in-one** build — one container running:

- Fastify API + MCP server on internal port `3030`.
- Hocuspocus WebSocket server for **real-time collaborative editing** on internal port `3031`.
- nginx on port `5173` serving the React SPA *and* reverse-proxying `/api/*`, `/mcp/*`, and `/collab` to the right internal service.

You only expose **one port** (`5173`) and get web UI, REST API, MCP, and live collaborative editing behind the same URL. Process supervision via `supervisord`. Set `DILUXITE_COLLAB_DISABLED=1` to turn collab off for single-user installs.

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

### Core

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres + pgvector connection string |
| `PORT` | `3030` | Internal API port (you don't need to change this) |

### Auth mode

| Var | Default | Purpose |
|---|---|---|
| `DILUXITE_AUTH_MODE` | `local` | `local` (passwordless single-user) or `server` (multi-user) |
| `DILUXITE_ADMIN_EMAIL` | — | Bootstrap admin in server mode |
| `DILUXITE_ADMIN_PASSWORD` | — | Applied once on first boot, then scrubbed |

### Auth backends (server mode, all opt-in via env)

| Var | Default | Purpose |
|---|---|---|
| `DILUXITE_OIDC_ISSUER` / `DILUXITE_OIDC_CLIENT_ID` / `DILUXITE_OIDC_CLIENT_SECRET` / `DILUXITE_OIDC_REDIRECT_URI` | — | OIDC SSO (Entra / Okta / Google / Authentik) |
| `DILUXITE_CF_ACCESS_TEAM_DOMAIN` / `DILUXITE_CF_ACCESS_AUD` | — | Cloudflare Access JWT (signature-verified) |
| `DILUXITE_TRUSTED_IDENTITY_HEADER` | — | Plaintext identity header from a reverse proxy. **INSECURE unless ALL traffic is forced through the proxy** |

### Embeddings (priority: Azure > Ollama > deterministic)

| Var | Default | Purpose |
|---|---|---|
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_DEPLOYMENT` / `EMBEDDING_DIMENSIONS` | — | If all four set → Azure OpenAI |
| `OLLAMA_EMBEDDING_MODEL` | — | e.g. `mxbai-embed-large:335m` (recommended) |
| `OLLAMA_EMBEDDING_DIMENSIONS` | — | dim count for the model (mxbai = `1024`, nomic = `768`) |
| `OLLAMA_ENDPOINT` | `http://localhost:11434` | Ollama daemon URL (use `host.docker.internal` from inside Docker) |

### Collab (Yjs + Hocuspocus)

| Var | Default | Purpose |
|---|---|---|
| `DILUXITE_COLLAB_PUBLIC_URL` | — | Override the WS URL when behind a custom proxy (e.g. `wss://diluxite.acme.com/collab`) |
| `DILUXITE_COLLAB_DISABLED` | — | Set to `1` to turn collab off (falls back to DB-only edits) |

### Email / SMTP (forgot-password reset; future SSO invites + audit alerts)

| Var | Default | Purpose |
|---|---|---|
| `DILUXITE_SMTP_HOST` | — | Set to enable SMTP; otherwise a Noop provider logs to stdout |
| `DILUXITE_SMTP_PORT` | `587` | `465` for TLS-on-connect |
| `DILUXITE_SMTP_USER` / `DILUXITE_SMTP_PASS` | — | If the server requires AUTH |
| `DILUXITE_SMTP_SECURE` | — | `1` = TLS on connect |
| `DILUXITE_SMTP_FROM` | `noreply@diluxite.local` | From address |
| `DILUXITE_PUBLIC_WEB_URL` | — | Used to build the reset link in the email body |

### Operational

| Var | Default | Purpose |
|---|---|---|
| `DILUXITE_AUDIT_RETENTION_DAYS` | — (never expires) | Append-only audit log retention. Set to e.g. `365` to keep one year |
| `DILUXITE_HELMET_DISABLED` | — | Set to `1` to opt-out of security headers |
| `DILUXITE_CSRF_DISABLED` | — | Set to `1` to opt-out of the CSRF double-submit check |
| `DILUXITE_RATE_LIMIT_DISABLED` | — | Set to `1` to opt-out of rate-limit on auth endpoints |

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

If you installed via the guided installer, just run `install.sh --update` (or pick **Update** from its management menu).

Automatic updates are **opt-in** (Watchtower, behind the `autoupdate` profile). It mounts the Docker socket — i.e. full Docker access (= host root) — so the installer warns you and asks for explicit confirmation before enabling it. The image used is the maintained [`nickfedor/watchtower`](https://github.com/nicholas-fedor/watchtower) fork (the original `containrrr/watchtower` was archived in Dec 2025 and breaks on Docker ≥ 29). Not recommended in production.

## Backup

Stop the stack, copy your data directory (the bind-mount path you chose at install time, default `~/diluxite/data`), restart. That's the whole backup.

## Connect Claude / Copilot via MCP

In the web UI: **Settings → MCP Connection** → copy the endpoint (`http://localhost:5173/mcp`) and generate a token. Configure your MCP client (Claude / Copilot) with that URL + token. Your AI now reads, writes, and searches your memory.
