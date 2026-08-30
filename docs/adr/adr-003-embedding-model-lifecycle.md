# ADR-003 — One live embedding model, and a model change that nobody notices

- **Status:** accepted
- **Date:** 2026-08-30
- **Relates to:** [ADR-001](./adr-001-retrieval-architecture.md) (the semantic
  lane this governs) and [MULTI-TENANT.md](../MULTI-TENANT.md) (the isolation
  layer the new tables inherit).

## Context

Diluxite's semantic lane depends on an embedding model: at save time the note's
chunks become vectors, at query time the question becomes one, and closeness
between them is what makes *"cómo venimos con facturación"* find a note that
says *"estado de cobranzas"*. Without a real model the deterministic fallback
hashes words, and the product is a good keyword search wearing a semantic
label.

So a model gets configured. And then, eventually, changed — a better one ships,
a provider is dropped, a cost changes, a deployment moves off the cloud. **That
happens once or twice a year, not once a week.** Every design decision here
follows from that sentence.

Two facts make the change disruptive:

1. **Vectors from different models are not comparable.** Not "less accurate" —
   meaningless, like comparing metres to feet without converting. Every stored
   vector has to be rebuilt.
2. **The rebuild is not instant.** Thousands of chunks through a local Ollama
   is minutes to hours. During it, the semantic lane is either wrong or absent.

### What the system does today, and why it cannot stay

`chunks.embedding` is a pgvector column with **no declared dimension**
(migration `0008`), so Ollama's 1024 and Azure's 1536 can coexist. That
decision bought compatibility and cost two things, both load-bearing:

- **No vector index is possible.** HNSW and IVFFlat need a fixed dimension, so
  every semantic query is a sequential scan over the corpus. Measured on this
  machine at 20,000 vectors: **98.6 ms scanning versus 4.3 ms with an HNSW
  index** — 23×, and the gap widens with volume.
- **Nothing records which model produced a vector.** The admin health check
  added in #104 compares *dimensions*, which catches Ollama→Azure. It does not
  catch a swap between two different models that share a dimension: the old and
  new vectors mix, search returns nonsense, and the panel reports health.

The second is the dangerous one, because the UI for choosing a model — the
feature this ADR unblocks — would hand an administrator a button that silently
breaks search.

### What the field does

Checked 2026-08-30; sources at the end. The pattern is consistent across
vector stores and pgvector practice:

- **Version the embeddings.** Store which model produced each vector, not just
  its shape.
- **Blue/green the change.** Build the new set alongside the old, keep serving
  from the old, dual-write anything that changes meanwhile, then flip. Qdrant
  documents exactly this; the pgvector write-ups reach it via a versioned
  schema and per-version indexes.
- **Keep the source text.** Re-embedding must not mean re-fetching. Diluxite
  already stores `chunks.text`, so this one is satisfied.

## Decision

**One model is live at a time. A change is a bounded, reversible migration.**

### 1. A catalogue, with the invariant in the database

```sql
CREATE TABLE embedding_models (
  key         text PRIMARY KEY,      -- 'ollama:mxbai-embed-large@1024'
  provider    text NOT NULL,         -- ollama | azure | bedrock | local
  model       text NOT NULL,
  dimensions  integer NOT NULL,
  state       text NOT NULL CHECK (state IN ('active','building','retired')),
  ...
);
CREATE UNIQUE INDEX embedding_models_one_active
  ON embedding_models ((state)) WHERE state = 'active';
```

The partial unique index is the point: **Postgres refuses a second active
model**. Not a convention, not a code path someone can forget — an invariant.

### 2. Embeddings leave `chunks`, into a table partitioned by model

```sql
CREATE TABLE chunk_embeddings (
  chunk_id  uuid NOT NULL,
  model_key text NOT NULL REFERENCES embedding_models(key) ON DELETE CASCADE,
  space_id  uuid NOT NULL,
  embedding vector NOT NULL,
  PRIMARY KEY (chunk_id, model_key)
) PARTITION BY LIST (model_key);
```

