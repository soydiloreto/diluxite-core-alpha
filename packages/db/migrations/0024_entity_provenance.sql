-- Provenance, validity and rank — ADR-002.
--
-- Three orthogonal axes, each taken from an existing standard rather than
-- invented here:
--
--   * W3C PROV-O          where it came from: the Agent it is attributed to,
--                         the Activity that produced it, what it was derived
--                         from.
--   * SQL:2011 bitemporal when it was true. TWO timelines, not one:
--                         `valid_from`/`valid_to` is the world's, `recorded_at`
--                         is ours. Without the second, the only answerable
--                         question is "what is true now" — never "what did we
--                         believe in March", which is the one that arrives
--                         after a decision goes wrong.
--   * Wikidata ranks      whether it still stands. Superseded rows are KEPT
--                         with rank `deprecated`; nothing is deleted, so a
--                         historical question stays answerable.
--
-- They are orthogonal deliberately. A value can be well-sourced AND out of
-- date, or superseded AND still the right answer to a question about the past.
-- A single confidence number destroys exactly that, which is why there isn't
-- one.
--
-- KEYED BY (entity_kind, entity_id), NOT BY note_id. Today the finest thing
-- Diluxite has is a note, so `note` is the only kind. When query_facts lands
-- (ADR-001 step 2) a table row becomes an entity and uses these same tables —
-- the promise in ADR-002 was that starting at the note defers no migration,
-- and a `note_id` column would have broken it on day one.
--
-- `space_id` is denormalised like `chunks.space_id` and `note_versions`:
-- tenant filtering without a join, and the standard space-member RLS policy
-- applies verbatim.

CREATE TABLE IF NOT EXISTS entity_provenance (
  entity_kind text NOT NULL,
  entity_id uuid NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,

  -- PROV-O. `attributed_to` is the Agent; it is NULLABLE on purpose and the
  -- reason is honest rather than lazy: a collaborative flush is authored by
  -- whoever was typing during the debounce window, which can be several people
  -- or nobody identifiable at the moment the write lands. Recording a
  -- plausible single author there would be inventing provenance, which is
  -- worse than admitting there is none. `agent_kind` still says WHAT wrote it.
  attributed_to uuid REFERENCES users(id) ON DELETE SET NULL,
  agent_kind text NOT NULL DEFAULT 'user',
  -- The PROV Activity: which door the write came through.
  generated_by text NOT NULL DEFAULT 'editor',
  -- prov:wasDerivedFrom. Null for a note somebody wrote; set for anything
  -- derived from another entity — an imported file today, a table row
  -- tomorrow.
  derived_from_note_id uuid REFERENCES notes(id) ON DELETE SET NULL,
  derived_from_line integer,
  derived_from_ref text,

  -- SQL:2011 bitemporal.
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),

  -- Wikidata rank.
  rank text NOT NULL DEFAULT 'normal',

  PRIMARY KEY (entity_kind, entity_id),

  CONSTRAINT entity_provenance_kind_known
    CHECK (entity_kind IN ('note', 'fact')),
  CONSTRAINT entity_provenance_rank_known
    CHECK (rank IN ('preferred', 'normal', 'deprecated')),
  CONSTRAINT entity_provenance_agent_kind_known
    CHECK (agent_kind IN ('user', 'org_token', 'connector', 'system', 'unknown')),
  -- A closed window has to close after it opened. Cheap, and it catches a
  -- supersession written with the wrong timestamp before it becomes a
  -- historical answer nobody can explain.
  CONSTRAINT entity_provenance_window_ordered
    CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX IF NOT EXISTS entity_provenance_space_idx
  ON entity_provenance (space_id);
-- "What is current here" is the common read: rank plus an open window.
CREATE INDEX IF NOT EXISTS entity_provenance_current_idx
  ON entity_provenance (space_id, rank)
  WHERE valid_to IS NULL;

-- ── Change statistics — ADR-002, the decay half ──────────────────────────
--
-- A SEPARATE table because the write patterns differ by orders of magnitude:
-- provenance is written once and amended rarely, these counters move on every
-- content save (a collab flush is ~every 2s while someone types). Keeping them
-- apart means a burst of typing does not rewrite the provenance row.
--
-- `avg_interval_seconds` is an exponentially weighted moving average of the
-- gap between changes — how often this thing ACTUALLY changes, learned from
-- its own history rather than declared by anybody. Maintained in constant time
-- on save: no scheduled job, no pass over the corpus. Staleness is then a
-- subtraction at query time over the handful of results actually returned.
--
-- Why measured and not categorised: on Wikipedia the median shelf life of a
-- lead sentence is 46 days against 3,740 for infobox fields — two orders of
-- magnitude, same corpus, same topics. What predicts it is structure, not
-- subject, so any taxonomy of topics groups those together and is wrong about
-- both. Cold start uses a structural prior; evidence replaces it as it
-- accrues.
CREATE TABLE IF NOT EXISTS entity_change_stats (
  entity_kind text NOT NULL,
  entity_id uuid NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_changed_at timestamptz NOT NULL DEFAULT now(),
  change_count integer NOT NULL DEFAULT 0,
  -- NULL until there are two changes to measure a gap between. A reader that
  -- finds NULL falls back to the structural prior rather than to a guess
  -- baked in here.
  avg_interval_seconds double precision,

  PRIMARY KEY (entity_kind, entity_id),

  CONSTRAINT entity_change_stats_kind_known
    CHECK (entity_kind IN ('note', 'fact')),
  CONSTRAINT entity_change_stats_interval_positive
    CHECK (avg_interval_seconds IS NULL OR avg_interval_seconds > 0)
);

CREATE INDEX IF NOT EXISTS entity_change_stats_space_idx
  ON entity_change_stats (space_id);

-- Same tenant isolation as every space-scoped table (0003/0019/0023 pattern).
ALTER TABLE entity_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_provenance FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_provenance_space_member ON entity_provenance;
CREATE POLICY entity_provenance_space_member ON entity_provenance
    USING (diluxite_can_access_space(entity_provenance.space_id, diluxite_current_user_id()));

ALTER TABLE entity_change_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_change_stats FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_change_stats_space_member ON entity_change_stats;
CREATE POLICY entity_change_stats_space_member ON entity_change_stats
    USING (diluxite_can_access_space(entity_change_stats.space_id, diluxite_current_user_id()));
