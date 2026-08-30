import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb } from './client';
import {
  checkScopeUsable,
  currentScope,
  runInScope,
  scopedDb,
  tenantScoped,
} from './tenant-scope';

/**
 * The mechanism that makes Postgres enforce tenancy — ADR-004.
 *
 * Every assertion here is about a failure that is INVISIBLE when it happens:
 * an instance that never enters the scope, or enters it as a role that is
 * exempt from RLS, behaves exactly like one with no policies at all. Nothing
 * in the product looks different. So the tests check the two things that
 * cannot be inferred from behaviour — which role is in force, and whether the
 * policies actually filtered — rather than only that the right rows came back.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

const conn = createDb(TEST_DATABASE_URL);
const { db: pool, sql: raw } = conn;

/** A repository shaped like the real ones: it holds a `Db` and awaits on it. */
class Probe {
  constructor(private readonly db: ReturnType<typeof scopedDb>) {}
  async whoAmI() {
    const r = await this.db.execute<{ role: string; superuser: string; uid: string | null }>(sql`
      SELECT current_user AS role,
             current_setting('is_superuser') AS superuser,
             NULLIF(current_setting('app.current_user_id', true), '') AS uid`);
    return r[0];
  }
  async countNotes() {
    const r = await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM notes`);
    return r[0].n;
  }
  /** Titles this identity can see, restricted to the ones this suite made. */
  async myTitles(stamp: string) {
    const r = await this.db.execute<{ title: string }>(sql`
      SELECT title FROM notes WHERE title LIKE ${`%${stamp}`} ORDER BY title`);
    return r.map((x) => x.title);
  }
  /** Calls another method: the nested call must reuse the open transaction. */
  async nested() {
    const outer = await this.whoAmI();
    const inner = await this.whoAmI();
    return { outer, inner };
  }
}

const probe = tenantScoped(new Probe(scopedDb(pool)), pool);

let owner: string;
let outsider: string;
/** Distinguishes this suite's rows from whatever other suites leave behind. */
let stamp: string;

beforeAll(async () => {
  stamp = String(Date.now());
  const mk = async (tag: string) => {
    const [u] = await raw<{ id: string }[]>`
      INSERT INTO users (email) VALUES (${`${tag}${stamp}@scope.test`}) RETURNING id`;
    const [o] = await raw<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES (${tag}, ${`${tag}${stamp}`}) RETURNING id`;
    await raw`INSERT INTO org_memberships (org_id, user_id, role) VALUES (${o.id}, ${u.id}, 'super_admin')`;
    const [s] = await raw<{ id: string }[]>`
      INSERT INTO spaces (org_id, name, owner_id) VALUES (${o.id}, ${tag}, ${u.id}) RETURNING id`;
    await raw`INSERT INTO memberships (space_id, user_id, role) VALUES (${s.id}, ${u.id}, 'admin')`;
    await raw`INSERT INTO notes (space_id, title, content_md)
              VALUES (${s.id}, ${`nota de ${tag} ${stamp}`}, 'x')`;
    return u.id;
  };
  owner = await mk('scopeA');
  outsider = await mk('scopeB');
});

afterAll(async () => {
  await raw.end();
});

describe('the scope', () => {
  it('this installation can actually enforce it', async () => {
    // If this fails, everything below is theatre: the policies exist, and the
    // connection is exempt from them.
    const { ok, reason } = await checkScopeUsable(pool);
    expect(ok, `cannot assume diluxite_app: ${reason}`).toBe(true);
  });

  it('outside a scope, work runs privileged — migrations and bootstrap need that', async () => {
    const who = await probe.whoAmI();
    expect(who.superuser).toBe('on');
    expect(who.uid).toBeNull();
    // And it sees BOTH organisations' notes, which is exactly why the data
    // plane must not run here.
    expect(await probe.myTitles(stamp)).toHaveLength(2);
  });

  it('inside a scope with no user, work still runs privileged — that is the auth plane', async () => {
    const who = await runInScope(null, () => probe.whoAmI());
    expect(who.superuser).toBe('on');
  });

  it('inside a scope with a user, work runs as the unprivileged role', async () => {
    const who = await runInScope(owner, () => probe.whoAmI());
    expect(who.role).toBe('diluxite_app');
    expect(who.superuser).toBe('off');
    expect(who.uid).toBe(owner);
  });

  it('and the policies filter: each user sees only their own notes', async () => {
    // By title rather than by count: the count of a shared test database
    // depends on whatever else is running, which made this assertion fail for
    // a reason that had nothing to do with tenancy.
    const a = await runInScope(owner, () => probe.myTitles(stamp));
    const b = await runInScope(outsider, () => probe.myTitles(stamp));
    expect(a).toEqual([`nota de scopeA ${stamp}`]);
    expect(b).toEqual([`nota de scopeB ${stamp}`]);
  });

  it('fails CLOSED when the identity is missing rather than open', async () => {
    // A scope whose user id is a stranger sees nothing. The direction matters:
    // an RLS mistake that fails open is worse than no RLS, because it looks
    // like protection.
    const nobody = '00000000-0000-0000-0000-000000000000';
    expect(await runInScope(nobody, () => probe.myTitles(stamp))).toEqual([]);
  });

  it('the role reverts when the scope ends', async () => {
    await runInScope(owner, () => probe.whoAmI());
    const after = await probe.whoAmI();
    expect(after.role).not.toBe('diluxite_app');
    expect(after.superuser).toBe('on');
  });

  it('a nested call reuses the open transaction instead of opening a second', async () => {
    const { outer, inner } = await runInScope(owner, () => probe.nested());
    expect(outer.uid).toBe(owner);
    expect(inner.uid).toBe(owner);
    expect(inner.role).toBe('diluxite_app');
  });

  it('concurrent scopes do not contaminate each other', async () => {
    // The property a pooled connection would silently break. The first scope
    // is deliberately slower, so the second finishes inside it.
    const [a, b] = await Promise.all([
      runInScope(owner, async () => {
        await new Promise((r) => setTimeout(r, 60));
        return probe.whoAmI();
      }),
      runInScope(outsider, () => probe.whoAmI()),
    ]);
    expect(a.uid).toBe(owner);
    expect(b.uid).toBe(outsider);
  });

  it('does not hold a connection while non-database work runs', async () => {
    // The reason the scope is per METHOD and not per request: Diluxite calls
    // an embedding model on every save and every search, 100 ms to 2 s, and a
    // request-long scope would park a pooled connection for the duration.
    await runInScope(owner, async () => {
      await probe.myTitles(stamp);
      await new Promise((r) => setTimeout(r, 200)); // stands in for the model
      const [{ n }] = await raw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'idle in transaction'`;
      expect(n, 'a connection was left idle in transaction').toBe(0);
      await probe.myTitles(stamp);
    });
  });

  it('reports the identity in force, for code that needs to know', async () => {
    expect(currentScope()).toBeUndefined();
    await runInScope(owner, async () => {
      expect(currentScope()?.userId).toBe(owner);
    });
  });
});
