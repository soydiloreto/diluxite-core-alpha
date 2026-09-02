-- Archiving a note: out of the tree, still in the memory.
--
-- Until now a note had two states a user could reach — live, and in the trash
-- (`deleted_at`). "I am done with this, stop putting it in front of me, but do
-- not lose it" had nowhere to go, so it went to the trash, which is the one
-- place a note is on its way to being destroyed.
--
-- Deliberately a flag on the note and NOT a move, a folder or a third state:
--
--   * A folder (the Obsidian `_archive` convention) destroys the organisation
--     the note already had, and here the search — not the tree — is the main
--     surface.
--   * Hiding it from search (what Bear does) turns archiving into a soft
--     delete. In a product whose job is being the memory of an AI, a note the
--     search cannot reach has been forgotten, not archived.
--
-- So: archived notes keep answering searches and MCP calls, marked as archived
-- and ranked below live ones; they only leave the tree and the recents.
--
-- Timestamp rather than boolean for the same reason `deleted_at` is one: the
-- archive listing sorts by when it happened, and "archived" is recoverable
-- from `IS NOT NULL`.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS archived_at timestamp;

-- The archive view of a space, and the tree's "live notes only" filter. Partial
-- because archived notes are the small set: the index stays proportional to the
-- answer, not to the corpus.
CREATE INDEX IF NOT EXISTS notes_archived_idx
  ON notes (space_id, archived_at DESC)
  WHERE archived_at IS NOT NULL;
