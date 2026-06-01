import { createDb } from '@diluxite/db';
import { buildApp } from '../src/app';
import { buildCoreDeps } from '../src/services';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/** Single-user app (Core edition) wired against the test database: truncate, bootstrap, build Fastify. */
export async function buildTestApp() {
  const clean = createDb(TEST_DATABASE_URL);
  await clean.sql`TRUNCATE chunks, notes, memberships, spaces, users RESTART IDENTITY CASCADE`;
  await clean.sql.end();

  const { sql, deps, defaultSpaceId } = await buildCoreDeps(TEST_DATABASE_URL);
  const app = await buildApp(deps);
  await app.ready();
  return { app, sql, deps, defaultSpaceId };
}
