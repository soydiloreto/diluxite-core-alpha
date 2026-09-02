-- Resolvers for live state — ADR-001 step 3.
--
-- Metrics, ticket status and dashboards are NOT copied into the memory: a note
-- declares where to ask and the engine resolves at query time. Copying is what
-- makes a second brain wrong in the way that matters — the number was right
-- when it was pasted, and nothing on the page says it stopped being right.
--
-- Two tables, and the split is the important part.

-- 1. WHAT THE OPERATOR ALLOWS. The trust boundary, and the reason this feature
-- is not a server-side request forgery with a nice syntax: a note is user
-- input, and without this table it would decide which addresses the server
-- calls. The note says WHERE; the operator says WHICH HOSTS and HOW TO
-- AUTHENTICATE — so a credential never lives in a note.
CREATE TABLE IF NOT EXISTS resolver_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Host plus port, matched EXACTLY. A suffix match is how this check is got
  -- wrong: `metrics.example.attacker.com` passes an allowlist of `example.com`.
  host text NOT NULL,
  -- Never plaintext, and never taken from a note.
  token_sealed text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (org_id, host)
);

ALTER TABLE resolver_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolver_allowlist FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS resolver_allowlist_org_member ON resolver_allowlist;
CREATE POLICY resolver_allowlist_org_member ON resolver_allowlist
    USING (diluxite_is_org_member(org_id, diluxite_current_user_id()));

-- 2. THE LAST KNOWN VALUE, WITH ITS DATE. The rule the whole step exists for:
-- no value is ever returned without the date it was true. When the source is
-- unreachable this row is what gets served — with its age, never bare. "MRR
-- 42k (12 minutes ago)" is something you say out loud; "MRR 42k (March)" is
-- something you go check.
--
-- One row per (note, resolver name): a cache, not a history. What a value USED
-- to be belongs to the note's own record, not to a table that grows with
-- traffic.
CREATE TABLE IF NOT EXISTS resolver_cache (
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  name text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,

  value text,
  -- When the value was fetched. NOT when it was asked for: those are the same
  -- thing only when the source answered.
  fetched_at timestamptz,
  -- The last failure, kept beside the last value rather than replacing it —
  -- "could not reach it, and here is what it said an hour ago" is the honest
  -- answer, and it needs both.
  error text,
  attempted_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (note_id, name)
);

CREATE INDEX IF NOT EXISTS resolver_cache_space_idx ON resolver_cache (space_id);

ALTER TABLE resolver_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolver_cache FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS resolver_cache_space_member ON resolver_cache;
CREATE POLICY resolver_cache_space_member ON resolver_cache
    USING (diluxite_can_access_space(resolver_cache.space_id, diluxite_current_user_id()));
