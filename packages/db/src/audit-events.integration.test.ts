import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, DrizzleAuditEventsRepository } from './index';
import { ensureSingleUserBootstrap } from './spaces-repository';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * Tests del repositorio audit_events — apuntan a tres invariantes:
 *
 *  1. Append-only: solo hay record/list/count, no update/delete. El test no
 *     necesita probar la ausencia (TS lo garantiza), pero sí que un INSERT
 *     duplicado quede registrado como dos rows separadas.
 *  2. Filtros componibles: el llamador puede combinar org + actor + action
 *     prefix + date range + cursor. Los probamos por separado y combinados.
 *  3. Cursor-based pagination: `beforeId` excluye estrictamente; el orden es
 *     `at DESC, id DESC` así que dos eventos con el mismo `at` se ordenan
 *     deterministicamente por id (los más recientes primero).
 */

describe('DrizzleAuditEventsRepository', () => {
  let sql: ReturnType<typeof createDb>['sql'];
  let db: ReturnType<typeof createDb>['db'];
  let repo: DrizzleAuditEventsRepository;
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    sql = conn.sql;
    db = conn.db;
    await sql`TRUNCATE audit_events, chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;
    const b = await ensureSingleUserBootstrap(db);
    orgId = b.orgId;
    userId = b.userId;
    repo = new DrizzleAuditEventsRepository(db);
  });

  afterEach(async () => {
    await sql.end();
  });

  describe('record', () => {
    it('persists an event with all fields and reads it back', async () => {
      await repo.record({
        orgId,
        actorId: userId,
        action: 'auth.login.success',
        resource: 'session',
        ip: '203.0.113.1',
        userAgent: 'Mozilla/5.0',
        metadata: { method: 'password', mfa: false },
      });
      const events = await repo.list({ orgId });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        orgId,
        actorId: userId,
        action: 'auth.login.success',
        resource: 'session',
        ip: '203.0.113.1',
        userAgent: 'Mozilla/5.0',
        metadata: { method: 'password', mfa: false },
      });
      expect(events[0].id).toBeGreaterThan(0);
      expect(events[0].at).toBeInstanceOf(Date);
    });

    it('accepts a null actor_id (failed login has no verified identity)', async () => {
      await repo.record({
        action: 'auth.login.failed',
        ip: '198.51.100.7',
        metadata: { attemptedEmail: 'attacker@example.test' },
      });
      const [e] = await repo.list();
      expect(e.actorId).toBeNull();
      expect(e.orgId).toBeNull();
      expect(e.metadata).toMatchObject({ attemptedEmail: 'attacker@example.test' });
    });

    it('default metadata is an empty object (not null)', async () => {
      await repo.record({ action: 'system.boot' });
      const [e] = await repo.list();
      expect(e.metadata).toEqual({});
    });

    it('two identical events are stored as two distinct rows (append-only)', async () => {
      await repo.record({ actorId: userId, action: 'auth.login.success' });
      await repo.record({ actorId: userId, action: 'auth.login.success' });
      const events = await repo.list();
      expect(events).toHaveLength(2);
      // IDs are monotonic — newer one has the higher id.
      expect(events[0].id).toBeGreaterThan(events[1].id);
    });
  });

  describe('list — filters', () => {
    beforeEach(async () => {
      // Seed a known set of events. We control `at` via SQL because we want
      // deterministic ordering for the cursor + range tests.
      await sql`
        INSERT INTO audit_events (at, org_id, actor_id, action, metadata)
        VALUES
          ('2026-01-01 10:00:00+00', ${orgId}, ${userId}, 'auth.login.success', '{}'::jsonb),
          ('2026-01-02 11:00:00+00', ${orgId}, ${userId}, 'auth.logout', '{}'::jsonb),
          ('2026-01-03 12:00:00+00', ${orgId}, ${userId}, 'admin.users.csv_imported', '{"created":5}'::jsonb),
          ('2026-01-04 13:00:00+00', ${orgId}, NULL, 'auth.login.failed', '{"attemptedEmail":"x@y.z"}'::jsonb),
          ('2026-01-05 14:00:00+00', NULL, ${userId}, 'system.boot', '{}'::jsonb)
      `;
    });

    it('no filters → returns all events newest-first', async () => {
      const events = await repo.list();
      expect(events).toHaveLength(5);
      expect(events[0].action).toBe('system.boot');
      expect(events[4].action).toBe('auth.login.success');
    });

    it('filters by orgId (excludes events where org is NULL)', async () => {
      const events = await repo.list({ orgId });
      expect(events).toHaveLength(4);
      expect(events.every((e) => e.orgId === orgId)).toBe(true);
    });

    it('filters by actorId (excludes events where actor is NULL)', async () => {
      const events = await repo.list({ actorId: userId });
      expect(events.every((e) => e.actorId === userId)).toBe(true);
      expect(events).toHaveLength(4);
    });

    it('filters by action prefix (auth.* matches login + logout but NOT admin.*)', async () => {
      const events = await repo.list({ actionPrefix: 'auth.' });
      expect(events.every((e) => e.action.startsWith('auth.'))).toBe(true);
      expect(events.map((e) => e.action).sort()).toEqual([
        'auth.login.failed',
        'auth.login.success',
        'auth.logout',
      ]);
    });

    it('action index uses text_pattern_ops so LIKE prefix is index-usable', async () => {
      // Migration 0022: a plain btree on `action` can't serve `LIKE 'x%'`
      // outside C locale. The index must be declared with text_pattern_ops.
      const [idx] = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'audit_events_action_idx'`;
      expect(idx.indexdef).toContain('text_pattern_ops');
    });

    it('action prefix escapes wildcards (`%` in input does NOT match anything)', async () => {
      // Adversarial: if we forgot to escape, '%' would match every action.
      const events = await repo.list({ actionPrefix: '%' });
      expect(events).toHaveLength(0);
    });

    it('action prefix escapes underscore wildcards', async () => {
      const events = await repo.list({ actionPrefix: '_' });
      expect(events).toHaveLength(0);
    });

    it('filters by date range (from inclusive)', async () => {
      const events = await repo.list({ from: new Date('2026-01-03T00:00:00Z') });
      expect(events).toHaveLength(3);
    });

    it('filters by date range (to inclusive)', async () => {
      const events = await repo.list({ to: new Date('2026-01-02T23:59:59Z') });
      expect(events).toHaveLength(2);
    });

    it('combines orgId + actionPrefix + date range', async () => {
      const events = await repo.list({
        orgId,
        actionPrefix: 'auth.',
        from: new Date('2026-01-02T00:00:00Z'),
        to: new Date('2026-01-04T23:59:59Z'),
      });
      // Window covers logout + failed login.
      expect(events.map((e) => e.action).sort()).toEqual(['auth.login.failed', 'auth.logout']);
    });

    it('respects the default page size (50)', async () => {
      // Add 60 more events to push past the default.
      for (let i = 0; i < 60; i++) {
        await repo.record({ actorId: userId, action: `bulk.${i}` });
      }
      const events = await repo.list();
      // 5 seeded + 60 bulk = 65 total; default page returns 50.
      expect(events).toHaveLength(50);
    });

    it('caps limit at 200 (no matter what the caller asks)', async () => {
      for (let i = 0; i < 250; i++) {
        await repo.record({ action: `bulk.${i}` });
      }
      const events = await repo.list({ limit: 999 });
      expect(events.length).toBeLessThanOrEqual(200);
    });

    it('enforces a minimum limit of 1 (no negatives)', async () => {
      const events = await repo.list({ limit: 0 });
      expect(events).toHaveLength(1);
    });
  });

  describe('list — cursor pagination', () => {
    let ids: number[];

    beforeEach(async () => {
      ids = [];
      // 10 events in chronological order. We need NEW ids each test (TRUNCATE
      // resets the sequence in the outer beforeEach).
      for (let i = 0; i < 10; i++) {
        await repo.record({ actorId: userId, action: `e.${i}` });
      }
      const all = await repo.list({ limit: 100 });
      // newest first; reverse to get chronological so ids[0] is the oldest.
      ids = all.map((e) => e.id).reverse();
      expect(ids).toHaveLength(10);
    });

    it('beforeId returns strictly older events', async () => {
      // ids[5] should NOT be in the result (beforeId is exclusive).
      const events = await repo.list({ beforeId: ids[5], limit: 100 });
      expect(events.every((e) => e.id < ids[5])).toBe(true);
      // Should return ids[0..4] = 5 events.
      expect(events).toHaveLength(5);
    });

    it('beforeId combined with limit gives a single page', async () => {
      const events = await repo.list({ beforeId: ids[5], limit: 2 });
      expect(events).toHaveLength(2);
      // Newest of the strictly-older set: ids[4] and ids[3].
      expect(events[0].id).toBe(ids[4]);
      expect(events[1].id).toBe(ids[3]);
    });

    it('paginating from beginning to end visits all events without duplicates', async () => {
      const seen = new Set<number>();
      let cursor: number | undefined = undefined;
      for (let page = 0; page < 5; page++) {
        const events = await repo.list({ limit: 3, beforeId: cursor });
        if (events.length === 0) break;
        for (const e of events) {
          expect(seen.has(e.id)).toBe(false);
          seen.add(e.id);
        }
        cursor = events[events.length - 1].id;
      }
      expect(seen.size).toBe(10);
    });

    it('visits every event even when `at` and `id` disagree on the order', async () => {
      // The two clocks are not the same clock. `at` defaults to `now()`,
      // which in Postgres is the transaction's START time, while `id` comes
      // off a sequence at INSERT time. A transaction that begins first and
      // inserts last therefore gets the EARLIER `at` and the HIGHER `id` —
      // and with the two vitest projects writing to the same database that
      // interleaving happens on its own.
      //
      // `list` sorts by `(at DESC, id DESC)`. The cursor filtered on `id`
      // alone, so as soon as the two disagreed the page boundary cut in a
      // different place than the sort, and rows in between were never
      // returned by any page. Nothing errors: the caller just gets an audit
      // log that is quietly missing entries.
      await sql`TRUNCATE audit_events RESTART IDENTITY`;
      await sql`
        INSERT INTO audit_events (at, org_id, actor_id, action, metadata) VALUES
          ('2026-02-01 12:00:02+00', ${orgId}, ${userId}, 'late.start.early.insert', '{}'::jsonb),
          ('2026-02-01 12:00:01+00', ${orgId}, ${userId}, 'early.start.late.insert', '{}'::jsonb)`;

      const seen = new Set<number>();
      let cursor: number | undefined = undefined;
      for (let page = 0; page < 5; page++) {
        const events: { id: number }[] = await repo.list({ limit: 1, beforeId: cursor });
        if (events.length === 0) break;
        for (const e of events) seen.add(e.id);
        cursor = events[events.length - 1].id;
      }
      expect(seen.size, 'paging dropped an event the log does contain').toBe(2);
    });
  });

  describe('deleteOlderThan', () => {
    beforeEach(async () => {
      // 5 events: at = 2026-01-01..05 12:00.
      await sql`
        INSERT INTO audit_events (at, org_id, actor_id, action, metadata)
        VALUES
          ('2026-01-01 12:00:00+00', ${orgId}, ${userId}, 'auth.login.success', '{}'::jsonb),
          ('2026-01-02 12:00:00+00', ${orgId}, ${userId}, 'auth.login.success', '{}'::jsonb),
          ('2026-01-03 12:00:00+00', ${orgId}, ${userId}, 'auth.login.success', '{}'::jsonb),
          ('2026-01-04 12:00:00+00', ${orgId}, ${userId}, 'auth.login.success', '{}'::jsonb),
          ('2026-01-05 12:00:00+00', ${orgId}, ${userId}, 'auth.login.success', '{}'::jsonb)
      `;
    });

    it('returns the count of rows DELETEd (strict <)', async () => {
      const cutoff = new Date('2026-01-03T12:00:00Z');
      const deleted = await repo.deleteOlderThan(cutoff);
      // 01 and 02 are strictly older than 03 12:00. 03 itself is NOT older.
      expect(deleted).toBe(2);
      const remaining = await repo.list({ limit: 10 });
      expect(remaining).toHaveLength(3);
    });

    it('cutoff in the future deletes everything', async () => {
      const cutoff = new Date('2030-01-01T00:00:00Z');
      const deleted = await repo.deleteOlderThan(cutoff);
      expect(deleted).toBe(5);
      expect(await repo.list()).toHaveLength(0);
    });

    it('cutoff in the past deletes nothing', async () => {
      const cutoff = new Date('2025-01-01T00:00:00Z');
      const deleted = await repo.deleteOlderThan(cutoff);
      expect(deleted).toBe(0);
      expect(await repo.list()).toHaveLength(5);
    });
  });

  describe('count', () => {
    beforeEach(async () => {
      for (let i = 0; i < 7; i++) {
        await repo.record({ actorId: userId, action: 'auth.login.success' });
      }
      for (let i = 0; i < 3; i++) {
        await repo.record({ action: 'auth.login.failed' });
      }
    });

    it('returns the total without filters', async () => {
      expect(await repo.count()).toBe(10);
    });

    it('counts respecting filters', async () => {
      expect(await repo.count({ actionPrefix: 'auth.login.success' })).toBe(7);
      expect(await repo.count({ actionPrefix: 'auth.login.failed' })).toBe(3);
      expect(await repo.count({ actorId: userId })).toBe(7);
    });

    it('count and list agree (count >= list.length when paginating)', async () => {
      const total = await repo.count();
      const page = await repo.list({ limit: 5 });
      expect(page.length).toBeLessThanOrEqual(total);
    });
  });
});
