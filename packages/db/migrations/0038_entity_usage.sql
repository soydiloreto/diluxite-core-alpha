-- How often something is actually used to answer.
--
-- Nothing recorded this, and without it the curation queue cannot exist: it
-- ranks candidates by expected value, and the first term of that is "how often
-- did this get used". Asking an owner to confirm the note nobody ever reads,
-- while the one behind every answer goes unchecked, is worse than not asking.
--
-- Its own table rather than more columns on `entity_change_stats`, for the
-- reason 0024 split that one out in the first place: the write patterns differ
-- by orders of magnitude. Change stats move when somebody saves; this moves on
-- every search that returns the row.
--
-- One row per entity, counters only. No log of individual uses: that would be
-- a table that grows with traffic and would record who read what, which is
-- surveillance nobody asked for. The capture layer records work, not people.
CREATE TABLE IF NOT EXISTS entity_usage (
  entity_kind text NOT NULL,
  entity_id uuid NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,

  use_count bigint NOT NULL DEFAULT 0,
  first_used_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (entity_kind, entity_id),
  CONSTRAINT entity_usage_kind_known CHECK (entity_kind IN ('note', 'fact'))
);

-- "What does this space lean on most", which is the queue's ordering read.
CREATE INDEX IF NOT EXISTS entity_usage_space_count_idx
  ON entity_usage (space_id, use_count DESC);

-- Same tenant isolation as every space-scoped table (0003/0019/0023/0024).
ALTER TABLE entity_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_usage_space_member ON entity_usage;
CREATE POLICY entity_usage_space_member ON entity_usage
    USING (diluxite_can_access_space(entity_usage.space_id, diluxite_current_user_id()));
