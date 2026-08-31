import { createDb, partitionNameOf } from '@diluxite/db';
import { buildApp } from '../src/app';
import { buildCoreDeps } from '../src/services';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/** Single-user app (Core edition) wired against the test database: truncate, bootstrap, build Fastify. */
export async function buildTestApp() {
  const clean = createDb(TEST_DATABASE_URL);
  await clean.sql`TRUNCATE chunks, notes, memberships, spaces, users RESTART IDENTITY CASCADE`;
  // The embedding model catalogue outlives a TRUNCATE of the data tables and
  // owns real partitions (ADR-003), so a test that leaves an unexpected model
  // active hands the next one an instance that cannot index. Reset it here,
  // partitions included, rather than in each suite.
  // `slot`, not `key`: a partition is named after the vector space, and a
  // vector space has been "<org>:<model>" since embeddings became per
  // organisation. Passing the key computed a name for a partition that does
  // not exist, so the DROP was a silent no-op and the real ones leaked.
  const models = await clean.sql<{ slot: string }[]>`SELECT slot FROM embedding_models`;
  for (const m of models) {
    await clean.sql.unsafe(`DROP TABLE IF EXISTS ${partitionNameOf(m.slot)}`);
  }
  await clean.sql`DELETE FROM embedding_models`;
  await clean.sql.end();

  const r = await buildCoreDeps(TEST_DATABASE_URL);
  const app = await buildApp(r.deps);
  await app.ready();
  return {
    app,
    sql: r.sql,
    deps: r.deps,
    defaultSpaceId: r.defaultSpaceId,
    defaultOrgId: r.defaultOrgId,
    userId: r.userId,
  };
}
