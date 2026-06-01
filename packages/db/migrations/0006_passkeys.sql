-- Fase 9 — WebAuthn passkeys: per-user credentials + transient ceremony state.

CREATE TABLE IF NOT EXISTS passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  counter integer NOT NULL DEFAULT 0,
  device_type text,
  label text NOT NULL DEFAULT 'passkey',
  transports text[] NOT NULL DEFAULT '{}'::text[],
  backed_up boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  last_used_at timestamp
);

CREATE INDEX IF NOT EXISTS passkeys_user_idx ON passkeys(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  challenge text NOT NULL UNIQUE,
  kind text NOT NULL,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webauthn_challenges_expires_idx ON webauthn_challenges(expires_at);
