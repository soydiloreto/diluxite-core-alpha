-- Fase 1.1 — OIDC ceremony state.
--
-- Cuando un user inicia el flow OIDC, generamos state + nonce + codeVerifier
-- (PKCE). El verifier es SECRETO y no puede ir al browser. Lo guardamos
-- server-side en esta tabla, indexado por state (el ID público que sí
-- viaja al IdP y vuelve en la callback). Expira a los 10 minutos —
-- ceremonies abandonadas se barren.

CREATE TABLE IF NOT EXISTS oidc_ceremonies (
  state text PRIMARY KEY,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS oidc_ceremonies_expires_idx
  ON oidc_ceremonies(expires_at);
