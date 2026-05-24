import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/** Habilita pgvector y corre las migraciones contra la URL dada. */
export async function runMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    const db = drizzle(sql);
    const migrationsFolder = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../migrations',
    );
    await migrate(db, { migrationsFolder });
  } finally {
    await sql.end();
  }
}
