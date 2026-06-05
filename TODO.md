# TODO — handoff de sesión (cross-machine)

> Este archivo es el **handoff** entre sesiones de trabajo en Diluxite. Tiene
> que ser self-contained: si arrancás en otra máquina, leerlo (más el `CHANGELOG.md`
> y los `docs/ROADMAP.md`) debe alcanzar para saber dónde estás parado.

Última actualización: **2026-06-02** (post `v1.0.0-alpha.43`)

## Estado actual

- **Versión publicada:** `1.0.0-alpha.43` en Docker Hub (`:1.0.0-alpha.43` + `:next`).
- **Repo limpio:** `main` al día, sin trabajo sin commitear.
- **Tag más reciente:** `v1.0.0-alpha.43`.
- **Tests:** **341 unit + 290 int = 631 verdes**. Typecheck + lint clean.
  Sin flakes conocidos.

## Sesión 2026-06-02 (tarde) — alpha.41 → alpha.43

Después del refresh de docs + análisis de las 31 alphas previas, abordamos
los 5 accionables prioritarios para llegar a beta. Cerrados 4 de los 5
items; el 5° (backup CLI) quedó parcial (trash bin sí, backup CLI para
próxima sesión).

| Release | Tests | Qué cierra |
|---|---|---|
| **alpha.41** | — | Flake `UsersImportCsv` (fireEvent.change atómico) + docs refresh (ARCHITECTURE/RUNBOOK/PRD al día con stack alpha.40) + 2 lint errors pre-existentes. |
| **alpha.42** | +19 | **EmailProvider abstraction** (Noop + Smtp) + **Forgot/reset password** (migration 0015 + endpoints rate-limited + UI ForgotPasswordScreen/ResetPasswordScreen + AppGate pre-auth bypass). |
| **alpha.43** | +13 | **Trash bin / soft delete** (migration 0016 + repo soft delete + 5 endpoints + TrashView UI + ActivityBar button). |

### Pendiente split del item #5 (backup CLI)

El item original era "Backup/restore CLI + trash bin". Trash bin cerrado en
alpha.43. Backup CLI queda para próximo release:

- **alpha.44** (planificado, 1 día): `diluxite backup --out file.tar` CLI
  que wrapea `pg_dump` + agrega manifest.json (version + counts + schema_at).
  `diluxite restore --in file.tar` con validación de manifest.
- Endpoint admin opcional `GET /api/admin/backup` para descarga desde UI.
- Hoy el flow manual sigue documentado en `RUNBOOK.md` (`pg_dump` directo
  con `docker exec`).

## Lo que cerramos en la sesión 2026-06-02 (mañana) — 10 releases anteriores

| Release | Tests | Qué cierra |
|---|---|---|
| **alpha.31** | — | Wizard install.sh: post-install SSO hints en server mode. |
| **alpha.32** | +23 | **CSRF double-submit cookie** (cierra hueco SECURITY.md §8). |
| **alpha.33** | — | **HTTPS Caddy sidecar** con ACME + wizard inline OIDC/trusted-header. |
| **alpha.34** | +30 | **Audit log** schema/repo/endpoint + UI AuditTab. |
| **alpha.35** | +9 | Audit log cobertura completa (logout/OIDC/tokens). |
| **alpha.36** | +50 | **2FA TOTP backend** RFC 6238 (incluye known-answer vectors). |
| **alpha.37** | +18 | 2FA TOTP UI (TwoFactorTab + LoginScreen MFA step). |
| **alpha.38** | +9 | Audit retention job (`DILUXITE_AUDIT_RETENTION_DAYS`). |
| **alpha.39** | +18 | **Active sessions UI** — list + revoke + revoke-others. |
| **alpha.40** | +12 | **Password change** endpoint + session invalidation. |

Ver `CHANGELOG.md` para el detalle por release.

### Tareas (skill TaskCreate) cerradas en esta sesión

- `#37` Hardening de seguridad (alpha.21+) — paragua.
- `#44` Fase 1.5 — HTTPS + CSRF + security headers.
- `#45` Wizard install.sh — separar local vs server.
- `#47` Audit log — schema + middleware + UI.
- `#48` 2FA TOTP backend + UI.
- `#49` Audit log retention job.
- `#50` Active sessions UI — list + revoke.
- `#51` Password change endpoint + session invalidation.

### Documentación actualizada en esta sesión

- `CHANGELOG.md` — 10 entries nuevas (alpha.31 → alpha.40).
- `docs/SECURITY.md` — §8 con todos los gaps "alta/media" marcados cerrados.
  Solo persisten 2 "by design" (sin rate limit global; modo local confía en
  quien tenga :5173).
- `docs/ROADMAP.md` — reescrito con estado real alpha.40 + bloque "Pendiente".
- `docs/PATTERNS.md` — §9 (test policy) ya estaba; mantenido.
- Este `TODO.md` — reescrito.

## Cómo levantar Diluxite en una computadora nueva

### Opción A — solo usarlo (instalación rápida)

```bash
curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
```

El wizard ahora preguntá inline en server mode por:
- Domain HTTPS (opcional → genera `Caddyfile`, levanta con `--profile https`).
- OIDC SSO (opcional → `DILUXITE_OIDC_*` inyectado al compose).
- Trusted-header proxy (opcional → `DILUXITE_TRUSTED_IDENTITY_HEADER`).

Web → `http://localhost:5173` (o `https://<domain>` si configuraste HTTPS).
Carpeta de instalación → `~/diluxite/`.

### Opción B — trabajar en el código (dev mode)

