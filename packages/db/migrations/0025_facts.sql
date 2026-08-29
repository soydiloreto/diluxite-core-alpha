-- Facts derived from the tables inside notes — ADR-001 step 2.
--
-- Markdown stays the source of truth. These rows are DERIVED at save time,
-- exactly like `note_tags` and `note_links`: nobody authors a fact, so there
-- is one place to correct a wrong one — the note — and no second copy that
-- can drift from it. Re-deriving replaces the note's whole set, which is why
-- there is no update path here, only delete-and-insert.
--
-- WHY A TABLE EARNS THIS RATHER THAN GETTING IT BY DEFAULT: a missing exact
-- answer costs a fallback to prose, which is where the system was anyway. A
-- wrong one is served ABOVE the prose, labelled as a fact, and believed. The
-- extractor in @diluxite/core skips anything doubtful — a repeated key, a
-- blank key, a single column, fewer than two rows — and says why.
--
-- `space_id` is denormalised like `chunks` and `note_versions`: tenant
-- filtering without a join, standard space-member RLS.

CREATE TABLE IF NOT EXISTS facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,

  -- "For KEY, COLUMN is VALUE." `key_column` carries what the key NAMES, so a
  -- reader knows whether "MRR" is a metric, a project or a person.
  key_column text NOT NULL,
  key text NOT NULL,
  column_name text NOT NULL,
  value text NOT NULL,

  -- prov:wasDerivedFrom, at line granularity: an answer can point at the row
  -- it came from, not merely at the note.
  source_line integer NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- The lookup this exists for: "in this space, what do we know about KEY?".
-- Lower-cased because a question never matches the note's capitalisation.
CREATE INDEX IF NOT EXISTS facts_space_key_idx
  ON facts (space_id, lower(key));
-- Narrowing by column once the key matched ("the VALUE of MRR", not its owner).
CREATE INDEX IF NOT EXISTS facts_space_key_column_idx
  ON facts (space_id, lower(key), lower(column_name));
-- Re-derivation deletes a note's whole set before inserting the new one.
CREATE INDEX IF NOT EXISTS facts_note_idx
  ON facts (note_id);

ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facts_space_member ON facts;
CREATE POLICY facts_space_member ON facts
    USING (diluxite_can_access_space(facts.space_id, diluxite_current_user_id()));
