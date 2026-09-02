-- The generation provider — ADR-006.
--
-- Diluxite had no generative model anywhere, and that is why it runs with no
-- API keys and why its ranking can explain itself. This table is the one
-- exception, and it is bounded on purpose: the provider's ONLY job is to draft
-- a question a human answers, in the weekly curation batch.
--
-- It never decides whether something is true, never touches ranking, validity
-- or staleness, never writes to a note, and never answers a user's question —
-- answering stays with the client AI over MCP. A row here does not change any
-- of that; it only means prose candidates get a drafted claim instead of going
-- unproposed.
--
-- Absent is a WORKING state, not a broken one: facts keep their templated
-- questions either way.
--
-- Per organisation, and the same shape ADR-003 established for embeddings:
-- endpoint plus a sealed credential, never plaintext.
CREATE TABLE IF NOT EXISTS generation_config (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,

  provider text NOT NULL CHECK (provider IN ('openai-compatible', 'ollama')),
  model text NOT NULL,
  endpoint text NOT NULL,
  api_key_sealed text,

  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Tenant data like the embedding configuration next door: an organisation's
-- provider choice is its own. Without a policy, engaging RLS (ADR-004) turns
-- the table into an accidental deny-all and writing it fails with a 500.
ALTER TABLE generation_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS generation_config_org_member ON generation_config;
CREATE POLICY generation_config_org_member ON generation_config
    USING (diluxite_is_org_member(org_id, diluxite_current_user_id()));
