import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/schema';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

export function getTestDb() {
  const sql = postgres(TEST_DATABASE_URL);
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export async function truncateAll(sql: postgres.Sql): Promise<void> {
  // CASCADE handles note_tags, note_links, folders, tokens, org_memberships.
  await sql`TRUNCATE chunks, notes, memberships, spaces, organizations, users RESTART IDENTITY CASCADE`;
}
