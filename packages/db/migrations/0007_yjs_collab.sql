-- Sprint 1 — Yjs collaborative editing: binary CRDT state per note + tracking.
--
-- Yjs document state is serialized via Y.encodeStateAsUpdate and stored as
-- bytea. While there are connected clients editing a note, the in-memory
-- Y.Doc held by Hocuspocus is the source of truth. When the last client
-- disconnects (or on debounced persist tick), Hocuspocus serializes the doc
-- here and derives notes.content_md so search/MCP/export keep working.

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS yjs_state bytea,
  ADD COLUMN IF NOT EXISTS yjs_updated_at timestamp;

-- Lookup: which notes have a Yjs state we can hydrate from on next open.
CREATE INDEX IF NOT EXISTS notes_yjs_updated_idx
  ON notes(yjs_updated_at)
  WHERE yjs_state IS NOT NULL;
