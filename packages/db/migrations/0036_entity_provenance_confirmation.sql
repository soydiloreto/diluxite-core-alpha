-- Who SIGNED this, which is not who wrote it.
--
-- ADR-002's addendum reads the Company Brain ladder's "N3 · verified" as
-- `rank: preferred` plus the person who signed it. The obvious shortcut —
-- putting the signer in `attributed_to` — destroys the record it is trying to
-- extend: that column is the PROV Agent, the author of the content. Confirming
-- a note would silently rewrite its authorship, and the provenance would then
-- name the last reviewer as the writer of every page in the company.
--
-- So confirmation is its own pair of columns. A page can then say both things
-- at once: written by Ana in August, confirmed by Pablo in September.
ALTER TABLE entity_provenance
  ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- "Never confirmed by anyone" is the query the curation queue ranks by, and
-- it is the majority of the corpus — so the index is on the confirmed ones,
-- which are the few, and the query reads it as an anti-join.
CREATE INDEX IF NOT EXISTS entity_provenance_confirmed_idx
  ON entity_provenance (space_id, confirmed_at DESC)
  WHERE confirmed_at IS NOT NULL;
