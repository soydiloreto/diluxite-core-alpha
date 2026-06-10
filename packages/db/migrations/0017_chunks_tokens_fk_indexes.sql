-- Indexes for two FK columns that back hot delete/list paths.
--
--   * chunks.note_id  — every note save deletes the old chunks by note_id
--     before re-inserting; without an index that's a seq scan per save.
--   * tokens.user_id  — token list + revokeAllForUser filter by user_id.

CREATE INDEX IF NOT EXISTS chunks_note_idx ON chunks(note_id);
CREATE INDEX IF NOT EXISTS tokens_user_idx ON tokens(user_id);
