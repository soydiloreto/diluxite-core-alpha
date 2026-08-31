import { describe, it, expect } from 'vitest';
import postgres from 'postgres';
import { runMigrations } from './migrate';

/**
 * Every migration, on a database that has never seen one.
 *
 * A development database is a database that has been mutated by hand: tables
 * dropped, migrations re-run, constraints added out of band. It no longer has
 * the shape a migration actually meets on a first install, so it cannot
 * validate one.
 *
 * This exists because migration 0031 passed locally and failed in CI on
 * precisely that difference: it moved `embedding_models`' primary key while
 * `chunk_embeddings.model_key` still referenced it — a foreign key that only
 * exists on a database where 0027 ran and nothing had since dropped the table
 * by hand. The order the migration needed was the order a first-ever run
 * needs, and only a first-ever run could show it.
 */

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * One stable throwaway database whose SCHEMA is reset, rather than a database
 * created and dropped per run.
 *
 * `DROP DATABASE` requests an immediate checkpoint and waits for it. With the
 * whole integration suite writing to this server in parallel that wait went
 * past 60 s in an `afterAll` and past 120 s at the start of the test
 * (`wait_event = CheckpointStart` in `pg_stat_activity`) — moving it around
 * only moved which timeout expired.
 *
 * Dropping the schemas costs nothing by comparison and leaves exactly the
 * same starting point for what this file measures: no tables, and neither of
 * the two migration trackers — `__manual_migrations` in `public` and
 * drizzle's own, which lives in a schema named after it. What survives is
 * cluster-level — the `diluxite_app` role and the extensions — and both
 * migrations that create those already guard with `IF NOT EXISTS`, because a
 * second install on the same cluster meets the same thing.
 *
 * Only this file uses the name, and vitest gives a file one worker, so a
 * fixed name cannot collide with a parallel run of itself.
 */
const FRESH = 'diluxite_scratch';
const freshUrl = ADMIN_URL.replace(/\/[^/]+$/, `/${FRESH}`);
const admin = postgres(ADMIN_URL.replace(/\/[^/]+$/, '/postgres'), { max: 1 });


describe('the migrations, on a database that has never seen one', () => {
  it('all apply, in order, without a hand-fixed starting point', async () => {
    // `datconnlimit = -2` marks a database whose DROP was interrupted:
    // Postgres will not let anything connect to it again, only drop it. An
    // earlier version of this file did get one killed mid-drop, and without
    // this the suite would have stayed red until somebody cleaned up by hand.
    const [existing] = await admin<{ n: number; invalid: boolean }[]>`
      SELECT count(*)::int AS n,
             coalesce(bool_or(datconnlimit = -2), false) AS invalid
        FROM pg_database WHERE datname = ${FRESH}`;
    if (existing.invalid) await admin.unsafe(`DROP DATABASE ${FRESH} WITH (FORCE)`);
    if (existing.n === 0 || existing.invalid) await admin.unsafe(`CREATE DATABASE ${FRESH}`);

    const reset = postgres(freshUrl, { max: 1 });
    try {
      await reset.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
      // Drizzle keeps its applied-migrations table in a schema of its own, so
      // dropping `public` alone leaves it convinced everything has already
      // run: the second pass then applied the hand-written migrations onto an
      // empty database and failed on `relation "users" does not exist`.
      await reset.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
      await reset.unsafe('CREATE SCHEMA public');
    } finally {
      await reset.end();
    }

    // The assertion IS that this does not throw. Every ordering mistake
    // between migrations surfaces here and nowhere else.
    await runMigrations(freshUrl);

    const sql = postgres(freshUrl, { max: 1 });
    try {
      // A few shapes the application depends on, so a migration that
      // "applies" while leaving the wrong schema still fails.
      const [pk] = await sql<{ attname: string }[]>`
        SELECT a.attname FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'embedding_models'::regclass AND i.indisprimary`;
      expect(pk.attname, 'the vector space, not the model, identifies a row').toBe('slot');

      const [ce] = await sql<{ relkind: string }[]>`
        SELECT relkind FROM pg_class WHERE relname = 'chunk_embeddings'`;
      expect(ce.relkind, 'chunk_embeddings must be partitioned').toBe('p');

      const cols = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'chunk_embeddings'`;
      expect(cols.map((c) => c.column_name).sort()).toEqual(
        ['chunk_id', 'embedding', 'org_id', 'slot', 'space_id'].sort(),
      );

      // The role the data plane assumes (ADR-004).
      const [{ n: role }] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'diluxite_app'`;
      expect(role, 'migration 0028 did not create the data-plane role').toBe(1);

      // The roles the schema allows (ADR-005)...
      const [{ def }] = await sql<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'org_memberships_role_valid'`;
      expect(def).toContain('org_admin');
      expect(def).not.toContain('super_admin');

      // ...and the RLS helper the policies call, which a role rename silently
      // left spelling the old names once already.
      const [{ src }] = await sql<{ src: string }[]>`
        SELECT prosrc AS src FROM pg_proc WHERE proname = 'diluxite_is_org_admin'`;
      expect(src, 'the policy helper still spells the old role names').toContain('org_admin');
      expect(src).not.toContain('super_admin');
    } finally {
      await sql.end();
      await admin.end();
    }
  }, 120_000);
});
