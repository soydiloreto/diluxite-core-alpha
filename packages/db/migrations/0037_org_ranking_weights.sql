-- What standing is worth in the order.
--
-- Until now ADR-002's third axis was inert: a note past its own cadence got a
-- badge and kept its position, and a superseded one ranked exactly like a live
-- one. A warning that changes nothing is a warning nobody acts on.
--
-- Multipliers, per organisation, because this is the one part of the line
-- where the criterion genuinely differs between a company and one person's
-- second brain. The ageing estimate itself is per note and needs nobody's
-- opinion — that is measured, and it is not configurable on purpose.
--
-- The defaults are deliberately NOT neutral: mild for age (being overdue is a
-- suspicion), firm for expired (somebody said it stops being true). Showing
-- expired results marked rather than hiding them is the same call archiving
-- made, for the same reason: in a memory for an AI, what search cannot reach
-- has been forgotten, not filed.
ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS rank_weight_preferred real NOT NULL DEFAULT 1.2,
  ADD COLUMN IF NOT EXISTS rank_weight_stale     real NOT NULL DEFAULT 0.9,
  ADD COLUMN IF NOT EXISTS rank_weight_expired   real NOT NULL DEFAULT 0.4,
  ADD COLUMN IF NOT EXISTS rank_hide_expired     boolean NOT NULL DEFAULT false;

-- A multiplier outside this range is not a preference, it is a typo that
-- silently rewrites every answer. Refused at the table so no route can be the
-- only thing standing between a fat finger and the ranking.
ALTER TABLE org_settings
  ADD CONSTRAINT org_settings_rank_weights_sane CHECK (
    rank_weight_preferred BETWEEN 1 AND 3
    AND rank_weight_stale BETWEEN 0 AND 1
    AND rank_weight_expired BETWEEN 0 AND 1
  );
