# Diluxite vs Obsidian — Feature Comparison

Goal: **match the essentials of Obsidian and surpass it as an "AI supermemory"** (Claude/Copilot via MCP).
Legend: ✅ done · 🟡 in progress/this sprint · ⛔ not applicable · 🔜 roadmap.

## Note Core

| Feature | Obsidian | Diluxite (status) |
|---|---|---|
| Markdown notes | ✅ | ✅ |
| Editor + live preview | ✅ | ✅ |
| Wikilinks `[[Note]]` | ✅ | ✅ |
| Create note by following a wikilink | ✅ | ✅ |
| **Backlinks** (what links to this note) | ✅ | 🟡 this sprint |
| **Tags** `#tag` + tags panel | ✅ | 🟡 this sprint |
| **Graph view** | ✅ | 🟡 this sprint |
| Metadata (created/modified dates) | ✅ | 🟡 this sprint |
| Confirmation on delete | ✅ | 🟡 this sprint |
| Settings/options panel | ✅ | 🟡 this sprint |

## Search

| Feature | Obsidian | Diluxite |
|---|---|---|
| Keyword search | ✅ | ✅ (Spanish FTS) |
| **Semantic search (by meaning)** | ⛔ (plugins only) | ✅ native (pgvector) |
| **Hybrid search (keyword + meaning, RRF)** | ⛔ | ✅ |
| Filter by tag | ✅ | 🟡 this sprint |
| Reranking | ⛔ | ✅ (interface ready; Cloud: Cohere) |

## AI Integration (what sets us apart)

| Feature | Obsidian | Diluxite |
|---|---|---|
| MCP server | 🟡 (Local REST API plugin) | ✅ **native** |
| Tools for the AI to read/write/search | partial (plugin) | ✅ search/read/write/list |
| **Supermemory tools** (append, recents, tags, backlinks) | ⛔ | 🟡 this sprint |
| Per-user token to connect Claude/Copilot | manual | ✅ (mint/list/revoke) |

## Platform

| Feature | Obsidian | Diluxite |
|---|---|---|
| Local desktop app | ✅ | ⛔ (it's web/service) |
| **Web app** | ⛔ | ✅ |
| **Multi-user + shared spaces** | ⛔ | ✅ |
| **Isolation between users (security)** | ⛔ | ✅ tested |
| Cross-device sync | 💲 paid | ✅ (it's cloud) |
| **Database admin** | ⛔ | 🟡 Adminer :8080 |
| Single-command self-host | partial | ✅ `docker compose up` |
| Third-party plugins | ✅ (large ecosystem) | 🔜 (API/extensions) |
| Attachments (images/audio/video) | ✅ | 🔜 (→ transcription to text) |
| Canvas / whiteboards | ✅ | 🔜 |
| Native mobile apps | ✅ | 🔜 |

## Summary

- **We match** Obsidian's core: notes, wikilinks, backlinks, tags, graph, search.
- **We surpass** it where it matters for an AI supermemory: native **semantic/hybrid** search, **native MCP** with memory tools, **multi-user** with isolation, **web + cloud**, and **DB admin**.
- **Roadmap**: attachments (with searchable text transcription), canvas, plugins, mobile, and the Cloud edition (Entra + billing).
