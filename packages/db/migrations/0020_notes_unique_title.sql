-- Prevent duplicate live notes with the same title in a space.
--
-- Following a wikilink `[[New Note]]` does find-by-title + create, which is
-- not atomic: two concurrent requests both miss the lookup and both insert,
-- yielding two notes with the same title (TOCTOU). A UNIQUE index lets the
-- repo do an atomic `INSERT … ON CONFLICT DO NOTHING` and converge on one row.
--
-- PARTIAL on `deleted_at IS NULL`: trashed notes are exempt, so a title can be
-- reused after its previous note is trashed, and restoring/creating can't
-- collide with rows already in the bin. (Two trashed notes may share a title.)
--
-- NOTE: if a database already has duplicate LIVE (space_id, title) rows this
-- CREATE will fail — that's intentional (surfaces the corruption). Fresh DBs
-- and the test DB are clean. Operators with dupes must de-dup first.

CREATE UNIQUE INDEX IF NOT EXISTS notes_space_title_live_uniq
  ON notes (space_id, title)
  WHERE deleted_at IS NULL;
