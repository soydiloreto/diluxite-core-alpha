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
- 🧠 **Servidor MCP nativo** con tools en inglés: `search_memory`, `read_note`, `write_note`, `append_to_note`, `list_notes`, `list_tags`, `search_by_tag`, `backlinks_of`, `recent_notes`, `list_spaces`.
- 🔑 **Tokens por usuario** para conectar la IA.
- 👥 Multiusuario por espacios (aislamiento + compartir) — listo en el motor.
- ⚙️ **Ajustes** reales: apariencia (tema/color), búsqueda, IA/embeddings (local o **Azure OpenAI**), espacio (stats/export), conexión MCP.
- 🗄️ **Adminer** (admin de base de datos) incluido.

## Stack

Node + TypeScript · pnpm · Fastify · Drizzle · PostgreSQL + pgvector · MCP SDK · React + Vite · Vitest.
Detalle técnico completo: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). Producto: [`docs/PRD.md`](./docs/PRD.md). Roadmap: [`docs/ROADMAP.md`](./docs/ROADMAP.md). Runbook (Docker / dev): [`docs/RUNBOOK.md`](./docs/RUNBOOK.md). Deploy en Kubernetes: [`docs/DEPLOY-KUBERNETES.md`](./docs/DEPLOY-KUBERNETES.md). Comparativa vs Obsidian: [`COMPARISON.md`](./COMPARISON.md).

## Correr en local

### Opción A — Installer guiado (un solo script, todas las plataformas)

Linux / macOS / WSL2 / Git Bash en Windows:

```bash
curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
```

En Windows nativo, ejecutalo desde **WSL2** (que Docker Desktop ya usa de backend) o desde **Git Bash**. No hay `install.ps1` separado — un solo installer para todo.

