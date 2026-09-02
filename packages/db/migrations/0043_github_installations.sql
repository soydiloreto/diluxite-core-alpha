-- GitHub ingestion v1.1 — the connection, per organisation.
--
-- What is stored here is the point of the whole design: an `installation_id`,
-- which is NOT a credential. A personal access token would be: one person's
-- key, broad, long-lived, and this server would hold N of them belonging to
-- other people — so a breach here would hand over every customer's GitHub.
--
-- Instead the App's private key is ours and lives in the operator's
-- configuration, tokens are minted per run and last an hour, and what a
-- customer gives us is a number saying "this organisation installed you on
-- these repositories". Under SAML that also survives a person leaving, which a
-- token does not.
CREATE TABLE IF NOT EXISTS github_installations (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id text NOT NULL,
  -- Who installed it, as GitHub names them — shown in the admin screen so an
  -- admin can tell which account this is without opening GitHub.
  account_login text,
  -- The workspace ingested repositories land in. One space per installation
  -- keeps a customer's repos out of whatever else the organisation holds.
  space_id uuid REFERENCES spaces(id) ON DELETE SET NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  connected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  last_sync_at timestamptz,
  last_sync_error text
);

ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS github_installations_org_member ON github_installations;
CREATE POLICY github_installations_org_member ON github_installations
    USING (diluxite_is_org_member(org_id, diluxite_current_user_id()));

-- Which repositories are actually ingested, and what was last seen of each
-- file. The blob sha is the incremental contract: git's sha IS the content
-- hash, so a file whose sha matches cannot have changed, and a push costs a
-- tree listing plus the handful of blobs that moved.
CREATE TABLE IF NOT EXISTS github_repo_files (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  path text NOT NULL,
  blob_sha text NOT NULL,
  note_id uuid REFERENCES notes(id) ON DELETE SET NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, full_name, path)
);

CREATE INDEX IF NOT EXISTS github_repo_files_repo_idx
  ON github_repo_files (org_id, full_name);

ALTER TABLE github_repo_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_repo_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS github_repo_files_org_member ON github_repo_files;
CREATE POLICY github_repo_files_org_member ON github_repo_files
    USING (diluxite_is_org_member(org_id, diluxite_current_user_id()));
