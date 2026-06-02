-- Sessions metadata — ip + user agent + last_seen para "active sessions" UI.
--
-- El user puede ver desde Settings → Security qué sesiones están activas
-- (browser/device/IP) y revocar individualmente. last_seen_at se actualiza
-- en lookup; el UI ordena por last_seen DESC.
--
-- Las columnas son NULLABLE — sesiones viejas que existían antes de esta
-- migration no tienen estos datos; el UI los muestra como "—".

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS ip text,
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

CREATE INDEX IF NOT EXISTS sessions_user_last_seen_idx
  ON sessions (user_id, last_seen_at DESC NULLS LAST);
