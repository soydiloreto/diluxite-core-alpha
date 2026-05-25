import { createDb } from '@diluxite/db';
import { buildApp } from '../src/app';
import { buildCoreDeps } from '../src/services';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/** App single-user (edición Core) contra la base de test: trunca, bootstrappea y arma Fastify. */
export async function buildTestApp() {
  const clean = createDb(TEST_DATABASE_URL);
  await clean.sql`TRUNCATE chunks, notas, miembros, espacios, usuarios RESTART IDENTITY CASCADE`;
  await clean.sql.end();

  const { sql, deps, defaultSpaceId } = await buildCoreDeps(TEST_DATABASE_URL);
  const app = buildApp(deps);
  await app.ready();
  return { app, sql, deps, defaultSpaceId };
}