```bash
git clone https://github.com/soydiloreto/diluxite-core-alpha.git ~/repos/diluxite-core
cd ~/repos/diluxite-core
pnpm install
pnpm db:up                              # Postgres + pgvector via Docker
pnpm --filter @diluxite/api dev         # API + MCP en :3030
pnpm --filter @diluxite/web dev         # Web en :5173
```

> Cuidado: si la instancia Docker (`:next`) también corre, el puerto 5173
> está ocupado. Bajala antes de dev: `cd ~/diluxite && docker compose down`.

Tests:
```bash
pnpm test:unit              # 316 (core + web + api-unit). Sin DB.
pnpm test:int               # 273 (db + api). Necesita pnpm db:up arriba.
pnpm typecheck
pnpm lint
```

## Próximos pasos (en orden de prioridad)

Detalle completo en `docs/ROADMAP.md` § "Pendiente". Resumen:

### Para cerrar alpha → 1.0-beta

1. ~~**Trash bin / soft delete**~~ — ✅ alpha.43.
2. ~~**Forgot password / reset por email** + **email service abstraction**~~ — ✅ alpha.42.
3. **Backup / restore CLI** (`diluxite backup --out file.tar`) (1 día).
4. **i18n del backend** — errores localizados por `Accept-Language` (1 día).
5. **Accessibility audit** WCAG AA (2 días).
6. ~~**Fix flake `UsersImportCsv` test**~~ — ✅ alpha.41.

### Settings UX / configuración runtime (post alpha.47)

7. **AI / Embeddings configurable desde UI** (alpha.48 split):
   - **48a**: cambiar URL/endpoint del provider actual (sin cambio de modelo/dim) — 1 día. Refactor del provider factory para que sea hot-reloadable + endpoint admin + UI form en `/admin/ai`.
   - **48b**: switch de modelo con re-index masivo — 3-4 días. Endpoint reindex + UI progress bar + estrategia para no romper búsqueda mientras corre. Aplica cuando el dim cambia (Ollama mxbai 1024 → Azure text-embedding-3-large 3072).
8. **Search config persistido server-side por org** (alpha.48, 1 día): hoy `searchMode` y `topK` viven en `localStorage`. El placeholder en `SearchConfigTab` admin lo aclara.
9. **Reemplazar Watchtower upstream** (1 día): `containrrr/watchtower:latest` arrastra Docker API client v1.25, los daemons modernos (≥v1.40) lo rebotan. Opciones: cambiar a fork mantenido (`beatkind/watchtower`, `nickfedor/watchtower`) o reemplazar por cron casero. El install de Pablo ya está con cron como workaround (`~/diluxite/update.sh` + crontab `0 */6 * * *`).

### Del PRD v2 original — "próximo"

10. Daily notes + plantillas (1-2 días).
11. Adjuntos (imágenes / archivos → texto) (3-4 días).
12. Import desde Obsidian / Notion / Joplin (2-3 días).
13. Eval semántica español (1 día).

### Usabilidad inferida

14. Note versioning (history + restore) (3-4 días).
15. Public sharing (read-only link) (2 días).
16. Export markdown ZIP del space (1 día).
17. Bulk operations (multi-select tag/move/archive) (1 día).

### Enterprise / operational

15. SCIM 2.0 provisioning (4-5 días — heavy).
16. Webhooks (event → POST URL) (2 días).
17. Observability (Prometheus `/metrics`) (1 día).
18. Audit log alerting (webhook on N failed logins) (1 día).
19. SSO group/role mapping (1-2 días).
20. CSP nonce (en vez de `unsafe-inline`) (1 día).
21. Performance benchmarks reproducibles (1 día).
22. Playwright CI (suite E2E ya escrita; falta wire en GH Actions) (1 día).

### Por fuera de este repo (van en `diluxite-saas` privado)

- Cloud multi-tenant: Entra real (Google + MS), billing, AKS + Azure Front Door.
- Kubernetes manifests (v1.1 del roadmap original — ver `docs/DEPLOY-KUBERNETES.md`).

## Avisos para la próxima sesión

- GitHub muestra Dependabot alerts en main. Mirarlas cuando haya tiempo.
- Branch protection en `main` con 4 status checks requeridos. Los admins
  pueden bypasear en push directo. Workflows corren igual.
- La cuenta GitHub de Pablo es **`soydiloreto`** (`gh` CLI debe estar
  autenticado en cada máquina nueva: `gh auth login`).
- **Convenciones:**
  - Código siempre en inglés; comunicación con Pablo en español.
  - Defaults opt-out para features de auto-update.
  - Tests *súper furiosos y detallistas* (`docs/PATTERNS.md` §9).
  - NEVER skip git hooks.
- **DOCKERHUB_USERNAME** + **DOCKERHUB_TOKEN** viven como GitHub repo
  secrets; solo `soydiloreto` los rota. NO aceptar credenciales por chat.
- **Para liberar una nueva versión:**
  1. Bump los 5 `package.json` (root + `packages/core` + `packages/db` +
     `apps/api` + `apps/web`).
  2. Agregar entrada `## [X.Y.Z] — YYYY-MM-DD` al `CHANGELOG.md`.
  3. `git add … && git commit && git tag vX.Y.Z`.
  4. `git push origin main && git push origin vX.Y.Z`.
  5. CI buildea las 3 imágenes (api/web/all-in-one) a Docker Hub (~5 min).
- **Para tests integration**, el container `diluxite-db` debe tener el port
  binding `5432:5432` (ver `docker-compose.yml`). Si existe un container
  viejo sin port binding: `docker stop diluxite-db && docker rm diluxite-db && pnpm db:up`.
