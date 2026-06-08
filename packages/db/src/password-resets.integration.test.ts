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
