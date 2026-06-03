# Diluxite — Runbook

Cómo correr Diluxite en distintos entornos y operarlo día a día.

## Opción A — Installer guiado (recomendado para 99% de los users)

Mac / Linux / WSL2 / Git Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
```

Wizard interactivo (9 steps, EN/ES/PT):

1. **Idioma** del wizard.
2. **Validación** de Docker daemon + Compose v2 + puertos libres + ≥ 3 GB disco.
3. **Carpeta de datos** (bind-mount al disco — no se pierde al borrar el container).
4. **Embedder**: Ollama local (recomendado, `mxbai-embed-large:335m`, 669 MB) / Azure OpenAI / determinista. Si elegís Ollama y no lo tenés, te lo instala automático.
5. **Seed**: vault vacío o 1500 notas demo.
6. **Channel**: `latest` (estable) o `next` (alpha/beta/rc).
7. **Auto-update** (default Yes): si Sí, tag rolling `:next`/`:latest` + Watchtower revisa cada 6 h. Si No, tag pin + banner amarillo te avisa.
8. **Modo**: `local` (single-user passwordless, ideal PC personal) o `server` (multi-user con email+password). Si server:
   - Email + password del admin inicial.
   - Opcional: **HTTPS Caddy sidecar** con ACME (Let's Encrypt) automático — pedís domain y queda terminating TLS en `:443`.
   - Opcional: **OIDC SSO** (Entra / Okta / Google / Authentik) — pedís issuer / client_id / client_secret / redirect_uri.
   - Opcional: **Trusted-header proxy** (Cloudflare Access / Authelia / Pomerium) — pedís nombre del header.
9. **Pull + boot** del stack y healthcheck. Web → `http://localhost:5173` (o `https://<domain>` si configuraste HTTPS).

Carpeta de instalación default: `~/diluxite/`. Compose generado: `~/diluxite/docker-compose.yml`.

## Opción B — Docker compose manual

Si preferís partir de tu propio compose:

```bash
docker pull soydiloreto/diluxite:next   # o :latest para estable
```

