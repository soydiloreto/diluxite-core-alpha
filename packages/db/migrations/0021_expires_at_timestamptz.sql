-- Promote the `expires_at` TTL columns from `timestamp` (no tz) to
-- `timestamptz`.
--
-- Why: these columns are compared against `NOW()` / `::timestamptz` in the
-- repos (token validity, session expiry, reset/oidc expiry). A naked
-- `timestamp` is interpreted in the *session* time zone on every comparison,
-- so the answer to "is this expired?" silently depended on the connection's
-- TZ setting. `timestamptz` pins the instant and removes that ambiguity.
--
-- The existing values were written as UTC instants (Date.toISOString() /
-- NOW() under UTC servers), so we reinterpret the stored wall-clock as UTC:
--   USING expires_at AT TIME ZONE 'UTC'
-- which yields the correct absolute instant.

ALTER TABLE sessions
  ALTER COLUMN expires_at TYPE timestamptz USING expires_at AT TIME ZONE 'UTC';

ALTER TABLE tokens
  ALTER COLUMN expires_at TYPE timestamptz USING expires_at AT TIME ZONE 'UTC';

ALTER TABLE password_resets
  ALTER COLUMN expires_at TYPE timestamptz USING expires_at AT TIME ZONE 'UTC';

ALTER TABLE oidc_ceremonies
  ALTER COLUMN expires_at TYPE timestamptz USING expires_at AT TIME ZONE 'UTC';
