# Diluxite Core 🪨

**Una supermemoria para motores de IA.** El motor open source de Diluxite: notas Markdown, búsqueda semántica (híbrida + reranking) y un servidor **MCP** para que Claude, Copilot y otros agentes lean, escriban y recuerden.

Esta es la **edición Core**: self-host, single-user, "lo levantás y lo usás". La edición Cloud (multiusuario, login Google/Microsoft, SaaS) se construye encima de este motor.

## Stack

Node.js + TypeScript · pnpm workspaces · Fastify · Drizzle ORM · PostgreSQL + pgvector · MCP SDK oficial.

## Correr en local

Requisitos: Node ≥ 20, pnpm, Docker.

```bash
cp .env.example .env
pnpm install
pnpm db:up          # levanta Postgres + pgvector (docker compose)
pnpm dev            # arranca la API en http://localhost:3030
```

Verificar:

```bash
curl http://localhost:3030/health
curl http://localhost:3030/health/db    # confirma conexión + pgvector
```

## Estructura

```
apps/
  api/        Servidor Fastify + MCP
packages/
  db/         Esquema Drizzle (usuarios, espacios, miembros, notas, chunks)
docker/       init.sql (habilita pgvector)
```

## Tests

```bash
pnpm test         # unidad (core) + integración (db, api) + e2e (MCP) — necesita Docker arriba
pnpm test:unit    # solo unidad (rápido, sin base)
pnpm typecheck    # tsc --noEmit en core/db/api
```

## Licencia

[AGPL-3.0](./LICENSE). Libre para usar, modificar y self-hostear; si lo ofrecés como servicio, tenés que compartir tus cambios. Para uso comercial sin las obligaciones del AGPL, contactá al autor (dual-licensing).