Each model gets one partition, with its dimension pinned by a CHECK and an
**ordinary HNSW index** — the same index you would build if only one model
existed, because in the steady state only one does. Verified: a query filtered
by `model_key` prunes to a single partition and uses that index.

This also separates two things that were tangled: `chunks` is the text,
`chunk_embeddings` is the vectors.

### 3. The change is blue/green, and reversible

| Step | What the reader sees |
|---|---|
| Register the new model as `building` | nothing — its partition is empty |
| Re-embed in the background | **search keeps working on the live model** |
| Dual-write while building | a note edited mid-migration is embedded by both |
| Flip | one atomic `UPDATE`, guarded by the unique index |
| If quality regressed | flip back — the previous partition is still there |

### 4. At most two models exist, enforced at the moment of the flip

Live, plus the immediately previous one for rollback. **Anything older is
dropped inside the same transaction that activates the new model** — not by a
cleanup job, not by a button, so it cannot be skipped. Five changes leave two
models; fifty changes leave two.

Retiring is `DROP TABLE <partition>`: **~10 ms regardless of size**, against a
mass `DELETE` that would leave a bloated table and a `VACUUM` to run.

## Consequences

**What this costs.** Two new tables and a migration of the existing column.
During a change, disk for the vectors roughly doubles for the duration: at
100,000 chunks and 1024 dimensions, ~391 MB becomes ~782 MB steady-state (two
models) and ~1.1 GB at the peak. A 3072-dimension model triples those numbers —
worth knowing before choosing one.

**What it buys.** A model change stops being an outage. It becomes reversible,
which is what makes it possible to *evaluate* a new model against real queries
instead of adopting it on faith. And the semantic lane finally gets an index:
23× on the corpus measured here, more as it grows.

**Order matters.** This lands **before** the UI that lets an administrator
choose a model. Built the other way round, the UI is a button that breaks
search with no way back.

**What this does not decide.** Which providers ship (Ollama and Azure exist;
Bedrock authenticates with a bearer API key and needs no AWS SDK), and whether
the configuration is per-installation or per-organisation. That second one
waits on RLS actually running — see
[MULTI-TENANT.md](../MULTI-TENANT.md#engaging-rls-the-second-layer) — because
an API key in the database with a single enforcement layer beneath it is the
most valuable secret in the system sitting in the one place that has no net.

## Alternative considered, and rejected

**Keep the free-dimension column and let models coexist permanently**, each
with a partial index. It works — measured — and it was the first thing proposed
here. It is wrong as a design: it makes a state that should last hours into the
permanent shape of the schema, so every query carries a dimension filter
forever to serve an event that happens twice a year. Coexistence is a migration
state, and the schema should say so.

## Sources

- [Migrate to a New Embedding Model — Qdrant](https://qdrant.tech/documentation/tutorials-operations/embedding-model-migration/)
- [RAG Series — Embedding Versioning with pgvector — dbi services](https://www.dbi-services.com/blog/rag-series-embedding-versioning-with-pgvector-why-event-driven-architecture-is-a-precondition-to-ai-data-workflows/)
- [Your Embedding Model Will Deprecate. Here's What to Do — HackerNoon](https://hackernoon.com/your-embedding-model-will-deprecate-heres-what-to-do)
- [Migrating vector embeddings in production without downtime — Google Cloud Community](https://medium.com/google-cloud/migrating-vector-embeddings-in-production-without-downtime-8a0464af6f55)
- [Use an Amazon Bedrock API key — AWS](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html)

## Measurements

Taken 2026-08-30 on the development machine (Postgres 17 + pgvector, WSL2),
20,000 vectors of 1024 dimensions unless stated:

| | Result |
|---|---|
| Semantic query, sequential scan | 98.6 ms |
| Same query, HNSW on a pinned-dimension partition | 4.3 ms |
| Partition pruning with `model_key` filter | one partition scanned, the other untouched |
| RLS on the partitioned table, unprivileged role | 0 rows without identity, correct rows with it |
| Retiring a model (`DROP TABLE` partition, 5,000 rows) | 9.8 ms |
