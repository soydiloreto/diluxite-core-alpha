import postgres from 'postgres';
import { runMigrations } from '../src/migrate';
import { adminUrl, databaseNameFor, databaseUrlFor } from '../../../test/integration-db';

// globalSetup de Vitest: crea la base de este proyecto (si falta) y corre
// migraciones. Cada proyecto tiene la suya — ver `test/integration-db.ts`.
export default async function setup() {
  const name = databaseNameFor('db');
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    const exists = await admin`select 1 from pg_database where datname = ${name}`;
    if (exists.length === 0) await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  await runMigrations(databaseUrlFor('db'));
}
