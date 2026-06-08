import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb } from './index';
import type { Db } from './client';
import { withIdentity, withoutIdentity } from './with-identity';
import { ensureSingleUserBootstrap } from './spaces-repository';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * `withIdentity` is the RLS security boundary: it publishes the request's user
 * id to `app.current_user_id` so the policies in migration 0003 can gate rows,
 * transaction-scoped so identity never bleeds across pooled connections. The
 * RLS *policies* are tested in rls.integration.test via `SET ROLE`; here we lock
 * the helper's contract (set / clear / scope / passthrough).
 */
async function readIdentity(tx: Db): Promise<string> {
  const rows = (await tx.execute(
    sql`SELECT current_setting('app.current_user_id', true) AS uid`,
  )) as unknown as Array<{ uid: string | null }>;
  return rows[0]?.uid ?? '';
}

describe('withIdentity / withoutIdentity', () => {
  let sqlc: ReturnType<typeof createDb>['sql'];
  let db: ReturnType<typeof createDb>['db'];
  let userId: string;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    sqlc = conn.sql;
    db = conn.db;
    await sqlc`TRUNCATE chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;
    const b = await ensureSingleUserBootstrap(db);
    userId = b.userId;
  });

  afterEach(async () => {
    await sqlc.end();
  });

  it('publishes the user id to app.current_user_id inside the work tx', async () => {
    const seen = await withIdentity(db, userId, (tx) => readIdentity(tx));
    expect(seen).toBe(userId);
  });

  it('withoutIdentity clears the identity (fail-closed default)', async () => {
    const seen = await withoutIdentity(db, (tx) => readIdentity(tx));
    expect(seen).toBe('');
  });

  it('is transaction-scoped — the id does not bleed to later work', async () => {
    await withIdentity(db, userId, async () => undefined);
    // A fresh query outside that transaction must see the reset default.
    const after = await withoutIdentity(db, (tx) => readIdentity(tx));
    expect(after).toBe('');
  });

  it('returns the work callback result', async () => {
    const out = await withIdentity(db, userId, async () => 'value-42');
    expect(out).toBe('value-42');
  });
});
