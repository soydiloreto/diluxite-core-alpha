# TODO — handoff de sesión (cross-machine)

> Este archivo es el **handoff** entre sesiones de trabajo en Diluxite. Tiene
> que ser self-contained: si arrancás en otra máquina, leerlo (más el `CHANGELOG.md`
> y los `docs/`) debe alcanzar para saber dónde estás parado.

Última actualización: **2026-06-01** (post `v1.0.0-alpha.9`)

## Estado actual

- **Versión publicada:** `1.0.0-alpha.9` en Docker Hub (`:1.0.0-alpha.9` + `:next`).
- **Repo limpio:** main al día, sin trabajo sin commitear.
- **Tag más reciente:** `v1.0.0-alpha.9` (release workflow CI verde — 4m3s).

## Lo que cerramos en la sesión 2026-06-01

1. **`alpha.8` — invariante "local = single-tenant" cerrado.**
   - Backend: 4 mode guards en `/api/organizations` + `/api/organizations/:orgId/tokens`
     (POST/DELETE) que devuelven 403 en `local`.
   - Bug pre-existente arreglado: `services.ts` hardcodeaba `version: 4.1.0-alpha.0`
     → ahora lee de `apps/api/package.json`.
   - Frontend: `OrganizationTab` con botón delete disabled + tooltip en local;
     `OrgTokensTab` oculta el form de mint en local; `OrgIndicator` muestra
     "+ New organization" en server mode; nuevo `createOrgFlow` en `App.tsx`.
   - `fakeApi` ahora respeta el modo (default `local`, opt-in `server`).
   - 11 integration tests nuevos + 9 unit tests nuevos. Cero regresiones.
2. **`alpha.9` — auto-update opt-out (default Yes) + cierre del engaña-pichanga
   de Watchtower.**
   - El installer pinneaba la imagen a versión exacta → Watchtower nunca
     actualizaba aunque activaras el profile. Ahora:
   - Nuevo Step 6 / 9 "Auto-actualización" con default **Yes**.
   - ON → tag rolling (`:next` o `:latest`) + Watchtower como servicio default.
   - OFF → tag pin + Watchtower detrás del profile `autoupdate`.
   - Steps renumerados a `/9` consistente.
   - README sección "Actualizar" reescrita.
3. **`docs/DEPLOY-KUBERNETES.md` — guía enterprise saludable (no hardcore).**
   - Postgres → Azure DB for PostgreSQL Flexible Server (extensión `vector`).
   - Embeddings → Azure OpenAI (`text-embedding-3-large`).
   - Auth → `server` mode siempre.
   - Packaging → manifests YAML crudos primero, Helm chart después.
   - App split → api + web separados (NO all-in-one en K8s).
   - **Secrets → `Secret` nativos de K8s para arrancar**; Sealed Secrets o
     External Secrets como hardening opcional cuando la empresa lo pida.
   - **Updates → `kubectl set image` manual para arrancar**; Renovate / GitOps
     como automation opcional cuando duela.
   - Tabla de mapping para AWS/GCP/on-prem.

## Cómo levantar Diluxite en una computadora nueva

### Opción A — solo usarlo (instalación rápida)

```bash
curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
```
En el Step 5 elegí `2` (next/alpha) para arrancar con `1.0.0-alpha.9`. En el
Step 6 dejá auto-update en **Y** (default).

Web → http://localhost:5173. Carpeta de instalación → `~/diluxite/`.

Para verificar Watchtower:
```bash
docker ps --filter "name=watchtower"
docker logs -f diluxite-watchtower
```

### Opción B — trabajar en el código (dev mode)

```bash
git clone https://github.com/soydiloreto/diluxite-core-alpha.git ~/Repos/diluxite-core-alpha
cd ~/Repos/diluxite-core-alpha
pnpm install
pnpm db:up                              # Postgres + pgvector via Docker
pnpm --filter @diluxite/api dev         # API + MCP en :3030
pnpm --filter @diluxite/web dev         # Web en :5173
```

> Cuidado: si la instancia Docker `alpha.9` también está corriendo, el puerto
> 5173 está ocupado. Bajala antes de dev: `cd ~/diluxite && docker compose down`.

