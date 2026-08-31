-- Each organisation chooses its own embedding provider — ADR-005.
--
-- ADR-003 said one live model per INSTALLATION. That was a design choice
-- presented as a constraint, and two measurements overturned it:
--
--  1. Sharing an index between tenants silently breaks the small one. Ten
--     vectors belonging to org A in an HNSW index with twenty thousand of
--     org B's: a search by A for its five nearest returns ZERO. The index
--     hands back its 391 nearest candidates, all of them B's, and the tenant
--     filter removes every one — A does not get back its own vector at
--     distance zero. pgvector 0.8's iterative scan pushed that to 7,931 rows
--     examined and still returned zero. With a partition of its own: five of
--     five. Not a leak; a tenant that searches, finds nothing, and sees no
--     error.
--
--  2. Partitioning per organisation does not cost space. HNSW is roughly
--     linear — 2,000 vectors index to 5.9 MB, 20,000 to 125 MB — so ten
--     organisations of 2,000 each come to ~59 MB against ~125 MB pooled.
--
-- So the partition key becomes (organisation, model) rather than model alone.
-- Two organisations on the same model still get separate partitions, which is
-- the point.

-- ── The old vector table goes first ─────────────────────────────────────
--
-- Before anything touches `embedding_models`: on a fresh database
-- `chunk_embeddings.model_key` has a foreign key onto `embedding_models(key)`,
-- and the primary key cannot be moved off `key` while that reference exists.
--
-- Found by CI on a clean database, not locally — a development database that
-- has been mutated by hand no longer has the shape a migration actually meets.
-- The order below is the order a first-ever run needs.
--
-- Recreating the table is safe here for one written-down reason:
-- `chunks.embedding`, the pre-ADR-003 column, is still in place and still
-- holds every vector. Migration 0027 deliberately left it so this would be
-- reversible, and the boot backfill refills the new shape from it. An
-- installation that has since changed models rebuilds with a reindex, which
-- the admin console already offers.
DROP TABLE IF EXISTS chunk_embeddings CASCADE;

-- ── Configuration moves from the installation to the organisation ───────
DROP TABLE IF EXISTS embedding_config;
CREATE TABLE embedding_config (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('local', 'ollama', 'azure', 'bedrock')),
  model text,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  endpoint text,
  -- Never plaintext. NULL for providers that need no credential.
  api_key_sealed text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE embedding_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS embedding_config_readable ON embedding_config;
-- Now genuinely tenant data: an organisation's provider choice is its own.
CREATE POLICY embedding_config_org_member ON embedding_config
    USING (diluxite_is_org_member(org_id, diluxite_current_user_id()));

-- ── The catalogue gains an owner ────────────────────────────────────────
ALTER TABLE embedding_models ADD COLUMN IF NOT EXISTS org_id uuid
  REFERENCES organizations(id) ON DELETE CASCADE;

-- One live model PER ORGANISATION, still enforced by the database rather than
-- by the code that writes it.
DROP INDEX IF EXISTS embedding_models_one_active;
CREATE UNIQUE INDEX IF NOT EXISTS embedding_models_one_active_per_org
  ON embedding_models (org_id) WHERE state = 'active';

-- The partition key. `slot` is "<org_id>:<model key>" — one level of
-- partitioning rather than two, which is the same thing with less machinery.
-- Steady state: one partition per organisation. During that organisation's own
-- model change: two, and one again afterwards.
-- The primary key moves from `key` to `slot`. Two organisations choosing the
-- SAME model produce the same `key` and different slots — which is the design,
-- so `key` stops being unique and becomes what it always described: which
-- model this is, not which vector space.
ALTER TABLE embedding_models ADD COLUMN IF NOT EXISTS slot text;
UPDATE embedding_models SET slot = COALESCE(org_id::text || ':' || key, key) WHERE slot IS NULL;
ALTER TABLE embedding_models ALTER COLUMN slot SET NOT NULL;
ALTER TABLE embedding_models DROP CONSTRAINT IF EXISTS embedding_models_pkey;
ALTER TABLE embedding_models ADD PRIMARY KEY (slot);


CREATE TABLE chunk_embeddings (
  chunk_id uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  -- "<org_id>:<model key>". One level of partitioning instead of two, which
  -- is the same thing with less machinery: an organisation's vectors never
  -- share a partition with another's, and an organisation mid-model-change
  -- has two of its own.
  slot text NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  embedding vector NOT NULL,
  PRIMARY KEY (chunk_id, slot)
) PARTITION BY LIST (slot);

CREATE INDEX IF NOT EXISTS chunk_embeddings_space_idx ON chunk_embeddings (space_id);

ALTER TABLE chunk_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunk_embeddings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chunk_embeddings_space_member ON chunk_embeddings;
CREATE POLICY chunk_embeddings_space_member ON chunk_embeddings
    USING (diluxite_can_access_space(chunk_embeddings.space_id, diluxite_current_user_id()));

-- NOTE ON THE POLICY: Postgres does NOT inherit RLS to partitions. The policy
-- above protects a query that goes through this table and does nothing for one
-- that names a partition — measured at 0 rows against 58 before each partition
-- got its own. `DrizzleEmbeddingModelsRepository.ensurePartition` creates that
-- policy alongside every partition, which is the only place partitions are
-- created.
