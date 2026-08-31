-- Three roles, and one of them is not about an organisation — ADR-005.
--
--   setup_admin  the INSTALLATION: create organisations, instance settings
--   org_admin    one organisation: members, workspaces, its provider, delete it
--   org_member   ordinary access; a workspace still needs its own row
--
-- This replaces super_admin / admin / member. It is not a fourth level: the old
-- `super_admin` and `admin` differed only in "may delete the org" and "may
-- demote the owner", a distinction worth losing.
--
-- `setup_admin` lives on `users`, not in `org_memberships`, because it is not
-- about an organisation. And it is NOT a god over tenant data: administering
-- the installation does not entitle anyone to read what is stored in it —
-- reading an organisation's notes still needs membership in that organisation.

ALTER TABLE users ADD COLUMN IF NOT EXISTS setup_admin boolean NOT NULL DEFAULT false;

-- Who ran the installer becomes the first one. In a fresh install that is the
-- bootstrapped local user; in one that already has organisations it is
-- whoever held the highest role in the oldest of them, which is the closest
-- thing the old model recorded to "the person who set this up".
UPDATE users SET setup_admin = true
WHERE id IN (
  SELECT m.user_id
  FROM org_memberships m
  JOIN organizations o ON o.id = m.org_id
  WHERE m.role = 'super_admin'
  ORDER BY o.created_at ASC
  LIMIT 1
);

-- The organisation roles collapse two into one.
UPDATE org_memberships SET role = 'org_admin'  WHERE role IN ('super_admin', 'admin');
UPDATE org_memberships SET role = 'org_member' WHERE role = 'member';

-- Written down in the schema rather than only in the code that checks it: a
-- role outside this set is a bug that should fail on write, not on read.
ALTER TABLE org_memberships DROP CONSTRAINT IF EXISTS org_memberships_role_valid;
ALTER TABLE org_memberships ADD CONSTRAINT org_memberships_role_valid
  CHECK (role IN ('org_admin', 'org_member'));

-- An installation with no setup_admin is one nobody can configure. The guard
-- lives in the application (it needs to know who is asking); this index is
-- only here to make the lookup cheap, since every instance-wide route asks.
CREATE INDEX IF NOT EXISTS users_setup_admin_idx ON users (setup_admin) WHERE setup_admin;

-- AND THE FUNCTION THAT READS THEM. `diluxite_is_org_admin` is a SECURITY
-- DEFINER helper used by the RLS policies, and it matched the OLD role names.
-- Renaming the rows without it left every policy that depends on it matching
-- nothing — which denies rather than permits, so it failed loudly instead of
-- leaking, but it failed on every write to `org_settings`.
--
-- Worth stating plainly: a role rename is not a data migration. It is a data
-- migration plus every predicate that spells the role out.
CREATE OR REPLACE FUNCTION diluxite_is_org_admin(_org_id uuid, _user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT EXISTS (
        SELECT 1 FROM org_memberships m
        WHERE m.org_id = _org_id AND m.user_id = _user_id
          AND m.role = 'org_admin'
    ) $$;
