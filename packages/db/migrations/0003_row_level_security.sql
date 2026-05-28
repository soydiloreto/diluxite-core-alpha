-- v4.2 — Row-Level Security across tenant-scoped tables.
--
-- Why: shared-schema multi-tenancy needs defense in depth. RLS makes the
-- database refuse rows the current user isn't entitled to even if the
-- application forgets a WHERE. See docs/MULTI-TENANT.md.
--
-- The per-request user identity is published via:
--   SELECT set_config('app.current_user_id', '<uuid>', true);
--
-- Cycle-breaking: a policy on table A that joins to table B which has its
-- own policy querying A creates infinite recursion. We solve it by
-- centralising the membership checks in SECURITY DEFINER functions —
-- those run with the privileges of the function owner and therefore skip
-- RLS, breaking the cycle.

-- ── Helpers (SECURITY DEFINER bypass RLS by design) ────────────────────
CREATE OR REPLACE FUNCTION diluxite_current_user_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION diluxite_is_workspace_member(_space_id uuid, _user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT EXISTS (
        SELECT 1 FROM memberships m WHERE m.space_id = _space_id AND m.user_id = _user_id
    ) $$;

CREATE OR REPLACE FUNCTION diluxite_is_org_admin(_org_id uuid, _user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT EXISTS (
        SELECT 1 FROM org_memberships m
        WHERE m.org_id = _org_id AND m.user_id = _user_id
          AND m.role IN ('super_admin', 'admin')
    ) $$;

CREATE OR REPLACE FUNCTION diluxite_is_org_member(_org_id uuid, _user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT EXISTS (
        SELECT 1 FROM org_memberships m WHERE m.org_id = _org_id AND m.user_id = _user_id
    ) $$;

-- Combined predicate: the user can see this workspace if they are a direct
-- member OR an admin of the workspace's org.
CREATE OR REPLACE FUNCTION diluxite_can_access_space(_space_id uuid, _user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM spaces s
        WHERE s.id = _space_id
          AND (
            diluxite_is_workspace_member(s.id, _user_id)
            OR diluxite_is_org_admin(s.org_id, _user_id)
          )
    )
    $$;

-- ── Enable RLS ──────────────────────────────────────────────────────────
-- FORCE makes RLS apply even to the table owner (Postgres exempts owners
-- by default). Superusers and roles with BYPASSRLS still bypass — in
-- production the API should connect as a non-superuser role.
ALTER TABLE organizations    ENABLE ROW LEVEL SECURITY; ALTER TABLE organizations    FORCE ROW LEVEL SECURITY;
ALTER TABLE org_memberships  ENABLE ROW LEVEL SECURITY; ALTER TABLE org_memberships  FORCE ROW LEVEL SECURITY;
ALTER TABLE spaces           ENABLE ROW LEVEL SECURITY; ALTER TABLE spaces           FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships      ENABLE ROW LEVEL SECURITY; ALTER TABLE memberships      FORCE ROW LEVEL SECURITY;
ALTER TABLE notes            ENABLE ROW LEVEL SECURITY; ALTER TABLE notes            FORCE ROW LEVEL SECURITY;
ALTER TABLE folders          ENABLE ROW LEVEL SECURITY; ALTER TABLE folders          FORCE ROW LEVEL SECURITY;
ALTER TABLE note_tags        ENABLE ROW LEVEL SECURITY; ALTER TABLE note_tags        FORCE ROW LEVEL SECURITY;
ALTER TABLE note_links       ENABLE ROW LEVEL SECURITY; ALTER TABLE note_links       FORCE ROW LEVEL SECURITY;
ALTER TABLE chunks           ENABLE ROW LEVEL SECURITY; ALTER TABLE chunks           FORCE ROW LEVEL SECURITY;
ALTER TABLE tokens           ENABLE ROW LEVEL SECURITY; ALTER TABLE tokens           FORCE ROW LEVEL SECURITY;

-- ── Policies ────────────────────────────────────────────────────────────
CREATE POLICY organizations_member_visibility ON organizations
    USING (diluxite_is_org_member(organizations.id, diluxite_current_user_id()));

CREATE POLICY org_memberships_member_visibility ON org_memberships
    USING (diluxite_is_org_member(org_memberships.org_id, diluxite_current_user_id()));

CREATE POLICY spaces_member_or_org_admin ON spaces
    USING (
        diluxite_is_workspace_member(spaces.id, diluxite_current_user_id())
        OR diluxite_is_org_admin(spaces.org_id, diluxite_current_user_id())
    );

CREATE POLICY memberships_visibility ON memberships
    USING (diluxite_can_access_space(memberships.space_id, diluxite_current_user_id()));

CREATE POLICY notes_space_member ON notes
    USING (diluxite_can_access_space(notes.space_id, diluxite_current_user_id()));

CREATE POLICY folders_space_member ON folders
    USING (diluxite_can_access_space(folders.space_id, diluxite_current_user_id()));

CREATE POLICY chunks_space_member ON chunks
    USING (diluxite_can_access_space(chunks.space_id, diluxite_current_user_id()));

CREATE POLICY note_tags_space_member ON note_tags
    USING (diluxite_can_access_space(note_tags.space_id, diluxite_current_user_id()));

CREATE POLICY note_links_space_member ON note_links
    USING (diluxite_can_access_space(note_links.space_id, diluxite_current_user_id()));

CREATE POLICY tokens_owner ON tokens
    USING (user_id = diluxite_current_user_id());
