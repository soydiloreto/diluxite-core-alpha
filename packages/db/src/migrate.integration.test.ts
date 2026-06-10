import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestDb } from '../test/helpers';
import { runMigrations } from './migrate';

/**
 * Migration runner safety (item 3): the manual pass must be idempotent and
 * transactional. The test DB is already fully migrated by the global setup, so
 * re-running `runMigrations` here exercises the "nothing to do" path AND the
 * advisory lock without changing anything.
 */
const { sql } = getTestDb();
const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

afterAll(async () => {
  await sql.end();
});

describe('runMigrations', () => {
  it('is idempotent — running twice over a migrated DB is a no-op', async () => {
    const before = await sql<{ name: string }[]>`SELECT name FROM __manual_migrations ORDER BY name`;
    await runMigrations(TEST_URL);
    await runMigrations(TEST_URL);
    const after = await sql<{ name: string }[]>`SELECT name FROM __manual_migrations ORDER BY name`;
    expect(after.map((r) => r.name)).toEqual(before.map((r) => r.name));
  });

  it('runs concurrent passes safely under the advisory lock (no double-apply)', async () => {
    // Two runners racing: the xact advisory lock serialises the manual pass,
    // so neither double-applies and the tracking table stays consistent.
    await Promise.all([runMigrations(TEST_URL), runMigrations(TEST_URL)]);
    const rows = await sql<{ name: string; n: number }[]>`
      SELECT name, COUNT(*)::int AS n FROM __manual_migrations GROUP BY name HAVING COUNT(*) > 1`;
    expect(rows).toEqual([]); // no duplicate tracking rows
  });

  it('a failing .sql leaves no tracking row (transactional per file)', async () => {
    // Drop a deliberately broken migration into the folder, run, expect a
    // throw, and verify it was NOT recorded as applied (so a fixed version
    // would re-run rather than being skipped forever).
    const migrationsFolder = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../migrations',
    );
    const bad = path.join(migrationsFolder, '9999_intentionally_broken.sql');
    fs.writeFileSync(bad, 'CREATE TABLE __nope (id int); SELECT * FROM table_that_does_not_exist;\n');
    try {
      await expect(runMigrations(TEST_URL)).rejects.toThrow();
      const tracked = await sql<{ name: string }[]>`
        SELECT name FROM __manual_migrations WHERE name = '9999_intentionally_broken.sql'`;
      expect(tracked).toEqual([]);
      // The first statement of the broken file must have rolled back too —
      // the table it created in the same transaction does not survive.
      const leaked = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '__nope') AS exists`;
      expect(leaked[0].exists).toBe(false);
    } finally {
      fs.unlinkSync(bad);
    }
  });
});
