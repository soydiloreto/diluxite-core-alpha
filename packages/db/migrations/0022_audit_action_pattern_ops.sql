-- The Admin → Audit UI filters by action PREFIX (`action LIKE 'prefix%'`).
-- A plain btree index on `action` only helps a `LIKE 'x%'` scan when the DB
-- collation is C/POSIX; under any other collation (the usual case) the
-- planner can't use it and falls back to a seq scan over the whole audit log.
--
-- Recreate the index with `text_pattern_ops`, which orders by raw byte value
-- and makes prefix LIKE index-usable regardless of collation. Equality lookups
-- still use it too. (The dotted-prefix convention on `action`, e.g.
-- "auth.login.success", is exactly a prefix-LIKE workload.)

DROP INDEX IF EXISTS audit_events_action_idx;

CREATE INDEX IF NOT EXISTS audit_events_action_idx
  ON audit_events USING btree (action text_pattern_ops);
