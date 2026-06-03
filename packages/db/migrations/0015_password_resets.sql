-- Forgot-password flow (alpha.42).
--
-- POST /api/auth/forgot mints a random token, stores its SHA-256 hash in this
-- table with a short TTL (default 1h), and emails the user a link with the
-- plain token. POST /api/auth/reset looks up the row by hash, verifies
-- expiry + not-consumed, updates the user's password_hash, and marks the
-- token as consumed (we keep the row for audit, NOT for re-use).
--
-- Token rotation: requesting forgot when a fresh unconsumed token exists is
-- allowed (the new one supersedes it; the old one stays in the table but
-- the consumed_at vs expires_at check makes it harmless if leaked later).

CREATE TABLE IF NOT EXISTS password_resets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamp NOT NULL,
  consumed_at   timestamp,
  requested_ip  text,
  created_at    timestamp NOT NULL DEFAULT NOW()
);

-- Lookup by hash (only path the API takes) — UNIQUE already creates it.
-- Index on user_id for "are there outstanding tokens for this user?" queries
-- (not used today but cheap and natural).
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id);

-- Sweep expired tokens (purely operational — UNIQUE keeps the hot path fast).
CREATE INDEX IF NOT EXISTS password_resets_expires_idx ON password_resets(expires_at);
