# Diluxite — Runbook

How to run Diluxite in different environments and operate it day to day.

## Option A — Guided installer (recommended for 99% of users)

Mac / Linux / WSL2 / Git Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
```

Interactive wizard (9 steps, EN/ES/PT):

1. Wizard **language**.
2. **Validation** of the Docker daemon + Compose v2 + free ports + ≥ 3 GB disk.
3. **Data folder** (bind-mount to disk — not lost when the container is deleted).
4. **Embedder**: local Ollama (recommended, `mxbai-embed-large:335m`, 669 MB) / Azure OpenAI / deterministic. If you choose Ollama and don't have it, it gets installed automatically.
5. **Seed**: empty vault or 1500 demo notes.
6. **Channel**: `latest` (stable) or `next` (alpha/beta/rc).
7. **Auto-update** (default Yes): if Yes, rolling tag `:next`/`:latest` + Watchtower checks every 6 h. If No, pinned tag + a yellow banner notifies you.
8. **Mode**: `local` (single-user passwordless, ideal for a personal PC) or `server` (multi-user with email+password). If server:
   - Email + password of the initial admin.
   - Optional: **HTTPS Caddy sidecar** with automatic ACME (Let's Encrypt) — you provide a domain and TLS gets terminated on `:443`.
   - Optional: **OIDC SSO** (Entra / Okta / Google / Authentik) — you provide issuer / client_id / client_secret / redirect_uri.
   - Optional: **Trusted-header proxy** (Cloudflare Access / Authelia / Pomerium) — you provide the header name.
9. **Pull + boot** of the stack and healthcheck. Web → `http://localhost:5173` (or `https://<domain>` if you configured HTTPS).

Default installation folder: `~/diluxite/`. Generated compose: `~/diluxite/docker-compose.yml`.

## Option B — Manual Docker compose

If you prefer to start from your own compose:

```bash
docker pull soydiloreto/diluxite:next   # or :latest for stable
```

