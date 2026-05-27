# Diluxite — Runbook (cómo correrlo)

## En Mac / Windows / Linux con Docker (recomendado)

Requisitos: Docker Desktop (Mac/Windows) o Docker Engine + Compose v2 (Linux).

```bash
git clone https://github.com/soydiloreto/diluxite.git
cd diluxite
docker compose up --build
```

- Web → http://localhost:5173
- API + MCP → http://localhost:3030
- Postgres (interno) → `db:5432` (puerto 5432 expuesto al host)
- Adminer (admin de DB, opcional) → `docker compose --profile tools up adminer` → http://localhost:8080

Datos persistentes: volume `diluxite_pgdata`. Para tirar todo y arrancar limpio:
```bash
docker compose down -v
```

## En modo dev (sin Docker, hot reload)

Requisitos: Node ≥ 24, pnpm ≥ 9, Docker (solo para Postgres + pgvector).

```bash
cp .env.example .env             # editar si querés cambiar DATABASE_URL / PORT
pnpm install
pnpm db:up                       # arranca solo Postgres + Adminer
pnpm --filter @diluxite/api dev  # API + MCP en :3030 con tsx watch
pnpm --filter @diluxite/web dev  # Vite en :5173 con HMR
```

## Conectar Claude / Copilot

1. En la web → **Activity Bar → Settings (⚙) → MCP connection**, copiá la URL: `http://localhost:3030/mcp`.
2. Generá un token (botón "Generar"). Copialo (no se vuelve a mostrar).
3. En Claude Desktop / Code, agregá el conector MCP remoto:
   ```json
   {
     "mcpServers": {
       "diluxite": {
         "url": "http://localhost:3030/mcp",
         "headers": { "Authorization": "Bearer TU_TOKEN" }
       }
     }
   }
   ```
4. Pedile a tu IA que use `buscar_memoria` y `escribir_nota` (renombre a inglés viene en v4.0).

## Troubleshooting

- **Vite no levanta / puerto ocupado**: `lsof -i :5173` y matar el proceso. O cambiar el port en `apps/web/vite.config.ts`.
- **Postgres no inicia (datos corruptos del volume)**: `docker compose down -v && docker compose up`.
- **Monaco no renderiza**: este repo bundlea Monaco localmente (no CDN). Si ves "Loading editor…" eterno, revisar consola del navegador.
- **MCP devuelve 401**: el token es por usuario; regenerar desde Settings.
- **Migraciones fallan**: la API corre `runMigrations()` al boot. Mirar logs con `docker compose logs -f api`.

## Backup / restore

```bash
# dump
docker exec diluxite-db pg_dump -U diluxite -d diluxite -Fc -f /tmp/dump.dump
docker cp diluxite-db:/tmp/dump.dump ./diluxite-$(date +%F).dump

# restore
docker cp ./diluxite-2026-05-26.dump diluxite-db:/tmp/dump.dump
docker exec diluxite-db pg_restore -U diluxite -d diluxite --clean --if-exists /tmp/dump.dump
```
