-- Fase audit — registro inmutable de eventos de seguridad y administración.
--
-- Objetivo: dejar el "quién hizo qué cuándo desde dónde" para compliance
-- baseline (SOC 2 CC7 / ISO 27001 A.12.4). NO es un log de aplicación
-- general — eso va a stdout / stderr y lo capturás con tu stack de logs.
--
-- Lo que va acá:
--   * login / logout (éxito y fallo).
--   * Promotions / demotions de roles.
--   * Cambios de auth-policy.
--   * CSV import (con contadores de created/updated).
--   * Token mints / revokes (incluye revoke-all).
--   * Passkey register / revoke.
--   * OIDC sign-in (JIT y existing user).
--
-- Diseño:
--   * actor_id puede ser NULL: login fallido no tiene actor identificado
--     (capturamos el email intentado en metadata.attempted_email).
--   * org_id puede ser NULL para eventos de instalación (ej. bootstrap admin).
--   * action es texto libre con convención dotted ("auth.login.success",
--     "admin.user.role_changed", "admin.token.revoked_all"). Mantener la
--     convención permite filtrar por prefijo sin requerir un enum cerrado
--     que requiera migrations cada vez que agregamos un evento.
--   * metadata jsonb captura detalles que NO queremos como columnas
--     porque cambian por evento (counts del import, scope del token, etc).
--   * ip y user_agent capturados desde la request — útiles para detectar
--     compromiso ("login desde Vietnam a las 3am").
--
-- Retention: NO se borra automático. Los enterprises tienen su propio
-- ciclo (60d / 1y / 7y según SOC 2). Una future migration agregará un
-- job opcional `DILUXITE_AUDIT_RETENTION_DAYS`.

CREATE TABLE IF NOT EXISTS audit_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  org_id      uuid REFERENCES organizations(id) ON DELETE SET NULL,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  resource    text,
  ip          text,
  user_agent  text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Indexes para los filtros típicos del UI (por org, por actor, por
-- action prefix, por fecha). `at DESC` cubre "los últimos N eventos",
-- el caso más común del UI.
CREATE INDEX IF NOT EXISTS audit_events_at_idx ON audit_events (at DESC);
CREATE INDEX IF NOT EXISTS audit_events_org_at_idx ON audit_events (org_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events (actor_id);
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action);