Complete snippets (compose + env vars) in the [Docker Hub README](https://hub.docker.com/r/soydiloreto/diluxite). The 3 available images:

- `soydiloreto/diluxite` — all-in-one (api + nginx + static web + collab WS). Recommended for single-machine.
- `soydiloreto/diluxite-api` + `soydiloreto/diluxite-web` — separated for K8s or large orgs.

## Option C — Dev mode (no Docker, hot reload)

Requirements: Node ≥ 24, pnpm ≥ 10, Docker (only for Postgres + pgvector).

```bash
git clone https://github.com/soydiloreto/diluxite-core-alpha.git
cd diluxite-core-alpha
cp .env.example .env             # editar si querés cambiar DATABASE_URL / PORT
pnpm install
pnpm db:up                       # Postgres + pgvector via Docker
pnpm --filter @diluxite/api dev  # API + MCP en :3030 (tsx watch)
pnpm --filter @diluxite/web dev  # Vite en :5173 (HMR)
```

> Heads up: if you also have the Docker instance (`:next`) running, port 5173 is taken. Bring it down with `cd ~/diluxite && docker compose down` first.

Tests:
```bash
pnpm test:unit         # 316 tests (sin DB)
pnpm test:int          # 273 tests (necesita pnpm db:up arriba)
pnpm typecheck         # 4 packages
pnpm lint              # eslint --max-warnings=0
```

## Adminer (DB admin)

```bash
docker compose --profile tools up adminer    # → http://localhost:8080
```

Server: `db` (internal) or `host.docker.internal` (Mac/Win) / `172.17.0.1` (Linux native). User/pass/db: `diluxite`.

## Updating

The behavior depends on what you chose in Step 7 of the wizard.

**If you chose auto-update (default Yes):**
- Watchtower polls Docker Hub every 6 h and reconciles only the containers with the label `com.centurylinklabs.watchtower.enable=true` (it does NOT touch others on the host).
- To force an update without waiting:
  ```bash
  cd ~/diluxite
  docker compose pull && docker compose up -d
  ```
- To see activity: `docker logs -f diluxite-watchtower`.

**If you chose not to auto-update:**
- The compose pins the exact version (e.g. `:1.0.0-alpha.40`).
- A yellow banner in the UI notifies you when a new version is available. You run:
  ```bash
  cd ~/diluxite
  docker compose pull && docker compose up -d
  ```
- To enable Watchtower later without reinstalling:
  ```bash
  docker compose --profile autoupdate up -d
  ```
  (And you edit the compose to change `:1.0.0-alpha.40` → `:next` or `:latest` — pinned tags don't receive rolling updates.)

More detail in the [README](../README.md#actualizar).

## Connecting Claude / Copilot via MCP

1. In the web app → **Activity Bar → Settings (⚙) → MCP connection**.
2. Copy the MCP endpoint URL (`http://localhost:5173/mcp` by default when going through nginx, or `http://localhost:3030/mcp` in dev mode).
3. Generate a token ("Generate" button). Copy it (it won't be shown again).
4. In Claude Desktop / Code, add a remote MCP connector:
   ```json
   {
     "mcpServers": {
       "diluxite": {
         "url": "http://localhost:5173/mcp",
         "headers": { "Authorization": "Bearer TU_TOKEN" }
       }
     }
   }
   ```
5. Ask your AI to use `search_memory`, `write_note`, `read_note`, etc. (10 tools available — all in English since v4.0).

## Collaborative editing (alpha.10+)

Diluxite has real-time collab with Yjs + Hocuspocus. When two browsers open the same note, their cursors sync live with awareness/presence. It works out of the box on single-machine via nginx routing `/collab` → internal port `:3031`.

To deploy behind a custom reverse proxy (e.g. your own Caddy/nginx):
- Make sure the `/collab` path performs a WS upgrade toward the Diluxite container on its internal WS port.
- If the browser URL is different from the API's, export `DILUXITE_COLLAB_PUBLIC_URL=wss://diluxite.tu-empresa.com/collab` in the container.

To disable collab (return to "DB-only edits, no presence" mode):
```yaml
environment:
  DILUXITE_COLLAB_DISABLED: "1"
```

## Seed: 1500 demo notes

For demos, screenshots, or stress-testing search / graph, the repo ships a deterministic seed that populates the active workspace with a realistic technical corpus (ADRs, runbooks, postmortems, cheatsheets…) spread over ~3 years, with folders, tags, wikilinks, and ~10% favorites.

```bash
pnpm seed                # 1500 notas, RNG seed = 42
COUNT=500 pnpm seed      # otro total
SEED=7 pnpm seed         # otro corpus (sigue siendo determinista)
RESET=1 pnpm seed        # wipe chunks/notes/folders/tags/links antes
```

The seed goes through the same `SearchService.index()` path the API uses on every save, so `chunks` (vectors) ends up populated and `search_memory` via MCP returns results right away.

Smoke-test MCP:
```bash
curl -sS -X POST http://localhost:5173/api/tokens \
  -H 'content-type: application/json' \
  -d '{"name":"smoketest"}' | jq -r .token > /tmp/mcp.token
node scripts/test-mcp.mjs   # ejercita las 10 tools + imprime latencias
```

## Backup / restore

Today: manual with `pg_dump`. A native CLI (`diluxite backup --out file.tar`) is on the roadmap.

```bash
# dump (incluye notes, yjs_state, audit_events, sessions, etc.)
docker exec diluxite-db pg_dump -U diluxite -d diluxite -Fc -f /tmp/dump.dump
docker cp diluxite-db:/tmp/dump.dump ./diluxite-$(date +%F).dump

# restore
docker cp ./diluxite-2026-06-02.dump diluxite-db:/tmp/dump.dump
docker exec diluxite-db pg_restore -U diluxite -d diluxite --clean --if-exists /tmp/dump.dump
```

> **Important**: the `~/diluxite/data/postgres/` bind-mount is already persistent across container restarts. The backup is for disaster recovery or migration between machines.

## Day-to-day operation

### Audit log (server mode)

Admin Console → Audit. Filters by action / actor / date / IP. Events: `auth.login.success/failed`, `auth.password.changed`, `admin.user.role_changed`, `admin.token.revoked_all`, `admin.session.revoked`, OIDC sign-in, passkey register/revoke.

Retention configurable via env var in the compose:
```yaml
environment:
  DILUXITE_AUDIT_RETENTION_DAYS: "365"   # 0/unset = no expira nunca
```

### Active sessions

Settings → Sessions: list of connected devices with IP + User-Agent + last-seen. Click "Revoke" for an individual one, "Sign out of all other devices" for a mass reset.

### Password change

Settings → Sessions → section above the table. A password change **invalidates all sessions except the current one** automatically (forced sign-out on other devices).

### 2FA (TOTP)

Settings → Two-factor authentication. Enroll generates a QR + secret, 6-digit confirmation, then backup codes. Compatible with Google Authenticator, Authy, 1Password, etc.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Vite won't start / port 5173 taken | `lsof -i :5173` and kill the process, or change the port in `apps/web/vite.config.ts` |
| Postgres won't start / corrupted data | `docker compose down -v && docker compose up` (⚠️ deletes data) |
| Migrations fail | `docker compose logs -f diluxite` — the API runs `runMigrations()` at boot. Look at the first error. |
| MCP returns 401 | The token is per user; regenerate from Settings → MCP connection. |
| Watchtower doesn't update | The image tag in the compose must be rolling (`:next` or `:latest`), not pinned (`:1.0.0-alpha.40`). Watchtower does NOT update pinned tags. |
| `/collab` won't connect (browser console: WS error) | If you're behind a reverse proxy, configure `DILUXITE_COLLAB_PUBLIC_URL=wss://...`. In nginx: `proxy_set_header Upgrade $http_upgrade` + `proxy_set_header Connection "upgrade"`. |
| OIDC callback fails with "invalid redirect" | The `DILUXITE_OIDC_REDIRECT_URI` must match exactly the redirect configured in the IdP (case-sensitive + trailing slash matters). |
| HTTPS Caddy can't obtain a cert | Caddy needs ports 80 and 443 reachable from the internet for the ACME HTTP-01 challenge. If you're behind NAT, open a port-forward for 80/443. |

## Where to go next

- Product and decisions: [`PRD.md`](./PRD.md)
- Full technical stack: [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- Roadmap + pending items: [`ROADMAP.md`](./ROADMAP.md)
- Multi-tenant + RLS: [`MULTI-TENANT.md`](./MULTI-TENANT.md)
- Security model: [`SECURITY.md`](./SECURITY.md)
- Frontend conventions: [`PATTERNS.md`](./PATTERNS.md)
- Kubernetes deployment: [`DEPLOY-KUBERNETES.md`](./DEPLOY-KUBERNETES.md)
