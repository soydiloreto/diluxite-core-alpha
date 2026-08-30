-- Embedding model lifecycle — ADR-003.
--
-- Changing the embedding model invalidates every stored vector, and it happens
-- once or twice a year. This schema is built around that sentence: ONE model is
-- live, a change is a bounded and reversible migration, and the steady state is
-- as simple as if only one model had ever existed.
--
-- Two problems this closes, both of which fail silently today:
--
--  1. `chunks.embedding` has no declared dimension (migration 0008), so NO
--     vector index is possible — HNSW and IVFFlat both need a fixed one. Every
--     semantic query is a sequential scan. Measured at 20k vectors: 98.6 ms
--     scanning vs 4.3 ms indexed.
--  2. Nothing records WHICH model produced a vector. Swapping two models that
--     share a dimension mixes old and new vectors, search returns nonsense, and
--     the health check — which compares dimensions — reports everything fine.

-- ── The catalogue ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS embedding_models (
  -- Stable, human-readable, and carries what makes vectors incomparable:
  -- provider, model and dimension. e.g. 'ollama:mxbai-embed-large@1024'.
  key text PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),

  --   active   → what search reads and what saves write
  --   building → being filled in the background; written to, never read
  --   retired  → kept only so a bad change can be rolled back
  state text NOT NULL CHECK (state IN ('active', 'building', 'retired')),

  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz
);

-- The invariant, in the database rather than in a code path someone can
-- forget: Postgres refuses a second active model.
CREATE UNIQUE INDEX IF NOT EXISTS embedding_models_one_active
  ON embedding_models ((state)) WHERE state = 'active';

-- ── The vectors, partitioned by model ───────────────────────────────────
--
-- One partition per model. Each pins its dimension with a CHECK and carries an
-- ORDINARY HNSW index — the same index you would build if only one model
-- existed, because in the steady state only one does.
--
-- Partitioning rather than a `model_key` column with partial indexes for one
-- reason above all: retiring a model is `DROP TABLE <partition>`, which is
-- instant and leaves nothing behind. A mass DELETE of millions of rows leaves
-- a bloated table and a VACUUM to run.
--
-- `space_id` is denormalised, like `chunks` and `facts`: tenant filtering
-- without a join, and the standard space-member RLS policy.
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  model_key text NOT NULL REFERENCES embedding_models(key) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  embedding vector NOT NULL,
  PRIMARY KEY (chunk_id, model_key)
) PARTITION BY LIST (model_key);

-- Re-indexing a note replaces its rows; a space is deleted wholesale.
CREATE INDEX IF NOT EXISTS chunk_embeddings_space_idx ON chunk_embeddings (space_id);

ALTER TABLE chunk_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunk_embeddings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chunk_embeddings_space_member ON chunk_embeddings;
CREATE POLICY chunk_embeddings_space_member ON chunk_embeddings
    USING (diluxite_can_access_space(chunk_embeddings.space_id, diluxite_current_user_id()));

ALTER TABLE embedding_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_models FORCE ROW LEVEL SECURITY;
-- The catalogue is instance-wide, not tenant data: which model is running is
-- the same answer for everyone, and the admin endpoint already gates who may
-- ask. A permissive policy keeps the table readable once RLS is engaged
-- (MULTI-TENANT.md) instead of turning into an accidental deny-all.
DROP POLICY IF EXISTS embedding_models_readable ON embedding_models;
CREATE POLICY embedding_models_readable ON embedding_models USING (true);

-- NOTE: `chunks.embedding` is deliberately left in place by this migration.
-- The application backfills from it at boot and stops writing it; dropping the
-- column is a follow-up migration once a release has run on the new table, so
-- that this change is reversible rather than a one-way data move.
