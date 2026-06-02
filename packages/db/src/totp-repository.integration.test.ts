import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, DrizzleTotpRepository } from './index';
import { ensureSingleUserBootstrap } from './spaces-repository';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

describe('DrizzleTotpRepository', () => {
  let sql: ReturnType<typeof createDb>['sql'];
  let db: ReturnType<typeof createDb>['db'];
  let repo: DrizzleTotpRepository;
  let userId: string;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    sql = conn.sql;
    db = conn.db;
    await sql`
      CREATE TABLE IF NOT EXISTS totp_secrets (
        user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        secret       text NOT NULL,
        confirmed_at timestamptz NOT NULL DEFAULT now(),
        backup_codes text[] NOT NULL DEFAULT '{}'::text[]
      )`;
    await sql`TRUNCATE totp_secrets, chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;
    const b = await ensureSingleUserBootstrap(db);
    userId = b.userId;
    repo = new DrizzleTotpRepository(db);
  });

  afterEach(async () => {
    await sql.end();
  });

  it('returns null when the user has not enrolled', async () => {
    expect(await repo.getForUser(userId)).toBeNull();
  });

  it('enroll persists secret + backup codes and getForUser reads them back', async () => {
    await repo.enroll({ userId, secret: 'SECRET123', backupCodes: ['h1', 'h2'] });
    const row = await repo.getForUser(userId);
    expect(row).not.toBeNull();
    expect(row!.secret).toBe('SECRET123');
    expect(row!.backupCodes).toEqual(['h1', 'h2']);
    expect(row!.confirmedAt).toBeInstanceOf(Date);
  });

  it('enroll on an existing user REPLACES the secret (idempotent over PK)', async () => {
    await repo.enroll({ userId, secret: 'OLD', backupCodes: ['a'] });
    await repo.enroll({ userId, secret: 'NEW', backupCodes: ['b', 'c'] });
    const row = await repo.getForUser(userId);
    expect(row!.secret).toBe('NEW');
    expect(row!.backupCodes).toEqual(['b', 'c']);
  });

  it('consumeBackupCode returns false for unknown hash', async () => {
    await repo.enroll({ userId, secret: 'X', backupCodes: ['known'] });
    expect(await repo.consumeBackupCode(userId, 'unknown')).toBe(false);
    // Original codes still there.
    expect((await repo.getForUser(userId))!.backupCodes).toEqual(['known']);
  });

  it('consumeBackupCode removes the matching code and returns true', async () => {
    await repo.enroll({ userId, secret: 'X', backupCodes: ['a', 'b', 'c'] });
    expect(await repo.consumeBackupCode(userId, 'b')).toBe(true);
    expect((await repo.getForUser(userId))!.backupCodes).toEqual(['a', 'c']);
  });

  it('consumeBackupCode is single-use (second call for same hash → false)', async () => {
    await repo.enroll({ userId, secret: 'X', backupCodes: ['a'] });
    expect(await repo.consumeBackupCode(userId, 'a')).toBe(true);
    expect(await repo.consumeBackupCode(userId, 'a')).toBe(false);
  });

  it('consumeBackupCode returns false when user has no row at all', async () => {
    expect(await repo.consumeBackupCode(userId, 'h')).toBe(false);
  });

  it('deleteForUser removes the row', async () => {
    await repo.enroll({ userId, secret: 'X', backupCodes: [] });
    await repo.deleteForUser(userId);
    expect(await repo.getForUser(userId)).toBeNull();
  });
});
