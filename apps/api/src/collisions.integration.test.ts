import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';
import type { AppDeps } from './app';
import { collisionsIn } from './collisions';

/**
 * Company Brain §9's third defence: the word doing two jobs.
 *
 * The deterministic embedder used in tests hashes words, so two notes about
 * genuinely different subjects land far apart and two about the same subject
 * land close — which is exactly the property under test.
 */
describe('meaning collisions (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let deps: AppDeps;
  let spaceId: string;

  const table = (rows: string[]) =>
    ['| parámetro | valor |', '|---|---|', ...rows].join('\n');

  async function note(title: string, contentMd: string) {
    return (
      await app.inject({
        method: 'POST',
        url: `/api/spaces/${spaceId}/notes`,
        payload: { title, contentMd },
      })
    ).json().id as string;
  }

  beforeEach(async () => {
    ({ app, sql, deps, defaultSpaceId: spaceId } = await buildTestApp());
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('finds one key stated differently by two notes that are not about the same thing', async () => {
    await note(
      'Finanzas trimestrales',
      `presupuesto contable cierre fiscal auditoría balance\n\n${table(['| mrr | 42 |', '| churn | 2% |'])}`,
    );
    await note(
      'Infraestructura de red',
      `kubernetes contenedores latencia routers switches\n\n${table(['| mrr | 900 |', '| uptime | 99% |'])}`,
    );

    const found = await collisionsIn(deps, spaceId);
    const mrr = found.find((c) => c.key === 'mrr');
    expect(mrr).toBeDefined();
    expect([mrr!.a.value, mrr!.b.value].sort()).toEqual(['42', '900']);
  });

  it('two notes AGREEING are corroboration, not a collision', async () => {
    // The best thing that can happen to a memory is two areas reaching the
    // same number from different places. Warning about it would be noise.
    await note('Finanzas', `presupuesto contable fiscal\n\n${table(['| mrr | 42 |', '| churn | 2% |'])}`);
    await note('Infra', `kubernetes latencia routers\n\n${table(['| mrr | 42 |', '| uptime | 99% |'])}`);

    expect((await collisionsIn(deps, spaceId)).find((c) => c.key === 'mrr')).toBeUndefined();
  });

  it('a key only one note states cannot collide', async () => {
    await note('Sola', `texto\n\n${table(['| solo | 1 |', '| otro | 2 |'])}`);
    expect(await collisionsIn(deps, spaceId)).toEqual([]);
  });

  it('the route answers the same thing', async () => {
    await note(
      'Finanzas trimestrales',
      `presupuesto contable cierre fiscal auditoría\n\n${table(['| mrr | 42 |', '| churn | 2% |'])}`,
    );
    await note(
      'Infraestructura de red',
      `kubernetes contenedores latencia routers\n\n${table(['| mrr | 900 |', '| uptime | 99% |'])}`,
    );
    const r = await app.inject({ url: `/api/spaces/${spaceId}/collisions` });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { key: string }[]).some((c) => c.key === 'mrr')).toBe(true);
  });
});
