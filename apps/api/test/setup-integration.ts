import postgres from 'postgres';
import { runMigrations } from '@diluxite/db';

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/postgres';
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

export default async function setup() {
  // Disable rate limiting in the integration suite by default. Most tests
  // flood the auth endpoints with rapid POSTs (passkey ceremony, login
  // attempts, token mints) and the rate-limit gate would turn them red
  // for the wrong reason. The dedicated `rate-limit.integration.test.ts`
  // re-enables it per-test to verify the gate fires.
  process.env.DILUXITE_RATE_LIMIT_DISABLED = '1';
  // Idem para helmet — los tests no validan headers de seguridad y la
  // suite OIDC E2E falla con el COEP por defecto.
  process.env.DILUXITE_HELMET_DISABLED = '1';

  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    const exists = await admin`select 1 from pg_database where datname = 'diluxite_test'`;
    if (exists.length === 0) await admin`CREATE DATABASE diluxite_test`;
  } finally {
    await admin.end();
  }
  await runMigrations(TEST_DATABASE_URL);
}
