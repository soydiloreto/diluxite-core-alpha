-- What a correction is worth in the order.
--
-- An agent that learns "approach X failed, do Y instead" and writes it down has
-- produced the most valuable thing in the memory: knowledge that cost somebody
-- a mistake. When a later question matches it, it should arrive first.
--
-- NOT a document type, and that is the point. ADR-002 refuses knowledge classes
-- as a data model, so a correction is not a kind of note — it is a note whose
-- PROV-O activity says how it came to exist (`generated_by = 'correction'`).
-- The axes that already exist carry it, and nothing new has to be maintained,
-- migrated, or explained to a user.
ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS rank_weight_correction real NOT NULL DEFAULT 1.5;

ALTER TABLE org_settings
  ADD CONSTRAINT org_settings_correction_weight_sane
    CHECK (rank_weight_correction BETWEEN 1 AND 3);
