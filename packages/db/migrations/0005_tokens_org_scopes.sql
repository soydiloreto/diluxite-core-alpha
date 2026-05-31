-- Fase 2.b — Tokens can belong to a user OR an organization, with scopes.
--
-- Pre-existing tokens have user_id set, org_id NULL, scopes '{}'. The empty
-- scopes array preserves legacy behaviour (the token acts as the owning
-- user's full identity). New tokens can be created with explicit scopes for
-- granular API access.

ALTER TABLE tokens
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS tokens_org_idx ON tokens(org_id);

-- A token must belong to exactly one of (user, org), not both/neither.
ALTER TABLE tokens
  ADD CONSTRAINT tokens_owner_xor CHECK (
    (user_id IS NOT NULL AND org_id IS NULL) OR
    (user_id IS NULL AND org_id IS NOT NULL)
  );
