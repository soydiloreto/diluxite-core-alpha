# Changelog

All notable changes to Diluxite Core are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-alpha.2] — 2026-05-31

### Installer fixes (3)

- **Healthcheck**: el installer pegaba a `/api/health` (no existe) y `:3030/health` (puerto no expuesto en el compose all-in-one). Ahora chequea `/api/update/check` vía nginx en `:5173`, que ES la señal canónica de "API + nginx + ruteo OK".
- **`pnpm seed` en el container**: el script usaba `--env-file=.env` (REQUIRED), y `.env` no existe en la imagen → tsx fallaba. Cambiado a `--env-file-if-exists=.env` (env vars del container ya alcanzan vía `process.env`; `.env` solo aplica para dev local).
- **`scripts/` faltaban en la imagen all-in-one**: `docker compose exec diluxite pnpm seed` no encontraba `scripts/seed-demo.ts`. Agregado `COPY scripts scripts` en `docker/allinone.Dockerfile`.

[1.0.0-alpha.2]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.2

## [1.0.0-alpha.1] — 2026-05-31

### Distribution

- **Imagen all-in-one publicada**: `soydiloreto/diluxite` (api + nginx + web estática en un container vía supervisord). El installer default usa esta — un solo container app + Postgres. Las imágenes separadas `soydiloreto/diluxite-api` y `soydiloreto/diluxite-web` se mantienen para escalado (Cloud, orgs grandes).
- **Installer unificado** (`install.sh` único): soporta Linux / macOS / WSL2 / Git Bash en Windows. Eliminado `install.ps1`. En Windows el user lo corre desde WSL2 o Git Bash.
- **Docker missing → browser + abort**: el installer abre la página oficial de descarga en el browser del user (xdg-open / open / cmd.exe) y aborta sin intentar instalar Docker silently.
- **Ollama auto-install**: si elegís Ollama y no lo tenés, el installer te ofrece `curl ollama.com/install.sh | sh` con confirmación (default Y). En Windows nativo abre la página de descarga.
- **README de Docker Hub automatizado**: cada release pushea el README correspondiente (`docker/hub-readme-{allinone,api,web}.md`) a cada repo en Docker Hub vía la API (peter-evans/dockerhub-description). Solo en releases estables — los pre-releases no churnean la página pública.
- **`release.yml` matrix expandida**: ahora buildea las 3 imágenes en paralelo (`allinone`, `api`, `web`) con `matrix.include` que mapea cada una a su Dockerfile + Docker Hub repo + README.
- **`docker-scan.yml`**: Trivy scan también cubre las 3 imágenes.

[1.0.0-alpha.1]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.1

## [1.0.0-alpha.0] — 2026-05-31

First public alpha. Diluxite es la memoria de tu IA: notas Markdown + búsqueda híbrida (FTS español + pgvector) + servidor MCP nativo. Distribuido por Docker Hub (`soydiloreto/diluxite-api` + `soydiloreto/diluxite-web`, multi-arch amd64/arm64). Edición Core (este repo) open-source AGPL-3.0; edición Cloud privada hostea el mismo motor multi-tenant.

### Distribución y onboarding

- Imágenes en Docker Hub publicadas por release.yml al taggear `vX.Y.Z` (estable) o `vX.Y.Z-(alpha|beta|rc|dev)[.N]` (pre-release). Estable tagea `:X.Y.Z + :X.Y + :latest`; pre-release tagea `:X.Y.Z + :next`.
- Installer `install.sh` (Linux / macOS / WSL2) e `install.ps1` (Windows + Docker Desktop): detecta plataforma, valida pre-requisitos (Docker daemon, Compose v2, puertos libres, ≥ 3 GB), pregunta dónde guardar los datos (bind-mount), qué embedder usar (Ollama local con `mxbai-embed-large:335m` recomendado, Azure OpenAI o determinista), y si querés arrancar con vault vacío o seed demo de 1500 notas. Pulla las imágenes, levanta el stack, hace el seed si corresponde.
- `docker-compose.template.yml` con placeholders + profile opt-in `autoupdate` (Watchtower con `--label-enable`, poll 6 h, TZ Buenos Aires).
- `UpdateBanner` en la web: polling de `/api/update/check` (compara versión local vs la última GitHub Release del repo); endpoint `GET /api/update/check` en la API. Sin exponer Docker socket — el banner muestra el comando, el usuario lo ejecuta.

### CI / CD blindados

- Workflows separados estilo `wpm-user-sync` / `dilux-cloud-storage`: `lint.yml`, `typecheck.yml` (matrix Node 20/22/24), `tests-unit.yml` (matrix), `tests-integration.yml` (con `pgvector/pgvector:pg17` service), `version-alignment.yml` (los 5 `package.json` + entrada literal en CHANGELOG).
- Seguridad en 3 capas: `codeql.yml` (TS, `security-extended`, weekly Lunes), `security-audit.yml` (pnpm audit --prod --audit-level=high, weekly Martes), `docker-scan.yml` (Trivy contra ambas imágenes con `severity HIGH,CRITICAL`, `ignore-unfixed`, weekly Miércoles).
- `release.yml`: validación STRICT del tag (rechaza `1.0.0`, `v1.10`, `v1.0.0+meta`), verifica que los 5 `package.json` matcheen el tag, verifica entrada `## [X.Y.Z]` en CHANGELOG, build multi-arch con `docker/build-push-action` + GHA cache, push a Docker Hub, GitHub Release con `prerelease` auto-detectado.
- `.github/copilot-instructions.md` con arquitectura completa, modelo de datos, pipeline de búsqueda, anti-patrones y prioridades de review (Copilot Code Review usa este archivo automáticamente).
- `.github/dependabot.yml` con grouping (npm prod + dev separados, github-actions, docker base images), weekly Buenos Aires.
- `CODEOWNERS`, PR template, issue templates.
- Branch protection en `main` con 4 required status checks + `required_conversation_resolution`.

### Motor

- **Embeddings pluggable** (`packages/core/src/providers.ts`): `DeterministicEmbeddingProvider` (default OSS), `OllamaEmbeddingProvider` (local, sin claves, sin nube, `/api/embed` batch), `AzureOpenAIEmbeddingProvider`. `pickEmbedder()` en `apps/api/src/services.ts` con prioridad Azure > Ollama > determinista por env.
- **Pipeline de búsqueda**: tags + wikilinks + chunking heading-aware (512 / overlap 64) + `EmbeddingProvider.embed` + RRF (k=60) + reranker pluggable (`IdentityReranker` en Core, Cohere/cross-encoder en Cloud).
- **MCP server** Streamable HTTP, stateful por `Mcp-Session-Id`, 10 tools: `search_memory`, `list_notes`, `read_note`, `write_note`, `list_spaces`, `list_tags`, `search_by_tag`, `recent_notes`, `backlinks_of`, `append_to_note`.
- **Multi-tenant**: organizations + spaces + memberships; cross-tenant isolation por `space_id` en cada query.
- **Frontend**: React 19 + Vite 7 + Tailwind + Dockview + Monaco + cmdk + lucide. Shell estilo VS Code (Activity Bar + Sidebar + Dockview + Status Bar). Cmd/Ctrl+K Quick Switcher. Editor con Neighbors panel (outlinks + backlinks + suggested vía pgvector) y splitters movibles persistidos en prefs.

### Seguridad

- Bump `drizzle-orm` de 0.38.4 a 0.45.2 — resuelve SQL injection [GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9).

[Unreleased]: https://github.com/soydiloreto/diluxite-core-alpha/compare/v1.0.0-alpha.0...HEAD
[1.0.0-alpha.0]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.0