Tests:
```bash
pnpm test:unit              # rápido, sin DB
pnpm test:int               # integration, necesita pnpm db:up arriba
pnpm typecheck
pnpm lint
```

## Próximos pasos (en orden de prioridad)

### Alta — validar lo que se construyó

1. **UI de `alpha.8` end-to-end** en una instancia local con channel `next`:
   - Modo local → botón "Delete organization" debe estar grisado con tooltip
     "Organization deletion requires server mode".
   - OrgTokensTab → debe mostrar mensaje "available in server mode only" en
     vez del form.
   - OrgIndicator → no debe aparecer "+ New organization" en local.
2. **Reinstalar en modo server** para validar el flow "+ New organization":
   - Botón visible en el dropdown del OrgIndicator (server mode).
   - Click → dialog `useDialogs.prompt` → crea org → switchea automático.
3. **Validar auto-update real (`alpha.9`):**
   - Cuando publiquemos `alpha.10`, confirmar que Watchtower pulla solo
     dentro de las 6 h y la UI muestra la nueva versión sin intervención.
   - Para forzar antes: `docker restart diluxite-watchtower`.

### Media — Kubernetes (PoC en `kind`)

Filosofía acordada: **saludable y aceptable, no enterprise hardcore**. Empezar
con lo mínimo, agregar capas cuando la empresa lo pida. Ver
[`docs/DEPLOY-KUBERNETES.md`](./docs/DEPLOY-KUBERNETES.md) para las 7 decisiones.

4. **Instalar `kind` localmente y armar PoC:**
   ```bash
   brew install kind kubectl
   kind create cluster --name diluxite
   ```
5. **Escribir manifests YAML crudos** para el quick start:
   - Postgres in-cluster (StatefulSet simple para PoC, CloudNativePG si querés
     algo más prolijo).
   - `Deployment` + `Service` para `diluxite-api` (1 réplica).
   - `Deployment` + `Service` para `diluxite-web` (2 réplicas).
   - `Ingress` (nginx ingress controller) ruteando `/api` → api-service y `/`
     → web-service.
   - `Secret` nativo en plano con admin email + password + Azure OpenAI key
     (PoC; en producción se aplica con `kubectl` desde un secret manager local).
   - `ConfigMap` con `DILUXITE_AUTH_MODE=server`, embedder endpoint, etc.
6. **Smoke test E2E**: navegar al Ingress, login con admin, crear nota,
   buscar semánticamente (Azure OpenAI desde el cluster).
7. **Documentar el quick start validado** en el doc K8s — reemplazar la
   sección "Quick start (PoC en `kind`)" actual con los YAMLs reales y los
   pasos exactos.
8. **AKS real** (futuro): replicar con Postgres gestionado y secret manager
   de Azure.
9. **Helm chart** (futuro): empaquetar y publicar en `soydiloreto/diluxite-helm`.

### Baja — hallazgos colaterales pendientes

10. **Sistema de notificaciones real** (la 🔔 abre un popover vacío).
11. **Scope selector en TopBar** (workspace / por carpeta).
12. **Tabla `activity_log`** para que el Timeline muestre eventos de carpeta /
    borrado masivo (hoy se deriva sólo de `notes.createdAt` / `notes.updatedAt`).

## Avisos para la próxima sesión

- GitHub muestra **8 vulnerabilidades Dependabot moderate** en main. Mirarlas
  cuando haya tiempo (no son críticas).
- Branch protection en `main` con 4 status checks requeridos. Los admins
  pueden bypasear en push directo a main, los workflows igual corren todos
  verdes — verificable en `gh run list`.
- La cuenta GitHub de Pablo es **`soydiloreto`** (`gh` CLI debe estar
  autenticado en cada máquina nueva: `gh auth login`).
- Convención: código siempre en inglés; comunicación con Pablo en español;
  defaults opt-out para features de auto-update.
- Para liberar una nueva versión:
  1. Bump los 5 `package.json` (root + `packages/core` + `packages/db` +
     `apps/api` + `apps/web`).
  2. Agregar entrada `## [X.Y.Z] — YYYY-MM-DD` al `CHANGELOG.md`.
  3. `git commit + git tag vX.Y.Z + git push origin main + git push origin vX.Y.Z`.
  4. CI buildea las 3 imágenes a Docker Hub (~5 min).
