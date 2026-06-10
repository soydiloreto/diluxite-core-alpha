-- Re-sync Row-Level Security with the schema as it stands today (defense in
-- depth). Two problems are fixed here:
--
--  (a) The `tokens_owner` policy from 0003 predates org tokens (0005). It only
--      matched `user_id = current_user`, so an ORG token (user_id IS NULL,
--      org_id set) was INVISIBLE under a non-BYPASSRLS role — breaking
--      `resolveToken` / org-token auth the moment the app stops connecting as
--      a superuser. We replace it with a policy that ALSO lets org members see
--      their org's tokens.
--
--  (b) Every auth/security table created AFTER 0003 (sessions, passkeys,
--      webauthn_challenges, org_settings, oidc_ceremonies, audit_events,
--      totp_secrets, password_resets) shipped with NO RLS at all. We enable +
--      FORCE RLS and add coherent, deny-by-default policies.
--
-- IMPORTANT — this migration does NOT change how the app connects. Production
-- still connects as the owner/superuser today, where RLS is effectively a
-- no-op (owners are exempt unless FORCE, and superusers bypass entirely). The
-- goal is to make the RLS layer CORRECT so that switching the app to a
-- non-privileged role later is safe — that switch is the owner's call and is
-- out of scope here.
--
-- Pre-identity flows: `password_resets`, `webauthn_challenges` and
-- `oidc_ceremonies` are looked up by an opaque token/hash/state BEFORE any
-- user identity exists in the session (the whole point of the reset / login /
-- OIDC-callback flows). Scoping them by `diluxite_current_user_id()` would
-- return zero rows and BREAK those flows. They are therefore intentionally
-- handled by a SERVICE ROLE only: RLS is enabled with NO permissive policy
-- (deny-by-default for tenant roles), and the service that runs these flows is
-- expected to hold BYPASSRLS (today: the owner/superuser connection). This is
-- documented, deliberate, and must stay that way until those flows are
-- refactored to set an identity first.

-- ── (a) tokens: user tokens OR org tokens visible to org members ──────────
DROP POLICY IF EXISTS tokens_owner ON tokens;

CREATE POLICY tokens_owner_or_org ON tokens
    USING (
        -- User token: visible to its owner (unchanged semantics).
        (tokens.user_id IS NOT NULL AND tokens.user_id = diluxite_current_user_id())
        OR
        -- Org (service) token: visible to any member of the owning org.
        (tokens.user_id IS NULL AND tokens.org_id IS NOT NULL
         AND diluxite_is_org_member(tokens.org_id, diluxite_current_user_id()))
    );

-- ── (b) Auth/security tables created after 0003 ───────────────────────────

-- sessions — scoped to the owning user.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_owner ON sessions
    USING (sessions.user_id = diluxite_current_user_id());

-- passkeys — scoped to the owning user.
ALTER TABLE passkeys ENABLE ROW LEVEL SECURITY; ALTER TABLE passkeys FORCE ROW LEVEL SECURITY;
CREATE POLICY passkeys_owner ON passkeys
    USING (passkeys.user_id = diluxite_current_user_id());

-- totp_secrets — scoped to the owning user.
ALTER TABLE totp_secrets ENABLE ROW LEVEL SECURITY; ALTER TABLE totp_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY totp_secrets_owner ON totp_secrets
    USING (totp_secrets.user_id = diluxite_current_user_id());

-- org_settings — scoped to admins of the org (only org admins edit policy).
ALTER TABLE org_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE org_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_settings_admin ON org_settings
    USING (diluxite_is_org_admin(org_settings.org_id, diluxite_current_user_id()));

-- audit_events — scoped to admins of the event's org. Events with a NULL
-- org_id (system/global events) are intentionally NOT visible to any tenant
-- role; only the service role (BYPASSRLS) reads those.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_org_admin ON audit_events
    USING (
        audit_events.org_id IS NOT NULL
        AND diluxite_is_org_admin(audit_events.org_id, diluxite_current_user_id())
    );

-- password_resets / webauthn_challenges / oidc_ceremonies — pre-identity
-- flows (see header). RLS ENABLED + FORCED with NO permissive policy:
-- deny-by-default for tenant roles; the service role (BYPASSRLS) drives them.
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY; ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
ALTER TABLE webauthn_challenges ENABLE ROW LEVEL SECURITY; ALTER TABLE webauthn_challenges FORCE ROW LEVEL SECURITY;
ALTER TABLE oidc_ceremonies ENABLE ROW LEVEL SECURITY; ALTER TABLE oidc_ceremonies FORCE ROW LEVEL SECURITY;
