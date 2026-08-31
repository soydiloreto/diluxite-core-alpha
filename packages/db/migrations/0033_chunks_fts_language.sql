-- The lexical channel indexed every note as if it were Spanish.
--
-- `keywordSearch` and the GIN index behind it both used
-- `to_tsvector('spanish', text)` for all content, whatever language it was
-- written in. Postgres full-text search is per-configuration: the Spanish
-- stemmer applied to English keeps "the" and "and" as index terms and never
-- collapses "backups" to "backup", so searching the singular does not find the
-- plural. Measured, before this migration: of three inflection probes per
-- language, THREE OF THREE are lost in English, Portuguese and Italian, and
-- all three match under the language's own configuration
-- (apps/api/src/search-eval.integration.test.ts).
--
-- The vector channel hid most of the damage inside the fused ranking, which is
-- why the end-to-end hit rates stayed high and nobody noticed.
--
-- Three changes:
--
--   1. `fts_config` — the configuration THIS chunk is indexed with, written at
--      index time from the language detected in the note (packages/core/src/
--      language.ts). Typed `regconfig` rather than `text` on purpose: the cast
--      from text to regconfig is STABLE, not immutable, because it depends on
--      search_path — and a generated column needs an immutable expression. As
--      a real regconfig it is immutable, and a bad value fails at write time
--      instead of at query time.
--
--   2. `tsv` — the lexemes, computed once at write time instead of on every
--      search. This is what makes per-language indexing possible at all: an
--      expression index can only ever hold ONE configuration, so
--      `to_tsvector('spanish', text)` was not a bug that could be fixed in the
--      index. A stored column can hold a different configuration per row.
--
--   3. The GIN index moves to `tsv`, and the old single-language expression
--      index goes away — nothing can use it any more.
--
-- Existing rows keep 'spanish', which is exactly what they were indexed as, so
-- this migration changes no result on its own. A note takes its real language
-- the next time it is saved or reindexed.

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS fts_config regconfig NOT NULL DEFAULT 'spanish';

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (to_tsvector(fts_config, text)) STORED;

CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);

-- Superseded: it could only ever answer for one configuration.
DROP INDEX IF EXISTS chunks_fts_idx;
