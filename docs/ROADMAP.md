# Diluxite — Roadmap

Esta es la lista viva del proyecto. Lo que cierra acá se mueve al `CHANGELOG` del commit correspondiente. Convertir fechas relativas a absolutas (hoy = 2026-05-26).

## Estado actual

- **Core OSS (este repo)**: API + MCP + Web UI v3.1 funcionando. Single-user (`local@diluxite`). Postgres + pgvector. Búsqueda híbrida (FTS Spanish + embeddings + RRF + reranker). 17 tests web + 120 tests monorepo.
- **Web UI v3.1**: Activity Bar VS Code-style + Dockview (tabs arrastrables + splits) + Monaco editor bundleado + cmdk command palette + lucide icons. Verificado con Playwright headless.
- **Cloud (privado)**: Skeleton (`apps/cloud` futura). Entra ID (Google/Microsoft passkey) pendiente.

## Próximas iteraciones

### v3.2 — pulido + responsive (siguiente)
- Mobile: verificar < 768px (drawer del sidebar, activity bar compacta).
- Account popover: cerrar al click en cualquier item.
- Atajos extra: `Ctrl+Shift+P` = command palette (alias de `Ctrl+K`), `Ctrl+,` = settings, `Ctrl+N` = nueva nota.
- Tabs: middle-click cierra; doble-click en empty area → nueva nota.

### v3.3 — UX de la memoria
- Outline pane (TOC del documento actual) en sidebar.
- Search/replace dentro de la nota (Monaco Find widget ya viene gratis, exponer Ctrl+F).
- Drag&drop de imágenes / archivos a la nota (subida a media local).

### v4.0 — Cloud
- `apps/cloud` con Entra ID (login Google + Microsoft).
- Passkeys (WebAuthn) para single-user instances.
- Multi-tenant production: spaces aislados, billing stub, dashboard de cuotas.
- Deploy en Azure (App Service + Postgres Flexible).

### Constante
- Rename DB/code/MCP a inglés (UI ya está i18n'd; falta schema `notas → notes`, `carpetas → folders`, tool names `buscar_memoria → search_memory`, etc.).
- Aumentar cobertura de tests (objetivo: 80% en core, 60% en api).

## Decisiones tomadas (ADR mini)

- **Open-core**: motor y UI son AGPL-3.0. Cloud (multi-tenant, billing, Entra) queda privado.
- **Stack**: Node 24, pnpm workspaces, TypeScript ESM, Fastify, Drizzle, Postgres 17 + pgvector. React 19 + Vite 7 + Tailwind para el cliente.
- **VS Code stack para la UI**: `dockview-react` (tabs/splits), `@monaco-editor/react` (editor), `cmdk` (palette), `lucide-react` (iconos). Elegido sobre construir custom porque la consistencia visual venía mal.
- **MCP transport**: Streamable HTTP con sesión por usuario; identidad derivada del token validado.
- **Chunking**: heading-aware, ~512 tokens con ~64 overlap. Notas ≤ 400 tokens se embeben enteras.
- **Embeddings**: provider pluggable. Default `DeterministicEmbedder` (sin claves), opcional `AzureOpenAIEmbedder` por env vars.

## Cosas que NO vamos a hacer

- Aplicación Electron / desktop nativo. Web-first; el usuario instala como PWA si quiere.
- Real-time collaborative editing (Yjs, etc.). Single-writer por nota, suficiente para "memoria personal/IA".
- Plugin system al estilo Obsidian. Extensibilidad vía MCP tools.
