-- The unprivileged role the data plane runs as — ADR-004.
--
-- Row-Level Security has been in this schema since migration 0003 and has
-- never once applied: the API connects as the database owner, which the
-- container image creates as a superuser, and superusers plus BYPASSRLS roles
-- are exempt from RLS EVEN WITH `FORCE ROW LEVEL SECURITY`. The policies were
-- correct and inert.
--
-- This creates the role that is not exempt. Nothing changes on its own: the
-- application opts in per operation with `SET LOCAL ROLE`, which reverts at
-- commit, so a deployment that never opts in behaves exactly as before.
--
-- WHY NO SECOND CONNECTION STRING: `SET LOCAL ROLE` needs the connecting user
-- to be a member of the target role, not a new login. The GRANT below arranges
-- that, so `install.sh`, docker-compose and every existing deployment are
-- untouched beyond running this migration. Verified against a non-superuser
-- owner, which is the case that would otherwise have been left behind.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diluxite_app') THEN
    -- NOLOGIN: it is never connected to directly, only assumed.
    -- NOINHERIT: assuming it must not silently carry the owner's rights.
    CREATE ROLE diluxite_app NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO diluxite_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO diluxite_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO diluxite_app;

-- Tables created by LATER migrations would otherwise be invisible to the role,
-- and the failure would be a permission error in production long after this
-- migration ran.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO diluxite_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO diluxite_app;

-- The membership that makes `SET LOCAL ROLE diluxite_app` legal for whoever
-- the application connects as. A superuser does not need it; a hardened
-- install that connects as a plain owner does.
DO $$
BEGIN
  EXECUTE format('GRANT diluxite_app TO %I', current_user);
EXCEPTION WHEN OTHERS THEN
  -- Already a member, or the grantor lacks the right. Neither is fatal here:
  -- the application checks at boot whether it can assume the role and says so.
  NULL;
END $$;
