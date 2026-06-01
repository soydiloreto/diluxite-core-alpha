import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/**
 * Habilita pgvector y corre las migraciones contra la URL dada.
 *
 * Dos pasadas:
 *   1. Drizzle migrator (lee `meta/_journal.json`) → cubre 0000-0003.
 *   2. Pasada manual sobre los `.sql` que NO están registrados en el journal,
 *      en orden lexicográfico. Destraba 0004+ sin pelear con drizzle-kit
 *      (que se rompe por un fork histórico en los snapshots 0002↔0003 —
 *      mismo prevId/id).
 *
 * La pasada 2 rastrea su propio estado en `__manual_migrations` para no
 * re-aplicar. Esto importa cuando varios proyectos Vitest comparten el mismo
 * Postgres (`db` y `api` cada uno tiene su globalSetup; `runMigrations` se
 * invoca dos veces contra la misma DB). Las migrations contienen statements
 * como `ADD CONSTRAINT` que NO son idempotentes en PG < 17 (no soportan
 * `IF NOT EXISTS`), así que necesitamos tracking propio.
 */
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

    const journalPath = path.join(migrationsFolder, 'meta/_journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    const drizzleRegistered = new Set(journal.entries.map((e) => `${e.tag}.sql`));

    await sql`
      CREATE TABLE IF NOT EXISTS __manual_migrations (
        name text PRIMARY KEY,
        applied_at timestamp NOT NULL DEFAULT now()
      )
    `;
    const appliedRows = await sql<{ name: string }[]>`SELECT name FROM __manual_migrations`;
    const alreadyApplied = new Set(appliedRows.map((r) => r.name));

    const extras = fs
      .readdirSync(migrationsFolder)
      .filter((f) => f.endsWith('.sql') && !drizzleRegistered.has(f) && !alreadyApplied.has(f))
      .sort();

    for (const file of extras) {
      const body = fs.readFileSync(path.join(migrationsFolder, file), 'utf8');
      await sql.unsafe(body);
      await sql`INSERT INTO __manual_migrations (name) VALUES (${file})`;
    }
  } finally {
    await sql.end();
  }
}
