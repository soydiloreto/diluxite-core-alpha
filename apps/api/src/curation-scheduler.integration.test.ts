import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';
import { startCurationScheduler } from './curation-scheduler';
import type { AppDeps } from './app';

/**
 * The sweep that makes the ritual survive a busy quarter.
 */
describe('curation scheduler (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let deps: AppDeps;
  let spaceId: string;

  async function noteUsed(title: string, times: number) {
    const id = (
      await app.inject({
        method: 'POST',
        url: `/api/spaces/${spaceId}/notes`,
        payload: { title, contentMd: 'x' },
      })
    ).json().id as string;
    await sql`
      INSERT INTO entity_usage (entity_kind, entity_id, space_id, use_count)
      VALUES ('note', ${id}, ${spaceId}, ${times})`;
    return id;
  }

  const openBatch = async () =>
    (await app.inject({ url: `/api/spaces/${spaceId}/curation` })).json() as unknown[];

  beforeEach(async () => {
    ({ app, sql, deps, defaultSpaceId: spaceId } = await buildTestApp());
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('builds the batch for a space that never had one', async () => {
    await noteUsed('Umbral', 9);
    const s = startCurationScheduler(deps, sql, { intervalDays: 7 });
    expect(await s.runOnce()).toBe(1);
    expect(await openBatch()).toHaveLength(1);
    s.stop();
  });

  it('does NOT rebuild a batch that is younger than the interval', async () => {
    await noteUsed('Umbral', 9);
    const s = startCurationScheduler(deps, sql, { intervalDays: 7 });
    await s.runOnce();
    const first = (await openBatch()) as { id: string }[];
    // Rebuilding on every tick would hand an owner a fresh batch the moment
    // they cleared the last card — the opposite of a fixed weekly budget.
    expect(await s.runOnce()).toBe(0);
    const second = (await openBatch()) as { id: string }[];
    expect(second[0].id).toBe(first[0].id);
    s.stop();
  });

  it('rebuilds once the last batch is older than the interval', async () => {
    await noteUsed('Umbral', 9);
    const s = startCurationScheduler(deps, sql, { intervalDays: 7 });
    await s.runOnce();
    const first = (await openBatch()) as { id: string }[];
    await sql`UPDATE curation_queue SET created_at = now() - interval '8 days'`;
    expect(await s.runOnce()).toBe(1);
    const second = (await openBatch()) as { id: string }[];
    expect(second[0].id).not.toBe(first[0].id);
    s.stop();
  });

  it('a space the memory never leaned on is never proposed', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'Nunca usada', contentMd: 'x' },
    });
    const s = startCurationScheduler(deps, sql, { intervalDays: 7 });
    expect(await s.runOnce()).toBe(0);
    s.stop();
  });

  it('an interval of zero turns it off entirely', async () => {
    await noteUsed('Umbral', 9);
    const s = startCurationScheduler(deps, sql, { intervalDays: 0 });
    expect(await s.runOnce()).toBe(0);
    expect(await openBatch()).toHaveLength(0);
    s.stop();
  });

  it('two schedulers sweeping at once do not both build', async () => {
    await noteUsed('Umbral', 9);
    const a = startCurationScheduler(deps, sql, { intervalDays: 7 });
    const b = startCurationScheduler(deps, sql, { intervalDays: 7 });
    // The advisory lock is what keeps two API replicas from rebuilding the
    // same week's batch — try, never wait.
    const [ra, rb] = await Promise.all([a.runOnce(), b.runOnce()]);
    expect([ra, rb].filter((n) => n > 0)).toHaveLength(1);
    expect(await openBatch()).toHaveLength(1);
    a.stop();
    b.stop();
  });
});
