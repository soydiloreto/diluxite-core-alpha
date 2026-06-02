-- Fase 1.0 — Schema necesario para enterprise-ready auth.
--
-- 1) `users` gana: first_name, last_name (poblados por CSV import + OIDC
--    claims), active (soft-disable preservando historial), last_login_at
--    (telemetría para deprovision automático).
--
-- 2) `org_settings` nueva tabla. Hoy solo lleva authPolicy — "qué hacemos
--    cuando un user pasa SSO/IdP pero no está en nuestra users table".
--    Tres valores: deny_unknown | allow_unknown_as_member (default) |
--    pre_provisioned_only.
--
-- Backwards-compat: las columnas nuevas en users son NULL/default, las
-- filas viejas no se rompen. `org_settings` se popula on-demand vía
-- INSERT … ON CONFLICT DO NOTHING en la primera consulta.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_login_at timestamp;

CREATE INDEX IF NOT EXISTS users_active_idx ON users(active) WHERE active = false;
CREATE INDEX IF NOT EXISTS users_last_login_idx ON users(last_login_at);

CREATE TABLE IF NOT EXISTS org_settings (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  auth_policy text NOT NULL DEFAULT 'allow_unknown_as_member',
  updated_at timestamp NOT NULL DEFAULT NOW()
);

-- Lightweight check — three valid values, fail fast if a bad migration
-- writes something else.
ALTER TABLE org_settings
  ADD CONSTRAINT org_settings_auth_policy_check
  CHECK (auth_policy IN ('deny_unknown', 'allow_unknown_as_member', 'pre_provisioned_only'));
