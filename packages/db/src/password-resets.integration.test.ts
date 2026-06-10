import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, DrizzlePasswordResetsRepository } from './index';
import { ensureSingleUserBootstrap } from './spaces-repository';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * Tests del repositorio password_resets — apuntan a los invariantes del flujo
 * forgot-password:
 *
 *  1. Solo persistimos el hash del token; `findActiveByHash` es el hot path de
 *     verificación y devuelve la row solo si existe, no expiró y no fue
 *     consumida.
 *  2. Un token expirado (now > expiresAt) deja de estar activo.
 *  3. `markConsumed` invalida la row: un token consumido no vuelve a ser activo.
 *  4. Un hash desconocido devuelve null (no fuga de filas ajenas).
 *  5. `deleteExpired` es cleanup operacional: borra solo las filas expiradas y
 *     devuelve la cantidad eliminada.
 *  6. `consumeActiveByHash` es check-and-consume atómico: el mismo token solo
 *     puede consumirse una vez, incluso bajo concurrencia.
 */

describe('DrizzlePasswordResetsRepository', () => {
  let sql: ReturnType<typeof createDb>['sql'];
  let db: ReturnType<typeof createDb>['db'];
  let repo: DrizzlePasswordResetsRepository;
  let userId: string;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    sql = conn.sql;
    db = conn.db;
    await sql`TRUNCATE password_resets, audit_events, chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;
    const b = await ensureSingleUserBootstrap(db);
    userId = b.userId;
    repo = new DrizzlePasswordResetsRepository(db);
  });

  afterEach(async () => {
    await sql.end();
  });

  it('create + findActiveByHash returns the row for a valid, non-expired, non-consumed token', async () => {
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    const created = await repo.create({
      userId,
      tokenHash: 'hash-valid',
      expiresAt,
    });
    expect(created.id).toBeTruthy();
    expect(created.userId).toBe(userId);
    expect(created.tokenHash).toBe('hash-valid');
    expect(created.consumedAt).toBeNull();

    const found = await repo.findActiveByHash('hash-valid');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.tokenHash).toBe('hash-valid');
  });

  it('findActiveByHash returns null for an expired token', async () => {
    const expiresAt = new Date('2026-01-01T00:00:00Z');
    await repo.create({ userId, tokenHash: 'hash-expired', expiresAt });

    // now is strictly after expiresAt.
    const now = new Date('2026-01-02T00:00:00Z');
    const found = await repo.findActiveByHash('hash-expired', now);
    expect(found).toBeNull();
  });

  it('markConsumed makes findActiveByHash return null afterwards', async () => {
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    const created = await repo.create({ userId, tokenHash: 'hash-consume', expiresAt });

    // Active before consuming.
    expect(await repo.findActiveByHash('hash-consume')).not.toBeNull();

    await repo.markConsumed(created.id);

    expect(await repo.findActiveByHash('hash-consume')).toBeNull();
  });

  it('consumeActiveByHash returns the row once, then null (single use)', async () => {
    const created = await repo.create({
      userId,
      tokenHash: 'hash-atomic',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });

    const first = await repo.consumeActiveByHash('hash-atomic');
    expect(first).not.toBeNull();
    expect(first!.id).toBe(created.id);
    expect(first!.consumedAt).not.toBeNull();

    // Second consumption of the same token: nothing left to consume.
    expect(await repo.consumeActiveByHash('hash-atomic')).toBeNull();
    // And it is no longer active either.
    expect(await repo.findActiveByHash('hash-atomic')).toBeNull();
  });

  it('consumeActiveByHash returns null for an expired token (and does not consume it)', async () => {
    await repo.create({
      userId,
      tokenHash: 'hash-atomic-expired',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    });
    const now = new Date('2026-01-02T00:00:00Z');
    expect(await repo.consumeActiveByHash('hash-atomic-expired', now)).toBeNull();
  });

  it('consumeActiveByHash under concurrency: exactly one of two parallel consumers wins', async () => {
    await repo.create({
      userId,
      tokenHash: 'hash-race',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    const [a, b] = await Promise.all([
      repo.consumeActiveByHash('hash-race'),
      repo.consumeActiveByHash('hash-race'),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
  });

  it('markConsumed never overwrites an existing consumed_at (first consumption wins)', async () => {
    const created = await repo.create({
      userId,
      tokenHash: 'hash-keep-first',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    await repo.markConsumed(created.id, new Date('2026-06-01T00:00:00Z'));
    // Compare as text to sidestep timestamp-vs-timezone parsing differences.
    const [first] = await sql`
      SELECT consumed_at::text AS t FROM password_resets WHERE id = ${created.id}
    `;
    // A later markConsumed must be a no-op.
    await repo.markConsumed(created.id, new Date('2026-06-02T00:00:00Z'));
    const [second] = await sql`
      SELECT consumed_at::text AS t FROM password_resets WHERE id = ${created.id}
    `;
    expect(second.t).toBe(first.t);
  });

  it('findActiveByHash returns null for an unknown hash', async () => {
    await repo.create({
      userId,
      tokenHash: 'hash-known',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    const found = await repo.findActiveByHash('hash-does-not-exist');
    expect(found).toBeNull();
  });

  it('deleteExpired removes only expired rows and returns the count', async () => {
    // Two expired, one still valid.
    await repo.create({
      userId,
      tokenHash: 'hash-old-1',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    });
    await repo.create({
      userId,
      tokenHash: 'hash-old-2',
      expiresAt: new Date('2026-02-01T00:00:00Z'),
    });
    await repo.create({
      userId,
      tokenHash: 'hash-fresh',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });

    const now = new Date('2026-06-01T00:00:00Z');
    const deleted = await repo.deleteExpired(now);
    expect(deleted).toBe(2);

    // The fresh one survives and is still active.
    const remaining = await repo.findActiveByHash('hash-fresh', now);
    expect(remaining).not.toBeNull();
    // The expired ones are gone.
    expect(await repo.findActiveByHash('hash-old-1', now)).toBeNull();
    expect(await repo.findActiveByHash('hash-old-2', now)).toBeNull();
  });
});
