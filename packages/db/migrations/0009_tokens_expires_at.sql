-- Hardening alpha.22 — opcional TTL para tokens API/MCP + revocación masiva.
--
-- Backwards-compat: la columna es NULL por default. NULL significa "no
-- expira" (el comportamiento actual de los tokens minteados antes de esta
-- migration se preserva). Cuando un cliente quiere TTL, mintea con un
-- `expiresInDays` explícito y `expires_at = NOW() + interval N days`.
--
-- Para revocar masivamente: `DELETE FROM tokens WHERE user_id = ?` o
-- `DELETE FROM tokens WHERE org_id = ?`. Ambos están ya cubiertos por las
-- queries existentes; este parche solo agrega la columna + un partial
-- index para barrer expirados en chequeos rápidos.

ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS expires_at timestamp;

CREATE INDEX IF NOT EXISTS tokens_expires_at_idx
  ON tokens(expires_at)
  WHERE expires_at IS NOT NULL;