Snippets completos (compose + env vars) en el [README de Docker Hub](https://hub.docker.com/r/soydiloreto/diluxite). Las 3 imágenes disponibles:

- `soydiloreto/diluxite` — all-in-one (api + nginx + web estática + collab WS). Recomendado single-machine.
- `soydiloreto/diluxite-api` + `soydiloreto/diluxite-web` — separados para K8s u orgs grandes.

## Opción C — Dev mode (sin Docker, hot reload)

Requisitos: Node ≥ 24, pnpm ≥ 10, Docker (solo para Postgres + pgvector).

```bash
git clone https://github.com/soydiloreto/diluxite-core-alpha.git
cd diluxite-core-alpha
cp .env.example .env             # editar si querés cambiar DATABASE_URL / PORT
pnpm install
pnpm db:up                       # Postgres + pgvector via Docker
pnpm --filter @diluxite/api dev  # API + MCP en :3030 (tsx watch)
pnpm --filter @diluxite/web dev  # Vite en :5173 (HMR)
```

> Ojo: si tenés la instancia Docker (`:next`) también corriendo, el puerto 5173 está ocupado. Bajala con `cd ~/diluxite && docker compose down` antes.

Tests:
```bash
pnpm test:unit         # 316 tests (sin DB)
pnpm test:int          # 273 tests (necesita pnpm db:up arriba)
pnpm typecheck         # 4 packages
pnpm lint              # eslint --max-warnings=0
```

## Adminer (admin de DB)

```bash
docker compose --profile tools up adminer    # → http://localhost:8080
```

Server: `db` (interno) o `host.docker.internal` (Mac/Win) / `172.17.0.1` (Linux native). User/pass/db: `diluxite`.

## Actualizar

El comportamiento depende de lo que elegiste en el Step 7 del wizard.

**Si elegiste auto-update (default Yes):**
- Watchtower polea Docker Hub cada 6 h y reconcilia solo los containers con label `com.centurylinklabs.watchtower.enable=true` (NO toca otros del host).
- Para forzar update sin esperar:
  ```bash
  cd ~/diluxite
  docker compose pull && docker compose up -d
  ```
- Para ver actividad: `docker logs -f diluxite-watchtower`.

**Si elegiste no auto-update:**
- El compose pinea la versión exacta (ej `:1.0.0-alpha.40`).
- Banner amarillo en la UI avisa cuando hay versión nueva. Corrés:
  ```bash
  cd ~/diluxite
  docker compose pull && docker compose up -d
  ```
- Para activar Watchtower después sin reinstalar:
  ```bash
  docker compose --profile autoupdate up -d
  ```
  (Y editás el compose para cambiar `:1.0.0-alpha.40` → `:next` o `:latest` — los tags pin no reciben rolling updates.)

Más detalle en el [README](../README.md#actualizar).

## Conectar Claude / Copilot vía MCP

1. En la web → **Activity Bar → Settings (⚙) → MCP connection**.
2. Copiá la URL del endpoint MCP (`http://localhost:5173/mcp` por defecto cuando vas vía nginx, o `http://localhost:3030/mcp` en dev mode).
3. Generá un token (botón "Generar"). Copialo (no se vuelve a mostrar).
4. En Claude Desktop / Code, agregá conector MCP remoto:
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
5. Pedile a tu IA que use `search_memory`, `write_note`, `read_note`, etc. (10 tools disponibles — todas en inglés desde v4.0).

## Edición colaborativa (alpha.10+)

Diluxite tiene collab real-time con Yjs + Hocuspocus. Cuando dos browsers abren la misma nota, sus cursores se sincronizan en vivo con awareness/presencia. Funciona "out of the box" en single-machine vía nginx ruteando `/collab` → puerto interno `:3031`.

Para deploy detrás de un reverse proxy custom (ej. Caddy/nginx propio):
- Asegurate que el path `/collab` haga upgrade WS hacia el container Diluxite en su puerto WS interno.
- Si la URL del browser es distinta a la del API, exportá `DILUXITE_COLLAB_PUBLIC_URL=wss://diluxite.tu-empresa.com/collab` en el container.

Para desactivar collab (volver al modo "DB-only edits, sin presencia"):
```yaml
environment:
  DILUXITE_COLLAB_DISABLED: "1"
```

## Seed: 1500 demo notes

Para demos, screenshots o stress-test de búsqueda / grafo, el repo trae un seed determinista que puebla el workspace activo con un corpus técnico realista (ADRs, runbooks, postmortems, cheatsheets…) distribuido en ~3 años, con carpetas, tags, wikilinks y ~10% favoritas.

```bash
pnpm seed                # 1500 notas, RNG seed = 42
COUNT=500 pnpm seed      # otro total
SEED=7 pnpm seed         # otro corpus (sigue siendo determinista)
RESET=1 pnpm seed        # wipe chunks/notes/folders/tags/links antes
```

El seed pasa por el mismo `SearchService.index()` path que usa la API en cada save, así que `chunks` (vectores) queda poblado y `search_memory` por MCP devuelve resultados de una.

Smoke-test MCP:
```bash
curl -sS -X POST http://localhost:5173/api/tokens \
  -H 'content-type: application/json' \
  -d '{"name":"smoketest"}' | jq -r .token > /tmp/mcp.token
node scripts/test-mcp.mjs   # ejercita las 10 tools + imprime latencias
```

## Backup / restore

Hoy: manual con `pg_dump`. CLI nativo (`diluxite backup --out file.tar`) está en roadmap.

```bash
# dump (incluye notes, yjs_state, audit_events, sessions, etc.)
docker exec diluxite-db pg_dump -U diluxite -d diluxite -Fc -f /tmp/dump.dump
docker cp diluxite-db:/tmp/dump.dump ./diluxite-$(date +%F).dump

# restore
docker cp ./diluxite-2026-06-02.dump diluxite-db:/tmp/dump.dump
docker exec diluxite-db pg_restore -U diluxite -d diluxite --clean --if-exists /tmp/dump.dump
```

> **Importante**: el bind-mount `~/diluxite/data/postgres/` ya es persistente entre restarts del container. El backup es para disaster recovery o migración entre máquinas.

## Operación day-to-day

### Audit log (server mode)

Admin Console → Audit. Filtros por action / actor / fecha / IP. Eventos: `auth.login.success/failed`, `auth.password.changed`, `admin.user.role_changed`, `admin.token.revoked_all`, `admin.session.revoked`, OIDC sign-in, passkey register/revoke.

Retention configurable via env var en el compose:
```yaml
environment:
  DILUXITE_AUDIT_RETENTION_DAYS: "365"   # 0/unset = no expira nunca
```

### Active sessions

Settings → Sessions: lista de devices conectados con IP + User-Agent + last-seen. Click "Revoke" para individual, "Sign out of all other devices" para reset masivo.

### Password change

Settings → Sessions → sección arriba de la tabla. Cambio de password **invalida todas las sessions excepto la actual** automáticamente (cierre forzado en otros devices).

### 2FA (TOTP)

Settings → Two-factor authentication. Enroll genera QR + secret, 6-dígitos confirmation, después backup codes. Compatible con Google Authenticator, Authy, 1Password, etc.

## Troubleshooting

| Síntoma | Qué chequear |
|---|---|
| Vite no levanta / puerto 5173 ocupado | `lsof -i :5173` y matar el proceso, o cambiar puerto en `apps/web/vite.config.ts` |
| Postgres no inicia / datos corruptos | `docker compose down -v && docker compose up` (⚠️ borra datos) |
| Migraciones fallan | `docker compose logs -f diluxite` — la API corre `runMigrations()` al boot. Mirar el primer error. |
| MCP devuelve 401 | El token es por usuario; regenerar desde Settings → MCP connection. |
| Watchtower no actualiza | El tag de la imagen en el compose debe ser rolling (`:next` o `:latest`), no pin (`:1.0.0-alpha.40`). Watchtower NO actualiza tags pin. |
| `/collab` no conecta (browser console: WS error) | Si estás detrás de un reverse proxy, configurar `DILUXITE_COLLAB_PUBLIC_URL=wss://...`. En nginx: `proxy_set_header Upgrade $http_upgrade` + `proxy_set_header Connection "upgrade"`. |
| OIDC callback falla con "invalid redirect" | El `DILUXITE_OIDC_REDIRECT_URI` debe matchear exactamente el redirect configurado en el IdP (case-sensitive + trailing slash importa). |
| HTTPS Caddy no obtiene cert | Caddy necesita los puertos 80 y 443 alcanzables desde internet para ACME HTTP-01 challenge. Si estás detrás de NAT, abrí port-forward 80/443. |

## Por dónde seguir

- Producto y decisiones: [`PRD.md`](./PRD.md)
- Stack técnico completo: [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- Roadmap + pendientes: [`ROADMAP.md`](./ROADMAP.md)
- Multi-tenant + RLS: [`MULTI-TENANT.md`](./MULTI-TENANT.md)
- Modelo de seguridad: [`SECURITY.md`](./SECURITY.md)
- Convenciones de frontend: [`PATTERNS.md`](./PATTERNS.md)
- Deploy en Kubernetes: [`DEPLOY-KUBERNETES.md`](./DEPLOY-KUBERNETES.md)
