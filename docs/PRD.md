# PRD — Diluxite (v4.0)

> **Documento de Producto.** Fuente de verdad funcional. Acompaña a [`ARCHITECTURE.md`](./ARCHITECTURE.md) (contexto técnico). Juntos permiten reconstruir el proyecto desde cero.

| | |
|---|---|
| Versión | **4.0.0-alpha** (refactor a identifiers en inglés + stack i18n proper; sobre la base v3.1 con stack VS Code: Dockview + Monaco + cmdk) |
| Fecha | 2026-05-27 |
| Autor | Pablo Di Loreto (Dilux) |
| Estado | Vivo — mantener actualizado en cada cambio. |
| Marca | Diluxite · color `#008671` · 🪨 |

**Historial breve:** v1 = motor (notas + MCP + búsqueda híbrida + tokens + multi-tenancy). v2 = layout Obsidian-like + Tailwind + carpetas + quick-switcher. v3.x = stack VS Code (Activity Bar + Dockview + Monaco + cmdk + lucide). v4.0 = refactor i18n: DB schema, tipos, paths REST, MCP tools y catálogos UI en inglés, manteniendo español como locale soportado en la UI.

---

## 1. Resumen ejecutivo

**Diluxite es la memoria de tu IA.** Un servicio donde se guarda conocimiento como notas y donde Claude, Copilot y cualquier cliente MCP **leen, escriben y buscan por significado** de forma autónoma. Resuelve la amnesia de la IA: tu IA finalmente recuerda — entre sesiones y entre herramientas. No es "otro editor de notas": un `.md` suelto no le sirve a tu IA.

v2 endurece la **experiencia de uso** (layout estilo Obsidian, design system coherente con Tailwind + biblioteca `ui/`, organización para muchas notas) sin perder el motor de búsqueda híbrida + MCP nativo que ya estaba sólido.

## 2. Problema y oportunidad

- **La IA no recuerda.** Cada sesión arranca de cero; se re-explica contexto.
- **El conocimiento está disperso** y **no es consumible por la IA** de forma estructurada y semántica.
- **No hay una memoria compartida** entre herramientas de IA.
- **Categoría validada** ("AI memory": Mem0, Zep, Supermemory). Diluxite se diferencia por: **MCP nativo, open-core, multiusuario, Azure-native, español-first** y — desde v2 — **UX al nivel de Obsidian**.

## 3. Visión

> Un **cerebro digital** que tu IA usa sola: capturás conocimiento una vez y todas tus IAs lo recuerdan, lo amplían y lo encuentran cuando hace falta. Con una interfaz que se siente *familiar* (estilo Obsidian) y aguanta miles de notas.

## 4. Propuesta de valor

| Para | Gana |
|---|---|
| Power user / dev | Su IA recuerda entre sesiones y herramientas. Deja de re-explicar |
| Equipo | Memoria institucional compartida (Cloud) |
| Self-hoster | Su propia instancia con `docker compose up` |

**Diferencial:**
- vs `.md` sueltos: no hay semántica ni MCP.
- vs Obsidian: local, single-user, sin MCP nativo, sin búsqueda semántica.
- vs ChatGPT memory: atada a un producto; Diluxite es agnóstica y exportable.

## 5. Ediciones (open-core)

| | **Core** (OSS, AGPL-3.0) | **Cloud** (SaaS, privado) |
|---|---|---|
| Acceso | "admin local" auto-bootstrappeado, sin login | Login Google/MS (Entra) |
| Hosting | `docker compose up` | Azure |
| Extras | El motor + UX completa | + multi-tenant + billing |

Mismo motor (ver ARCHITECTURE §3).

## 6. UX v2 — layout estilo Obsidian

**El cambio mayor de v2:** dejar las pestañas top y adoptar el patrón Obsidian:

