-- Trash bin / soft delete for notes (alpha.43).
--
-- Until now `DELETE /api/notes/:id` was a hard delete (row gone, chunks
-- cascaded). That matches a power-user mental model but loses the safety
-- net any user expects ("oops, I clicked the wrong thing").
--
-- New behaviour:
--   * The default delete path (REST + UI delete button) sets `deleted_at`.
--   * Listings + search + MCP `list_notes` exclude rows where
--     `deleted_at IS NOT NULL`.
--   * `GET /api/spaces/:id/trash` returns the deleted-but-not-purged set.
--   * `POST /api/notes/:id/restore` clears `deleted_at`.
--   * `DELETE /api/notes/:id/purge` (and `DELETE /api/spaces/:id/trash`)
--     do the hard delete. That's the only way to actually drop a row.
--
-- The column is nullable so existing rows just stay "alive" (NULL = not
-- trashed). No data backfill required.

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS deleted_at timestamp;

-- Partial index keeps the hot path (active notes) fast. The "trashed" set
-- is small + admin-only so a full table scan when querying trash is fine.
CREATE INDEX IF NOT EXISTS notes_active_idx
  ON notes(space_id, updated_at DESC)
  WHERE deleted_at IS NULL;
