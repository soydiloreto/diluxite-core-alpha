import postgres from 'postgres';
import { runMigrations } from '../src/migrate';
import { TEST_DATABASE_URL } from './helpers';

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ??
  'postgres://diluxite:diluxite@localhost:5432/postgres';

// globalSetup de Vitest: crea la base de test (si falta) y corre migraciones.
export default async function setup() {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    const exists = await admin`select 1 from pg_database where datname = 'diluxite_test'`;
    if (exists.length === 0) await admin`CREATE DATABASE diluxite_test`;
  } finally {
    await admin.end();
  }
  await runMigrations(TEST_DATABASE_URL);
}
