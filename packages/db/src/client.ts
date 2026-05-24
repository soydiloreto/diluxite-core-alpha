import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

export function createDb(url: string) {
  const sql = postgres(url);
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export type Db = ReturnType<typeof createDb>['db'];