```
┌──────────────────────────────────────────────────────────────────┐
│ ┌─ Left Dock ────┐  ┌── Main (Editor / Grafo) ────────────────┐ │
│ │ 🔎 Buscar       │  │  título · meta · editor + preview      │ │
│ │ ▼ Notas (árbol) │  │                                        │ │
│ │ ▶ Tags          │  │                                        │ │
│ │ ▶ Recientes     │  │                                        │ │
│ │ ▶ Favoritas     │  │                                        │ │
│ └─────────────────┘  └────────────────────────────────────────┘ │
│ ┌─ Status bar ─────────────────────────────────────────────────┐│
│ │ ⚙ Ajustes · 🟢 MCP · Espacio: Mi espacio · 👤 admin local    ││
│ └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

- **Left dock**: secciones colapsables — Buscar (input rápido), Notas (árbol con carpetas), Tags, Recientes, Favoritas. Resizable.
- **Main**: la vista activa (Editor o Grafo).
- **Status bar abajo**: ⚙ abre **Settings como modal**, indicador del **MCP** (verde/rojo), espacio activo, **usuario** ("admin local" en Core; el real en Cloud).
- **Settings = modal Obsidian-style** con menú lateral de secciones: Apariencia · Búsqueda · IA/Embeddings · Conexión MCP · Espacio · Acerca de. Cierra con `Esc`.

## 7. Sistema de diseño (Tailwind + `ui/`)

**Adoptamos Tailwind CSS** (mismo enfoque que `dilux-claw-alpha` ya tiene en producción interna), y todo componente nuevo se arma con primitivos reusables en `apps/web/src/ui/`:

- `Button`, `IconButton`, `Input`, `Field`, `Select`, `Modal`, `Section` (colapsable), `Sidebar`, `SidebarSection`, `ListItem`, `TreeItem`, `StatusBar`, `Toast`, `Tooltip`, `EmptyState`.
- Tokens centralizados en `tailwind.config` (colores `--brand` etc.).
- Regla: **nada de CSS suelto en pantallas**, todo a través de utilities Tailwind + primitivos `ui/`.

## 8. Personas

Power user / dev · Equipo técnico · Self-hoster · **Agente de IA** (cliente de primera clase vía MCP).

## 9. Casos de uso clave

1. "Claude, ¿qué decidí sobre la arquitectura X?" → `buscar_memoria`.
2. "Anotá esto en mi memoria" → `escribir_nota` / `agregar_a_nota`.
3. Buscar una nota con `Ctrl/Cmd+K` y abrir al instante.
4. Organizar 500+ notas en carpetas; tags transversales.
5. Marcar favoritas que se usan seguido.

## 10. Glosario

- **Nota**: título + texto Markdown.
- **Carpeta**: agrupación jerárquica de notas (árbol).
- **Espacio**: contenedor de carpetas/notas; unidad de permisos.
- **Wikilink `[[Nota]]`** / **Backlink**.
- **Tag `#tag`**.
- **Favorita**: nota marcada para acceso rápido.
- **Outline**: índice de headings de la nota.
- **Chunk / Embedding / Híbrida (FTS + vector, RRF) / MCP / Token** — ver ARCHITECTURE.

## 11. Requisitos funcionales (v2)

> `RF-x`. Estado: ✅ hecho · 🟡 este sprint v2 · 🔜 próximo.

### 11.1 Notas
- **RF-1..5** ✅ CRUD + wikilinks + autoguardado + confirmación de borrado + append.

### 11.2 **Organización (v2)** — para vaults grandes
- **RF-6** 🟡 **Carpetas** (árbol jerárquico): crear, renombrar, mover, eliminar.
- **RF-7** 🟡 **Quick switcher** (`Ctrl/Cmd+K`): fuzzy por título, abre al instante.
- **RF-8** 🟡 **Favoritas (pin)**: marcar/desmarcar; sección en el left dock.
- **RF-9** 🟡 **Outline**: panel con los headings de la nota actual, navegable.
- **RF-10** 🟡 **Selección múltiple + borrado masivo** (con confirmación que muestra la cantidad).
- **RF-11** ✅ Tags `#tag`. **RF-12** ✅ Backlinks. **RF-13** ✅ Grafo.

### 11.3 Espacios y multiusuario
- **RF-14..16** ✅ Varios espacios; invitar = acceso total; aislamiento testeado.

### 11.4 Búsqueda
- **RF-17..21** ✅ Híbrida + modos + reranking interfaz + chunking heading-aware + embeddings configurables (local/Azure).

### 11.5 MCP
- **RF-22..25** ✅ Servidor MCP nativo + 10 tools + tokens por usuario + autorización por espacio.

### 11.6 **UX v2**
- **RF-26** 🟡 **Layout left-dock + status-bar + Settings modal** (reemplaza pestañas top).
- **RF-27** 🟡 **Sistema de diseño Tailwind + `ui/`** (sin CSS suelto en pantallas).
- **RF-28** 🟡 **Indicador "admin local"** en el status bar (Core); usuario real en Cloud.
- **RF-29** 🟡 **Empty state explicado** (no pantalla en blanco).
- **RF-30** 🟡 **Settings modal con sub-tabs** laterales (Apariencia/Búsqueda/IA/MCP/Espacio/Acerca).

### 11.7 Operación
- **RF-31** ✅ Adminer :8080. **RF-32** ✅ Self-host con `docker compose up`.

## 12. UX detallada — pantallas y comportamientos

### 12.1 Home / Inicio
> En v2 se **elimina como pestaña**; el contenido de "Inicio" (onboarding + conectar IA) pasa al **empty state** del Main cuando no hay nota abierta + a una sección **"Empezar"** dentro del Settings modal.

### 12.2 Left Dock (panel izquierdo)
- **Buscar** (input arriba): tipea y aparecen sugerencias (semántica) en línea o usá `Ctrl/Cmd+K`.
- **Notas (árbol)**: carpetas colapsables, notas dentro; click abre, doble-click rename, menú contextual (mover, borrar, favorita).
- **Tags**: nube de tags clicleable, filtra el árbol.
- **Recientes**: últimas N modificadas.
- **Favoritas**: notas pinneadas.

