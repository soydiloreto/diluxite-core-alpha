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
 *      mismo prevId/id). Todas las migrations posteriores a 0003 están
 *      escritas con `CREATE ... IF NOT EXISTS` / `ALTER ... ADD COLUMN
 *      IF NOT EXISTS` para ser idempotentes en re-runs.
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
    const registered = new Set(journal.entries.map((e) => `${e.tag}.sql`));

    const extras = fs
      .readdirSync(migrationsFolder)
      .filter((f) => f.endsWith('.sql') && !registered.has(f))
      .sort();

    for (const file of extras) {
      const body = fs.readFileSync(path.join(migrationsFolder, file), 'utf8');
      await sql.unsafe(body);
    }
  } finally {
    await sql.end();
  }
}
