import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

export function createDb(url: string) {
  const sql = postgres(url);
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export type Db = ReturnType<typeof createDb>['db'];

/**
 * The transaction handle drizzle passes to `db.transaction(async (tx) => …)`.
 * Lacks `$client` (so it's not assignable to `Db`); helpers that must accept
 * either the pool client or a transaction take `Db | DbTx`.
 */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
