import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleOrganizationsRepository } from './organizations-repository';
import { DrizzleSpacesRepository, DrizzleUsersRepository } from './spaces-repository';
import { DrizzleTokensRepository } from './tokens-repository';
import { notes as notesTable, sessions as sessionsTable, tokens as tokensTable } from './schema';

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

/**
 * RLS re-sync (migration 0019) — isolation under a real NON-SUPERUSER role.
 *
 * This is the test that proves the RLS layer actually keeps tenants apart:
 * we `SET ROLE` to `diluxite_app` (NOINHERIT, NO BYPASSRLS) and confirm that
 * one user cannot see another's notes, tokens, or sessions, AND that the
 * org-token fix (org tokens visible to org members) holds. The production
 * app does NOT connect as this role today (it's the owner's call to switch);
 * here we only verify the policies are correct as defense in depth.
 */
describe('RLS isolation under a non-superuser role (migration 0019)', () => {
  let userA: { id: string };
  let userB: { id: string };
  let orgA: string;
  let spaceA: string;
  let noteA: string;
  let tokenAId: string;
  let orgTokenId: string;
  let sessionAId: string;

  beforeEach(async () => {
    await truncateAll(rawSql);
    // sessions/tokens are not in truncateAll's CASCADE root set; clear them.
    await rawSql`TRUNCATE sessions, tokens RESTART IDENTITY CASCADE`;
    const orgs = new DrizzleOrganizationsRepository(db);
    const users = new DrizzleUsersRepository(db);
    const spaces = new DrizzleSpacesRepository(db);
    const tokensRepo = new DrizzleTokensRepository(db);

    userA = await users.create('a-iso@diluxite');
    userB = await users.create('b-iso@diluxite');
    const org = await orgs.create('OrgA', `orga-${Date.now()}`, userA.id);
    orgA = org.id;
    const space = await spaces.create(orgA, 'A space', userA.id);
    spaceA = space.id;
    const [n] = await db
      .insert(notesTable)
      .values({ spaceId: spaceA, title: 'a-secret', contentMd: '' })
      .returning({ id: notesTable.id });
    noteA = n.id;

    // A user token for A and an org token for OrgA.
    const ut = await tokensRepo.create(userA.id, 'a-token');
    tokenAId = ut.info.id;
    const ot = await tokensRepo.createOrgToken(orgA, 'svc', ['read']);
    orgTokenId = ot.info.id;

    // A session for A.
    const [s] = await db
      .insert(sessionsTable)
      .values({
        userId: userA.id,
        tokenHash: `hash-${Date.now()}`,
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning({ id: sessionsTable.id });
    sessionAId = s.id;
  });

  async function asApp<T>(fn: (q: typeof rawSql) => Promise<T>): Promise<T> {
    await rawSql`DO $$ BEGIN
      CREATE ROLE diluxite_app NOLOGIN NOINHERIT;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`;
    await rawSql`GRANT USAGE ON SCHEMA public TO diluxite_app`;
    await rawSql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO diluxite_app`;
    await rawSql`SET ROLE diluxite_app`;
    try {
      return await fn(rawSql);
    } finally {
      await rawSql`RESET ROLE`;
    }
  }

  it('the diluxite_app role is non-superuser and has no BYPASSRLS', async () => {
    await asApp(async (q) => {
      const [r] = await q<{ super: boolean; bypass: boolean }[]>`
        SELECT rolsuper AS super, rolbypassrls AS bypass
        FROM pg_roles WHERE rolname = current_user`;
      expect(r.super).toBe(false);
      expect(r.bypass).toBe(false);
    });
  });

  it('user A sees only their own notes; user B sees none of them', async () => {
    await asApp((q) =>
      q.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${userA.id}, true)`;
        const a = await tx<{ id: string }[]>`SELECT id FROM notes WHERE id = ${noteA}`;
        expect(a).toHaveLength(1);
      }),
    );
    await asApp((q) =>
      q.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${userB.id}, true)`;
        const b = await tx<{ id: string }[]>`SELECT id FROM notes WHERE id = ${noteA}`;
        expect(b).toHaveLength(0);
      }),
    );
  });

  it('user tokens are isolated: B cannot see A’s token', async () => {
    await asApp((q) =>
      q.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${userA.id}, true)`;
        const a = await tx<{ id: string }[]>`SELECT id FROM tokens WHERE id = ${tokenAId}`;
        expect(a).toHaveLength(1);
      }),
    );
    await asApp((q) =>
      q.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${userB.id}, true)`;
        const b = await tx<{ id: string }[]>`SELECT id FROM tokens WHERE id = ${tokenAId}`;
        expect(b).toHaveLength(0);
      }),
    );
  });

  it('ORG tokens are visible to org members (the 0019 fix) but not outsiders', async () => {
    // Before 0019 the policy was `user_id = current_user`, so org tokens
    // (user_id IS NULL) were invisible to EVERYONE under RLS — breaking
    // org-token auth. Now a member of OrgA can resolve it; userB cannot.
    await asApp((q) =>
      q.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${userA.id}, true)`;
        const a = await tx<{ id: string }[]>`SELECT id FROM tokens WHERE id = ${orgTokenId}`;
        expect(a).toHaveLength(1);
      }),
    );
    await asApp((q) =>
      q.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${userB.id}, true)`;
        const b = await tx<{ id: string }[]>`SELECT id FROM tokens WHERE id = ${orgTokenId}`;
        expect(b).toHaveLength(0);
      }),
    );
  });

  it('sessions are isolated: B cannot see A’s session', async () => {
    await asApp((q) =>
      q.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${userA.id}, true)`;
        const a = await tx<{ id: string }[]>`SELECT id FROM sessions WHERE id = ${sessionAId}`;
        expect(a).toHaveLength(1);
      }),
    );
    await asApp((q) =>
      q.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${userB.id}, true)`;
        const b = await tx<{ id: string }[]>`SELECT id FROM sessions WHERE id = ${sessionAId}`;
        expect(b).toHaveLength(0);
      }),
    );
  });

  it('every auth table now has RLS enabled + forced', async () => {
    const rows = await rawSql<{ relname: string; rls: boolean; forced: boolean }[]>`
      SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS forced
      FROM pg_class
      WHERE relname IN (
        'sessions','passkeys','webauthn_challenges','org_settings',
        'oidc_ceremonies','audit_events','totp_secrets','password_resets','tokens'
      ) ORDER BY relname`;
    for (const r of rows) {
      expect(r.rls, `${r.relname} RLS enabled`).toBe(true);
      expect(r.forced, `${r.relname} RLS forced`).toBe(true);
    }
  });
});
