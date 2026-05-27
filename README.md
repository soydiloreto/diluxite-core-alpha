# Diluxite 🪨 — la memoria de tu IA

**Diluxite no es un editor de notas más: es la memoria que tu IA usa sola.** Guardás conocimiento una vez y **Claude, Copilot y cualquier cliente MCP lo leen, escriben y buscan por significado** — recordando entre sesiones y entre herramientas. Algo que un `.md` suelto no te da: tu IA no puede recordar ni buscar en archivos sueltos.

> Edición **Core** (este repo): open source, self-host, single-user. La edición **Cloud** (multiusuario, login Google/Microsoft, hosteada) se construye sobre este mismo motor.

## ¿Qué gana el usuario?

- Tu IA **recuerda tu contexto** (decisiones, notas, proyectos) sin re-explicar todo cada vez.
- Búsqueda **por significado** (no solo palabra exacta): "la nube de Microsoft" encuentra tu nota de "Azure".
- **Conectás Claude/Copilot por MCP** y tienen una memoria compartida y persistente.

## Funcionalidades

- 📝 Notas Markdown con editor + **preview en vivo**.
- 🔗 **Wikilinks** `[[Nota]]`, **backlinks** y **grafo** del conocimiento.
- 🏷️ **Tags** `#tag` con filtro.
- 🔎 **Búsqueda híbrida** (palabra + significado, RRF) — configurable: híbrida / solo palabra / solo significado.
- 🧠 **Servidor MCP nativo** con tools: buscar, leer, escribir, append, listar, tags, backlinks, recientes.
- 🔑 **Tokens por usuario** para conectar la IA.
- 👥 Multiusuario por espacios (aislamiento + compartir) — listo en el motor.
- ⚙️ **Ajustes** reales: apariencia (tema/color), búsqueda, IA/embeddings (local o **Azure OpenAI**), espacio (stats/export), conexión MCP.
- 🗄️ **Adminer** (admin de base de datos) incluido.

## Stack

Node + TypeScript · pnpm · Fastify · Drizzle · PostgreSQL + pgvector · MCP SDK · React + Vite · Vitest.
Detalle técnico completo: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). Producto: [`docs/PRD.md`](./docs/PRD.md). Roadmap: [`docs/ROADMAP.md`](./docs/ROADMAP.md). Runbook (Docker / dev): [`docs/RUNBOOK.md`](./docs/RUNBOOK.md). Comparativa vs Obsidian: [`COMPARISON.md`](./COMPARISON.md).

## Correr en local

### Opción A — Docker (Mac / Windows / Linux), 1 comando

```bash
git clone https://github.com/soydiloreto/diluxite.git
cd diluxite
docker compose up --build
```

- **Web UI** → http://localhost:5173
- **API + MCP** → http://localhost:3030
- **Adminer** (opcional) → `docker compose --profile tools up adminer` → http://localhost:8080

### Opción B — Dev mode con hot reload

Requisitos: Node ≥ 24, pnpm ≥ 9, Docker (solo para Postgres + pgvector).

```bash
cp .env.example .env
pnpm install
pnpm db:up                          # Postgres + pgvector + Adminer
pnpm --filter @diluxite/api dev     # API + MCP  → http://localhost:3030
pnpm --filter @diluxite/web dev     # Web UI     → http://localhost:5173
```

Más detalle: [`docs/RUNBOOK.md`](./docs/RUNBOOK.md). Producto y decisiones: [`docs/PRD.md`](./docs/PRD.md) · [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) · [`docs/ROADMAP.md`](./docs/ROADMAP.md).

### Conectar Claude / Copilot

1. En la web, andá a **Ajustes → Conexión MCP**, copiá el endpoint (`http://localhost:3030/mcp`) y **generá un token**.
2. En tu cliente (Claude, VS Code Copilot) agregá un conector MCP remoto con esa URL (+ token si tu instancia lo requiere).
3. Tu IA ya puede leer, escribir y buscar en tu memoria.

### Embeddings de calidad (opcional)

Por defecto usa embeddings **locales/deterministas** (sin claves). Para búsqueda semántica de máxima calidad, configurá Azure OpenAI por env:

```
AZURE_OPENAI_ENDPOINT=...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=text-embedding-3-large
```

## Tests

```bash
pnpm test         # unidad + integración + e2e (necesita Docker arriba)
pnpm test:unit    # solo unidad (rápido)
pnpm typecheck
```

## Licencia

[AGPL-3.0](./LICENSE). Libre para usar, modificar y self-hostear; si lo ofrecés como servicio, compartí tus cambios. Licencia comercial disponible (dual-licensing).
