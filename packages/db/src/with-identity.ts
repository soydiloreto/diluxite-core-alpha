import { sql } from 'drizzle-orm';
import type { Db } from './client';

/**
 * Publishes the per-request user id to Postgres so the RLS policies in
 * migration 0003 can gate rows. `SET LOCAL` is transaction-scoped, so the
 * connection pool can reuse the same connection for a different user on
 * the next transaction without bleeding identity across requests.
 *
 * Every API handler that reads/writes a tenant-scoped table should run
 * its work through `withIdentity` — otherwise Postgres falls back to the
 * empty user id and the policies return zero rows (fail-closed).
 *
 *   await withIdentity(db, req.identity.userId, async (tx) => {
 *     const notes = await notesRepo.list(spaceId, tx);
 *     ...
 *   });
 */
export async function withIdentity<T>(
  db: Db,
  userId: string,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}::text, true)`);
    return work(tx as unknown as Db);
  });
}

/**
 * For bootstrap / migrations / scripted backfills: clears the user id and
 * relies on a Postgres role that has BYPASSRLS. Use sparingly — the only
 * legitimate callers are migrations, `ensureSingleUserBootstrap`, and the
 * seed.
 */
export async function withoutIdentity<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', '', true)`);
    return work(tx as unknown as Db);
  });
}
