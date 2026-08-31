import postgres from 'postgres';
import { runMigrations } from '@diluxite/db';
import { adminUrl, databaseNameFor, databaseUrlFor } from '../../../test/integration-db';

export const TEST_DATABASE_URL = databaseUrlFor('api');

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
  // CSRF — el dedicated `csrf.integration.test.ts` re-enables it per-test
  // para verificar que el gate dispara. El resto de la suite usa cookies sin
  // CSRF header y se prendería en rojo por una razón ortogonal a lo que testea.
  process.env.DILUXITE_CSRF_DISABLED = '1';

  // Cada proyecto de vitest tiene su base — ver `test/integration-db.ts`.
  const name = databaseNameFor('api');
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    const exists = await admin`select 1 from pg_database where datname = ${name}`;
    if (exists.length === 0) await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  await runMigrations(TEST_DATABASE_URL);
}
