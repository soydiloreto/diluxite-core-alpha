import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, DrizzleUsersRepository } from './index';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * Enterprise-shaped helpers on DrizzleUsersRepository (alpha.24):
 *   - setActive (soft-disable)
 *   - touchLastLogin (telemetry for deprovision reports)
 *   - createFromExternal (JIT provisioning entry point for OIDC/header)
 *   - upsertFromCsv (idempotent admin CSV import)
 *
 * The plain old findByEmail / create / ensureByEmail already had coverage
 * elsewhere; this file is for the new shape.
 */
describe('DrizzleUsersRepository — enterprise helpers', () => {
  let sql: ReturnType<typeof createDb>['sql'];
  let repo: DrizzleUsersRepository;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    sql = conn.sql;
    await sql`TRUNCATE chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, sessions, tokens, users RESTART IDENTITY CASCADE`;
    repo = new DrizzleUsersRepository(conn.db);
  });

  afterEach(async () => {
    await sql.end();
  });

  describe('createFromExternal — JIT provisioning', () => {
    it('creates a user with the provider tag and lower-cases email', async () => {
      const u = await repo.createFromExternal({
        email: 'Ana@Empresa.COM',
        firstName: 'Ana',
        lastName: 'Pérez',
        provider: 'oidc',
      });
      expect(u.email).toBe('ana@empresa.com');
      expect(u.firstName).toBe('Ana');
      expect(u.lastName).toBe('Pérez');
      expect(u.provider).toBe('oidc');
      expect(u.active).toBe(true);
      expect(u.passwordHash).toBeNull();
    });

    it('first_name and last_name can be null (IdP that omits given_name)', async () => {
      const u = await repo.createFromExternal({
        email: 'b@x.com',
        provider: 'trusted_header',
      });
      expect(u.firstName).toBeNull();
      expect(u.lastName).toBeNull();
      expect(u.provider).toBe('trusted_header');
    });
  });

  describe('setActive — soft-disable', () => {
    it('round-trips false then true', async () => {
      const u = await repo.create('a@x.com');
      await repo.setActive(u.id, false);
      expect((await repo.findById(u.id))?.active).toBe(false);
      await repo.setActive(u.id, true);
      expect((await repo.findById(u.id))?.active).toBe(true);
    });
  });

  describe('touchLastLogin', () => {
    it('sets last_login_at to a recent timestamp', async () => {
      const u = await repo.create('a@x.com');
      expect((await repo.findById(u.id))?.lastLoginAt).toBeNull();
      const before = Date.now();
      await repo.touchLastLogin(u.id);
      const after = Date.now();
      const stamped = (await repo.findById(u.id))?.lastLoginAt;
      expect(stamped).toBeTruthy();
      const t = new Date(stamped!).getTime();
      // Allow some clock skew either way (Postgres + Node clocks).
      expect(t).toBeGreaterThanOrEqual(before - 2000);
      expect(t).toBeLessThanOrEqual(after + 2000);
    });
  });

  describe('upsertFromCsv — admin import flow', () => {
    it('creates a new user when email is unseen (outcome=created)', async () => {
      const result = await repo.upsertFromCsv({
        email: 'C@X.com',
        firstName: 'Carlos',
        lastName: 'Gomez',
      });
      expect(result.outcome).toBe('created');
      expect(result.user.email).toBe('c@x.com');
      expect(result.user.provider).toBe('csv_import');
      expect(result.user.firstName).toBe('Carlos');
    });

    it('patches an existing user with the new names (outcome=updated)', async () => {
      await repo.create('d@x.com', 'oidc');
      const r = await repo.upsertFromCsv({
        email: 'd@x.com',
        firstName: 'Dario',
        lastName: 'Silva',
      });
      expect(r.outcome).toBe('updated');
      expect(r.user.firstName).toBe('Dario');
      expect(r.user.provider).toBe('oidc'); // preserved (not overwritten by csv_import)
    });

    it('null fields in CSV do NOT overwrite existing names', async () => {
      const u = await repo.createFromExternal({
        email: 'e@x.com',
        firstName: 'Eva',
        lastName: 'Quintero',
        provider: 'oidc',
      });
      const r = await repo.upsertFromCsv({ email: 'e@x.com' }); // empty names
      expect(r.outcome).toBe('updated');
      expect(r.user.firstName).toBe('Eva');
      expect(r.user.lastName).toBe('Quintero');
      expect(r.user.id).toBe(u.id);
    });

    it('is fully idempotent (re-running same CSV → no duplicates, outcome=updated)', async () => {
      const a = await repo.upsertFromCsv({ email: 'f@x.com', firstName: 'Flor' });
      const b = await repo.upsertFromCsv({ email: 'f@x.com', firstName: 'Flor' });
      const c = await repo.upsertFromCsv({ email: 'f@x.com', firstName: 'Flor' });
      expect(a.outcome).toBe('created');
      expect(b.outcome).toBe('updated');
      expect(c.outcome).toBe('updated');
      expect(a.user.id).toBe(b.user.id);
      expect(b.user.id).toBe(c.user.id);
    });
  });
});
