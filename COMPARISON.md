# Diluxite vs Obsidian — comparativa de funcionalidades

Objetivo: **igualar lo esencial de Obsidian y superarlo como "supermemoria para IA"** (Claude/Copilot vía MCP).
Leyenda: ✅ hecho · 🟡 en progreso/este sprint · ⛔ no aplica · 🔜 roadmap.

## Núcleo de notas

| Funcionalidad | Obsidian | Diluxite (estado) |
|---|---|---|
| Notas en Markdown | ✅ | ✅ |
| Editor + preview en vivo | ✅ | ✅ |
| Wikilinks `[[Nota]]` | ✅ | ✅ |
| Crear nota al seguir un wikilink | ✅ | ✅ |
| **Backlinks** (qué enlaza a esta nota) | ✅ | 🟡 este sprint |
| **Tags** `#tag` + panel de tags | ✅ | 🟡 este sprint |
| **Vista de grafo** | ✅ | 🟡 este sprint |
| Metadata (fechas creado/modificado) | ✅ | 🟡 este sprint |
| Confirmación al borrar | ✅ | 🟡 este sprint |
| Panel de ajustes/opciones | ✅ | 🟡 este sprint |

## Búsqueda

| Funcionalidad | Obsidian | Diluxite |
|---|---|---|
| Búsqueda por palabra | ✅ | ✅ (FTS español) |
| **Búsqueda semántica (por significado)** | ⛔ (solo plugins) | ✅ nativa (pgvector) |
| **Búsqueda híbrida (palabra + significado, RRF)** | ⛔ | ✅ |
| Filtrar por tag | ✅ | 🟡 este sprint |
| Reranking | ⛔ | ✅ (interfaz lista; Cloud: Cohere) |

## Conexión con IA (lo que nos diferencia)

| Funcionalidad | Obsidian | Diluxite |
|---|---|---|
| Servidor MCP | 🟡 (plugin Local REST API) | ✅ **nativo** |
| Tools para que la IA lea/escriba/busque | parcial (plugin) | ✅ buscar/leer/escribir/listar |
| **Tools de supermemoria** (append, recientes, tags, backlinks) | ⛔ | 🟡 este sprint |
| Token por usuario para conectar Claude/Copilot | manual | ✅ (mint/list/revoke) |

## Plataforma

| Funcionalidad | Obsidian | Diluxite |
|---|---|---|
| App local de escritorio | ✅ | ⛔ (es web/servicio) |
| **Web app** | ⛔ | ✅ |
| **Multiusuario + espacios compartidos** | ⛔ | ✅ |
| **Aislamiento entre usuarios (seguridad)** | ⛔ | ✅ testeado |
| Sync entre dispositivos | 💲 pago | ✅ (es cloud) |
| **Admin de base de datos** | ⛔ | 🟡 Adminer :8080 |
| Self-host con un comando | parcial | ✅ `docker compose up` |
| Plugins de terceros | ✅ (gran ecosistema) | 🔜 (API/extensiones) |
| Adjuntos (imágenes/audio/video) | ✅ | 🔜 (→ transcripción a texto) |
| Canvas / pizarras | ✅ | 🔜 |
| Apps móviles nativas | ✅ | 🔜 |

## Resumen

- **Igualamos** el núcleo de Obsidian: notas, wikilinks, backlinks, tags, grafo, búsqueda.
- **Superamos** en lo que importa para una supermemoria de IA: búsqueda **semántica/híbrida** nativa, **MCP nativo** con tools de memoria, **multiusuario** con aislamiento, **web + cloud**, y **admin de DB**.
- **Roadmap**: adjuntos (con transcripción a texto buscable), canvas, plugins, móvil, y la edición Cloud (Entra + billing).
