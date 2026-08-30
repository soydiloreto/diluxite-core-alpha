-- What the operator chose, as opposed to what is running — ADR-003.
--
-- `embedding_models` is the catalogue of vector spaces that EXIST, with one
-- live at a time. This is the single row saying which provider the instance
-- should be using: chosen from the admin console rather than from a container
-- restart, and outliving both.
--
-- Per instance, not per organisation. The vector column holds one live model
-- (ADR-003), so two organisations on different models would mean two live
-- partitions and two indexes — a different design, and a heavier one, for a
-- setting that an installation makes once or twice a year.
--
-- The API key is stored SEALED (AES-256-GCM, `packages/core/src/secret-box.ts`)
-- under a passphrase that lives in the environment. If that passphrase is
-- absent the application refuses to store a credential rather than writing one
-- in the clear, and refuses to invent a random key rather than making every
-- stored credential unreadable after the next restart.

CREATE TABLE IF NOT EXISTS embedding_config (
  -- Single row, enforced: `CHECK (id)` with a boolean primary key is the
  -- smallest way to say "there is exactly one of these" in the schema rather
  -- than in the code that writes it.
  id boolean PRIMARY KEY DEFAULT true CHECK (id),

  provider text NOT NULL CHECK (provider IN ('local', 'ollama', 'azure', 'bedrock')),
  model text,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  endpoint text,

  -- Never plaintext. NULL for providers that need no credential (local,
  -- and Ollama on a trusted network).
  api_key_sealed text,

  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE embedding_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_config FORCE ROW LEVEL SECURITY;
-- Instance-wide configuration, not tenant data: which model the installation
-- runs is the same answer for everyone, and the admin endpoint already gates
-- who may ask. A permissive policy keeps it readable now that RLS is engaged
-- (ADR-004) instead of turning into an accidental deny-all.
DROP POLICY IF EXISTS embedding_config_readable ON embedding_config;
CREATE POLICY embedding_config_readable ON embedding_config USING (true);
