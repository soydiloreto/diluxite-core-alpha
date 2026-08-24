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
7. **Auto-update** (default **No** — opt-in with double warning since alpha.47: not for production + Docker socket grants host root). If you enable it: rolling tag `:next`/`:latest` + the maintained `nickfedor/watchtower` fork checks every 6 h. If you decline: pinned tag + a yellow banner in the UI notifies you when there's a new version.
8. **Mode**: `local` (single-user passwordless, ideal for a personal PC) or `server` (multi-user). If server:
   - Email + password of the initial admin.
   - Optional: **HTTPS Caddy sidecar** with automatic ACME (Let's Encrypt) — you provide a domain and TLS gets terminated on `:443`.
   - Optional: **OIDC SSO** (Entra / Okta / Google / Authentik) — you provide issuer / client_id / client_secret / redirect_uri.
   - Optional: **Cloudflare Access JWT** (signature-verified, alpha.49+) — you provide the team domain + application AUD; Diluxite verifies the signed `Cf-Access-Jwt-Assertion` header against CF's public keys (RS256). Secure even without a tunnel — a spoofed header has no valid signature.
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
pnpm db:up                       # docker compose up -d (db + api + web; Adminer only with --profile tools)
pnpm --filter @diluxite/api dev  # API + MCP en :3030 (tsx watch)
pnpm --filter @diluxite/web dev  # Vite en :5173 (HMR)
```

> Heads up: if you also have the Docker instance (`:next`) running, port 5173 is taken. Bring it down with `cd ~/diluxite && docker compose down` first.

Tests:
```bash
pnpm test:unit         # 428 tests (no DB)
pnpm test:int          # 335 tests (needs `pnpm db:up`)
pnpm test:installer    # 90 bash assertions (mocked docker/curl/ollama)
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

**If you opted in to auto-update:**
- `nickfedor/watchtower` (maintained fork — the archived `containrrr/watchtower` crash-loops on Docker ≥ 29) polls Docker Hub every 6 h and reconciles only the containers labeled `com.centurylinklabs.watchtower.enable=true` (does NOT touch others on the host).
- To force an update without waiting:
  ```bash
  cd ~/diluxite
  docker compose pull && docker compose up -d
  ```
- To see activity: `docker logs -f diluxite-watchtower`.

**If you chose not to auto-update (the default since alpha.47):**
- The compose pins the exact version (e.g. `:X.Y.Z`).
- A yellow banner in the UI notifies you when a new version is available. You run:
  ```bash
  cd ~/diluxite
  docker compose pull && docker compose up -d
  ```
- To enable Watchtower later without reinstalling:
  ```bash
  docker compose --profile autoupdate up -d
  ```
  (And you edit the compose to change the pinned `:X.Y.Z` tag → `:next` or `:latest` — pinned tags don't receive rolling updates.)

More detail in the [README](../README.md#%EF%B8%8F-auto-update-opt-in).

## Connecting Claude / Copilot via MCP

1. In the web app → **Activity Bar → Settings (⚙) → AI Connection (MCP)**.
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
5. Ask your AI to use `search_memory`, `write_note`, `read_note`, etc. (15 tools available — all in English since v4.0). Folders are addressed by path: `write_note` takes an optional `folder` like `Dailies/2026-08`, and `list_folders` / `move_note` / `delete_folder` manage the hierarchy.

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
node scripts/test-mcp.mjs   # ejercita las tools + imprime latencias
```

## Backup / restore

The installer ships a full backup/restore flow since alpha.46 — **use it instead of raw `pg_dump`**. The manifest carries mode/embedder/domain/secrets + the Caddy TLS cert, and `--restore` can bootstrap a fresh machine end-to-end (it installs Ollama, pulls the model, runs the same healthcheck + summary as a fresh install).

```bash
# Re-run the installer; pick "Backup" from the menu, or non-interactive:
~/diluxite/install.sh --backup --out diluxite-$(date +%F).tar

# Restore onto the same or a different machine:
~/diluxite/install.sh --restore --in diluxite-2026-06-08.tar
```

If you want the raw Postgres dump (for ad-hoc inspection, point-in-time recovery, etc.):

```bash
docker exec diluxite-db pg_dump -U diluxite -d diluxite -Fc -f /tmp/dump.dump
docker cp diluxite-db:/tmp/dump.dump ./diluxite-pg-$(date +%F).dump

# Restore:
docker cp ./diluxite-pg-2026-06-08.dump diluxite-db:/tmp/dump.dump
docker exec diluxite-db pg_restore -U diluxite -d diluxite --clean --if-exists /tmp/dump.dump
```

> **Important**: the `~/diluxite/data/postgres/` bind-mount is already persistent across container restarts. The backup is for disaster recovery or migration between machines.

## Manage an existing install (alpha.45+)

Re-running `install.sh` on a machine that already has Diluxite shows a **management menu**: update / reconfigure / status / backup / restore / uninstall / seed test data. Non-interactive flags are also available (run `install.sh --help` for the full list). State is persisted in `~/diluxite/.diluxite-install.env` (no secrets — those stay in the compose file).

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

## HTTPS modes & troubleshooting (alpha.62+)

The installer supports two TLS modes for the Caddy sidecar. The wizard picks
one for you based on whether your domain is publicly resolvable; you can
switch at any time with `install.sh --reconfigure-https` (or menu item 8).

### When to use each mode

| Mode | When | Browser warning? |
|---|---|---|
| **ACME** (default) | Public domain resolvable in DNS — Let's Encrypt can validate via HTTP-01. Production. | No |
| **`tls internal`** | Private / fake / test domains, `/etc/hosts` overrides, air-gapped, staging without DNS. Caddy generates its own local CA. | Yes — until you import the CA into your OS keychain (one-time) |

### Recovering from "tlsv1 alert internal error" (the silent ACME-failed case)

If the browser shows a TLS error when opening `https://your.domain`:

1. **Look at the Caddy log first**: `docker logs diluxite-caddy | tail -50`. ACME failures show up clearly (`NXDOMAIN`, `urn:ietf:params:acme:error:dns`, etc.).
2. **If ACME failed because the domain doesn't resolve publicly**: switch to `tls internal` mode:
   ```bash
   install.sh --reconfigure-https
   # Choose option 2 (local Caddy CA)
   ```
3. **Extract the Caddy local CA + import it to your OS keychain** so the browser stops warning:
   ```bash
   install.sh --export-caddy-ca --out ~/diluxite-caddy-ca.crt
   # macOS: double-click the .crt → Add to login keychain → trust 'Always'
   # Linux: sudo cp .../diluxite-caddy-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
   ```
4. **Open `https://your.domain`** — browser should now load without warnings.

### Switching back to ACME later (when DNS is ready)

```bash
install.sh --reconfigure-https
# Choose option 1 (ACME)
# The installer revalidates DNS before committing — if it still doesn't
# resolve, you get the 3-option menu again.
```

### `/etc/hosts` workflow for fake-domain testing (alpha.62 emulates this)

```bash
# Add the entry (needs sudo)
echo "127.0.0.1 ite.diluxone.com" | sudo tee -a /etc/hosts

# Install Diluxite with HTTPS for that fake domain
curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
# When the wizard asks for HTTPS domain: ite.diluxone.com
# Pre-flight detects NXDOMAIN → picks "tls internal" from the 3-option menu

# After install, trust the cert
install.sh --export-caddy-ca --out ~/caddy.crt
open ~/caddy.crt   # macOS: import to keychain, set trust to Always
```

## Troubleshooting

| Symptom | What to check |
|---|---|
| Vite won't start / port 5173 taken | `lsof -i :5173` and kill the process, or change the port in `apps/web/vite.config.ts` |
| Postgres won't start / corrupted data | `docker compose down -v && docker compose up` (⚠️ deletes data) |
| Migrations fail | `docker compose logs -f diluxite` — the API runs `runMigrations()` at boot. Look at the first error. |
| MCP returns 401 | The token is per user; regenerate from Settings → AI Connection (MCP). |
| Watchtower doesn't update | The image tag in the compose must be rolling (`:next` or `:latest`), not pinned (`:X.Y.Z`). Watchtower does NOT update pinned tags. |
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
