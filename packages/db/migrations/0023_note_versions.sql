-- Note version history.
--
-- Every content-changing save snapshots the note's PREVIOUS state into this
-- table (NotesService.update does it before writing) — versions are "what the
-- note used to say", the current state stays in `notes`. Two valves keep it
-- bounded: a coalescing window (a burst of saves — collab flushes every ~2s —
-- mints ONE snapshot, the state before the burst) and a per-note cap pruned
-- oldest-first on record. Restore is a new save on top, so history is
-- append-only: you can restore a restore.
--
-- `space_id` is denormalised like `chunks.space_id`: tenant filtering without
-- a join, and the standard space-member RLS policy applies verbatim.

CREATE TABLE IF NOT EXISTS note_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  content_md text NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);

-- Listing is always "this note, newest first"; pruning walks the same order.
CREATE INDEX IF NOT EXISTS note_versions_note_created_idx
  ON note_versions (note_id, created_at DESC);
CREATE INDEX IF NOT EXISTS note_versions_space_idx
  ON note_versions (space_id);

-- Same tenant isolation as every space-scoped table (0003/0019 pattern):
-- members of the space see its history, nobody else sees a row.
ALTER TABLE note_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS note_versions_space_member ON note_versions;
CREATE POLICY note_versions_space_member ON note_versions
    USING (diluxite_can_access_space(note_versions.space_id, diluxite_current_user_id()));
