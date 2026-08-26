# Conector DDW → Diluxite (diseño, 2026-08-26)

> Escrito desde la sesión de DDW la noche del multirepo. Contexto completo en
> la memoria de esa sesión (`~/repos/dilux-development-workflow`). Este doc es
> el punto de arranque para implementarlo ACÁ, en una sesión de diluxite-core.

## La tesis

DDW obliga a que nada importante quede sin escribir (PRDs, decisiones, ADRs,
índices multirepo, catálogo de familia — todo commiteado en git, validado por
compuertas). Diluxite ya tiene búsqueda híbrida + MCP. **Lo único que falta es
el puente: un ingestor que le dé de comer a Diluxite lo que DDW deja escrito.**
Frase de venta: "DDW garantiza que nada importante quede sin escribir;
Diluxite garantiza que nada escrito quede sin encontrar."

## Frontera dura (decidida con Pablo, no renegociar)

- Diluxite **lee, jamás gatea**: ningún paso de DDW depende de Diluxite.
  Caído o ausente, DDW funciona idéntico. El conector vive de ESTE lado.
- Solo-lectura sobre git/forge. Credenciales: las del usuario (gh), nunca
  almacenadas.

## Qué construir: `diluxite ingest-ddw`

1. **Fuentes** (por repo, dado un dir raíz tipo `~/repos` o una lista):
   - `docs/ddw/prd/*.md` (PRDs e índices multirepo), `docs/ddw/specs/*`
     (specs + `decisions-*.md`), `docs/adr/*.md`, `docs/ddw/security/*`,
     `docs/ddw/reports/*`, `docs/ddw/family-catalog.md`, y la sección
     `## Repo family` de cada `AGENTS.md`.
2. **Mapeo a notas**: una nota por documento, con frontmatter/tags:
   `#ddw`, `#repo/<nombre>`, `#ticket/<id>`, `#familia/<nombre>`,
   `#tipo/{prd|adr|decision|threat|catalogo|indice}`. Wikilinks automáticos:
   decisión ↔ su PRD ↔ su repo ↔ su familia (el graph view dibuja la familia
   solo).
3. **Incremental**: guardar el sha/blob de origen por nota (como hace el
   catálogo de DDW); re-ingestar solo lo que cambió. Borrado en origen →
   nota archivada con anotación, nunca borrada en silencio (regla de la casa).
4. **MCP**: con la ingesta hecha, los 10 tools existentes ya la sirven.
   Opcional v2: un tool `ddw_status` que responda "¿qué iniciativas están
   abiertas?" leyendo los índices ingestados.

## Lo que NO es

- No es un watcher/daemon: se corre a pedido o lo agenda el usuario.
- No escribe en los repos, jamás.
- No duplica enforcement: la verdad sigue en git; esto es el índice de lectura.

## Referencias

- El formato del índice multirepo y del catálogo: repo DDW, rama
  `feat/multirepo-v1` (`ddw/rules/define.instructions.md` § Multirepo split,
  `ddw/scripts/family_catalog.py`).
- Investigación de catálogos (Backstage/Port/Nx/Pact — por qué derivado y no
  a mano): en la memoria de la sesión DDW del 26-ago.

## Estandarización del destino (decidido con Pablo, 26-ago)

**1 familia DDW = 1 workspace Diluxite, nombrado por el campo `Family`.**
El campo ya es la clave canónica (sección `## Repo family` de cada AGENTS.md
y familia.md del coordinador), así que el mapeo se DERIVA — cero configuración
del usuario, imposible de desincronizar. Repos sin familia → un workspace
general ("mis-repos"). Dentro del workspace, tags `#repo/<n>`, `#ticket/<id>`,
`#tipo/{prd|adr|decision|indice|catalogo}`. El aislamiento/compartición por
workspace que Diluxite ya trae mapea 1:1 al equipo de la familia. Ningún
concepto nuevo: workspace ya existe; el conector solo lo puebla.