El script:
1. Detecta tu plataforma y valida pre-requisitos (Docker daemon, Compose v2, puertos libres, ≥ 3 GB de disco).
2. Si falta Docker, abre la página oficial de descarga en tu browser y aborta (Docker en Mac/Win no se puede instalar silent).
3. Te pregunta dónde guardar los datos (bind-mount al disco — no se pierden si borrás el container).
4. Te ofrece **Ollama local con `mxbai-embed-large:335m`** (recomendado, alta calidad, multilenguaje, sin claves) / Azure OpenAI / determinista. Si elegís Ollama y no lo tenés, te ofrece instalarlo automático.
5. Vault vacío o seed demo de 1500 notas.
6. Pulla la imagen [`soydiloreto/diluxite`](https://hub.docker.com/r/soydiloreto/diluxite) (all-in-one) + Postgres, levanta el stack. Web en http://localhost:5173.

### Opción B — Docker run / compose manual

Si preferís copiar un compose y entender qué pulla:

```bash
docker pull soydiloreto/diluxite:latest
```

Snippets completos (compose + env vars) en el [README de Docker Hub](https://hub.docker.com/r/soydiloreto/diluxite).

**Para escalar** (separar API y web en containers distintos — Cloud, orgs grandes): [`soydiloreto/diluxite-api`](https://hub.docker.com/r/soydiloreto/diluxite-api) + [`soydiloreto/diluxite-web`](https://hub.docker.com/r/soydiloreto/diluxite-web).

**Para Kubernetes** (empresas con cluster propio — AKS / EKS / GKE / on-prem): ver [`docs/DEPLOY-KUBERNETES.md`](./docs/DEPLOY-KUBERNETES.md). Guía con las 6 decisiones de diseño (Postgres gestionado vs in-cluster, embedder, secrets, GitOps). Manifests y Helm chart en roadmap — se validan en `kind` local antes de publicar.

### Opción C — Dev mode con hot reload

Requisitos: Node ≥ 24, pnpm ≥ 9, Docker (solo para Postgres + pgvector).

```bash
cp .env.example .env
pnpm install
pnpm db:up                          # Postgres + pgvector + Adminer
pnpm --filter @diluxite/api dev     # API + MCP  → http://localhost:3030
pnpm --filter @diluxite/web dev     # Web UI     → http://localhost:5173
```

### Actualizar

El installer pregunta en el Step 6 si querés **auto-update** (default **Sí**). Tu elección queda baked en el `docker-compose.yml` generado:

- **Auto-update activado** (default): el compose usa el tag rolling (`:next` o `:latest` según el channel) y levanta [Watchtower](https://containrrr.dev/watchtower/), que revisa Docker Hub cada 6 h y reconcilia los containers con label `com.centurylinklabs.watchtower.enable=true`. No interfiere con otros Watchtowers del host. **No tenés que hacer nada** — Diluxite se actualiza solo.

  Si querés forzar un update ahora sin esperar a Watchtower:
  ```bash
  docker compose pull && docker compose up -d
  ```

- **Auto-update desactivado** (elegiste `N` en el installer): el compose pinea la versión exacta (ej. `:1.0.0-alpha.9`) y Watchtower queda detrás del profile `autoupdate`. El banner amarillo en la UI te avisa cuando hay versión nueva; corrés:
  ```bash
  docker compose pull && docker compose up -d
  ```
  Para activar Watchtower después del install sin reinstalar:
  ```bash
  docker compose --profile autoupdate up -d
  ```
  (Watchtower no va a actualizar nada hasta que cambies el tag de la imagen a `:next` o `:latest` en el compose — los tags pin no reciben updates.)

Más detalle: [`docs/RUNBOOK.md`](./docs/RUNBOOK.md). Producto y decisiones: [`docs/PRD.md`](./docs/PRD.md) · [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) · [`docs/ROADMAP.md`](./docs/ROADMAP.md) · multi-tenant [`docs/MULTI-TENANT.md`](./docs/MULTI-TENANT.md) · convenciones de front [`docs/PATTERNS.md`](./docs/PATTERNS.md).

### Datos de demo

```bash
pnpm seed              # 1500 notas técnicas (ADRs, runbooks, postmortems…) en ~3 años
RESET=1 pnpm seed      # wipe + reseed
SEED=7 pnpm seed       # otro corpus determinista
```
Detalle + smoke-test MCP en [`docs/RUNBOOK.md#seed-1500-demo-notes`](./docs/RUNBOOK.md#seed-1500-demo-notes).

### Conectar Claude / Copilot

1. En la web, andá a **Ajustes → Conexión MCP**, copiá el endpoint (`http://localhost:3030/mcp`) y **generá un token**.
2. En tu cliente (Claude, VS Code Copilot) agregá un conector MCP remoto con esa URL (+ token si tu instancia lo requiere).
3. Tu IA ya puede leer, escribir y buscar en tu memoria.

### Embeddings de calidad (opcional)

Por defecto usa embeddings **deterministas locales** (sin claves, ideal para tests y dev). Prioridad si hay env vars: **Azure OpenAI** > **Ollama local** > determinista.

**Azure OpenAI** (máxima calidad, requiere cuenta):

```
AZURE_OPENAI_ENDPOINT=...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=text-embedding-3-large
```

**Ollama local** (sin claves, 100% offline). Requiere [Ollama](https://ollama.com) corriendo + `ollama pull nomic-embed-text`:

```
OLLAMA_EMBEDDING_MODEL=nomic-embed-text   # 768 dims
OLLAMA_EMBEDDING_DIMENSIONS=768
# OLLAMA_ENDPOINT=http://localhost:11434  # opcional
```

Modelos típicos: `nomic-embed-text` (768), `mxbai-embed-large` (1024), `all-minilm` (384).

## Tests

```bash
pnpm test         # unidad + integración + e2e (necesita Docker arriba)
pnpm test:unit    # solo unidad (rápido)
pnpm typecheck
```

## Licencia

[AGPL-3.0](./LICENSE). Libre para usar, modificar y self-hostear; si lo ofrecés como servicio, compartí tus cambios. Licencia comercial disponible (dual-licensing).
