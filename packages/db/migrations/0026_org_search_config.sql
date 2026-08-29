-- Search configuration, per organization.
--
-- `searchMode` and `topK` lived in each browser's localStorage, while the
-- control for them sat in the ADMIN console. So an admin set them believing
-- they applied to the organisation, and they applied to that laptop —
-- a setting that lies about its own scope.
--
-- They join `org_settings` rather than getting a table: the row is already
-- one-per-org, already sparse (absent means defaults), and already the place
-- `auth_policy` lives. A second table would need the same upsert, the same
-- fallback and the same RLS for two columns.
--
-- Defaults match what the client used, so an install that never touches this
-- behaves exactly as before.

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS search_mode text NOT NULL DEFAULT 'hybrid';

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS search_top_k integer NOT NULL DEFAULT 5;

-- The three modes the engine implements. A value outside them would silently
-- degrade every search in the org to whatever the fallback happens to be.
ALTER TABLE org_settings
  DROP CONSTRAINT IF EXISTS org_settings_search_mode_known;
ALTER TABLE org_settings
  ADD CONSTRAINT org_settings_search_mode_known
  CHECK (search_mode IN ('hybrid', 'keyword', 'semantic'));

-- An upper bound as well as a lower one: topK feeds a candidate multiplier,
-- so a large value turns one query into a very expensive scan for everyone in
-- the org.
ALTER TABLE org_settings
  DROP CONSTRAINT IF EXISTS org_settings_search_top_k_sane;
ALTER TABLE org_settings
  ADD CONSTRAINT org_settings_search_top_k_sane
  CHECK (search_top_k BETWEEN 1 AND 50);
