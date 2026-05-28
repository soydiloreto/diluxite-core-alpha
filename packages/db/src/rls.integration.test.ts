import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleOrganizationsRepository } from './organizations-repository';
import { DrizzleSpacesRepository, DrizzleUsersRepository } from './spaces-repository';
import { notes as notesTable } from './schema';

/**
 * RLS smoke tests. The production app role will be a non-superuser so the
 * `FORCE ROW LEVEL SECURITY` policies installed by migration 0003 take
 * effect. In dev we connect as the superuser `diluxite`, which bypasses
 * RLS, so to actually exercise the policies we `SET ROLE` to a freshly
 * minted non-privileged role for the duration of each test and `RESET
 * ROLE` at the end.
 */
const { sql: rawSql, db } = getTestDb();

afterAll(async () => {
  await rawSql.end();
});

async function withRlsRole<T>(fn: () => Promise<T>): Promise<T> {
  await rawSql`DO $$ BEGIN
    CREATE ROLE rls_probe NOINHERIT;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`;
  await rawSql`GRANT USAGE ON SCHEMA public TO rls_probe`;
  await rawSql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_probe`;
  await rawSql`SET ROLE rls_probe`;
  try {
    return await fn();
  } finally {
    await rawSql`RESET ROLE`;
  }
}

describe('Row-Level Security policies (migration 0003)', () => {
  let owner: { id: string };
  let outsider: { id: string };
  let spaceId: string;
  let noteId: string;

  beforeEach(async () => {
    // Setup runs as the superuser (RLS bypassed) so we can seed.
    await truncateAll(rawSql);
    const orgs = new DrizzleOrganizationsRepository(db);
    const users = new DrizzleUsersRepository(db);
    const spaces = new DrizzleSpacesRepository(db);

    owner = await users.create('owner@diluxite');
    outsider = await users.create('outsider@diluxite');
    const org = await orgs.create('Acme', `acme-${Date.now()}`, owner.id);
    const space = await spaces.create(org.id, 'Space A', owner.id);
    spaceId = space.id;
    const [n] = await db
      .insert(notesTable)
      .values({ spaceId, title: 'secret', contentMd: 'private' })
      .returning({ id: notesTable.id });
    noteId = n.id;
  });

  it('lists every policy expected by the schema', async () => {
    const rows = await rawSql<{ tablename: string }[]>`
      SELECT tablename FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename`;
    const tables = rows.map((r) => r.tablename);
    for (const t of [
      'organizations',
      'org_memberships',
      'spaces',
      'memberships',
      'notes',
      'folders',
      'chunks',
      'note_tags',
      'note_links',
      'tokens',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it('with no identity set, an unprivileged role sees zero notes', async () => {
    await withRlsRole(async () => {
      await rawSql`SELECT set_config('app.current_user_id', '', true)`;
      const rows = await rawSql<{ count: number }[]>`SELECT COUNT(*)::int FROM notes`;
      expect(rows[0].count).toBe(0);
    });
  });

  it('with the owner identity, an unprivileged role sees the note', async () => {
    await withRlsRole(async () => {
      await rawSql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${owner.id}, true)`;
        const rows = await tx<{ id: string }[]>`SELECT id FROM notes WHERE id = ${noteId}`;
        expect(rows).toHaveLength(1);
      });
    });
  });

  it('with an outsider identity, the same role cannot see the note', async () => {
    await withRlsRole(async () => {
      await rawSql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${outsider.id}, true)`;
        const rows = await tx<{ id: string }[]>`SELECT id FROM notes WHERE id = ${noteId}`;
        expect(rows).toHaveLength(0);
      });
    });
  });

  it('cross-tenant: two orgs are perfectly isolated under RLS', async () => {
    const orgs = new DrizzleOrganizationsRepository(db);
    const users = new DrizzleUsersRepository(db);
    const spaces = new DrizzleSpacesRepository(db);
    const otherOwner = await users.create('other-owner@diluxite');
    const otherOrg = await orgs.create('Beta Inc', `beta-${Date.now()}`, otherOwner.id);
    const otherSpace = await spaces.create(otherOrg.id, 'Beta space', otherOwner.id);
    await db
      .insert(notesTable)
      .values({ spaceId: otherSpace.id, title: 'beta-only', contentMd: '' });

    await withRlsRole(async () => {
      await rawSql.begin(async (tx) => {
        // The original owner can see only their own org's notes.
        await tx`SELECT set_config('app.current_user_id', ${owner.id}, true)`;
        const rows = await tx<{ title: string }[]>`SELECT title FROM notes ORDER BY title`;
        const titles = rows.map((r) => r.title);
        expect(titles).toEqual(['secret']);
      });
    });

    await withRlsRole(async () => {
      await rawSql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${otherOwner.id}, true)`;
        const rows = await tx<{ title: string }[]>`SELECT title FROM notes ORDER BY title`;
        const titles = rows.map((r) => r.title);
        expect(titles).toEqual(['beta-only']);
      });
    });
  });

  // Drizzle-via-pool path; mirrors how the app uses withIdentity().
  it('uses set_config in a transaction (mirrors withIdentity)', async () => {
    void db; // sanity: db is the drizzle client used by the production app
    await rawSql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_user_id', ${owner.id}, true)`;
      // Superuser bypasses RLS so this still works; the unit test above
      // exercises the actual policy effect under SET ROLE.
      const rows = await tx<{ id: string }[]>`SELECT id FROM notes`;
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });
});