### 12.3 Main
- **Editor**: título · meta (creada/editada) · split textarea ↔ preview · backlinks abajo · outline plegable a la derecha.
- **Grafo**: canvas + lista de nodos (accesible).

### 12.4 Status Bar (abajo)
- **⚙ Ajustes** → abre modal.
- **🟢/🔴 MCP** estado + tooltip con endpoint.
- **Espacio** activo (futuro: selector).
- **👤 admin local** (Core) o `email del usuario` (Cloud).

### 12.5 Settings Modal
- Submenú lateral izquierdo (Apariencia · Búsqueda · IA · MCP · Espacio · Acerca de · **Empezar/Conectar IA**).
- Cada sección con campos + texto explicativo de para qué sirve.
- Cierra con `Esc` o click fuera.

### 12.6 Quick Switcher
- `Ctrl/Cmd+K` abre modal con input + lista filtrada (fuzzy por título).
- Enter abre la nota seleccionada; `Esc` cierra.

### 12.7 Borrado masivo
- En el árbol de notas: hold `Shift`/`Ctrl` para multi-seleccionar.
- Botón "Borrar (n)" con confirmación: "¿Borrar n notas? Esta acción no se puede deshacer."

## 13. No funcionales

- **RNF-1..6** Escala 10k–1M vectores; Cloud < US$20/mes inicial; español validado; multi-tenant seguro; Docker; < 300 ms búsqueda.
- **RNF-7 (v2)**: layout fluido (< 60 ms render); el árbol de notas funciona con 1k+ entradas (virtualización si hace falta).

## 14. Roadmap

- **v1 (hecho)** ✅: motor + multiusuario + búsqueda híbrida + tags + backlinks + grafo + MCP + tokens + Adminer + AzureProvider + repo SaaS.
- **v2 (este sprint)** 🟡: design system Tailwind + layout Obsidian-like + carpetas + quick switcher + favoritas + outline + multi-select delete + admin local indicator + Settings modal.
- **Próximo** 🔜: daily notes + plantillas; Entra real + billing (Cloud); adjuntos (→ texto); eval español; import.

## 15. Métricas de éxito

Recuperación ≥ 90% top-5 (español) · activación (conectan IA en 7d) · latencia < 300 ms p95 · UX: el árbol de carpetas + quick switcher hacen que un usuario con 500 notas no se pierda.

## 16. Negocio

Core gratis (AGPL-3.0) · Cloud Free/Pro/Team · posible dual-licensing comercial del Core.

## 17. Riesgos / mitigaciones

| Riesgo | Mitigación |
|---|---|
| "Se siente pobre" / no escala | v2: layout Obsidian + design system + carpetas + quick switcher |
| Fuga entre inquilinos | Reglas duras + tests cruzados (hecho) |
| Adopción Claude/Copilot | Tools bien descritas + plantilla de CLAUDE.md documentada |

## 18. Fuera de alcance (v2)

App escritorio nativa, adjuntos multimedia, canvas, móvil nativo, edición colaborativa en tiempo real, daily notes (queda para v2.1).

## 19. Estado actual

v4.0.0-alpha: 49 tests core unit + 53 tests integración (db + api + e2e MCP) · typecheck verde en los 4 workspaces · Core + SaaS andando. El refactor a inglés no tocó la lógica del motor — sólo nombres. Ver `CHANGELOG.md` y `SPANISH_INVENTORY.md` para el detalle del rename.

## 20. Anexo: hardening enterprise (alpha.21 → alpha.40)

Post-v4.0 el repo siguió ampliándose con todo el stack de seguridad y
operaciones que un deploy enterprise necesita. Estos requisitos NO estaban
en el PRD original pero fueron acumulando como `Fase 1.0..1.5` + extensiones:

- **Auth multi-backend** (server mode): email+password, WebAuthn passkeys,
  OIDC SSO (Okta / Entra / Google / Authentik) con JIT provisioning + auth
  policy configurable, trusted-header proxy (Cloudflare Access / Authelia /
  Pomerium), 2FA TOTP RFC 6238 con backup codes.
- **CSRF double-submit cookie**, **HTTPS Caddy sidecar** con ACME automático,
  **security headers** vía `@fastify/helmet`, **rate-limit** en endpoints
  sensibles.
- **Audit log** append-only con retention configurable + UI Admin → Audit.
- **Active sessions UI** (list + revoke + revoke-others) + **password change**
  con session invalidation.
- **CSV bulk import** de usuarios + **Settings UI** para auth policy.
- **Wizard installer** con prompts inline en server mode para domain HTTPS +
  OIDC + trusted-header.

Estado al `v1.0.0-alpha.40`: **316 unit + 273 int = 589 tests verdes**,
typecheck clean. `docs/SECURITY.md §8` con todos los gaps "alta/media"
cerrados.

Para el detalle de releases y lo que QUEDA pendiente para llegar a beta/1.0,
ver `docs/ROADMAP.md` y `TODO.md`.
