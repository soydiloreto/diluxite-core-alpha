import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';
import type { AppDeps } from './app';

/**
 * Changing the embedding model must not take search down — ADR-003.
 *
 * Every assertion here was a failure before migration 0034, measured on the
 * shipped code:
 *
 *   · the moment the new model was saved, semantic search returned ZERO —
 *     the query was embedded with the new provider and asked its empty
 *     partition, while the catalogue still called the old model active;
 *   · the reindex then filled the new space and, because replacing a note's
 *     chunks cascades to its vectors, EMPTIED the old one. An `active` model
 *     with no vectors, and nothing to roll back to;
 *   · `related`, which reads the catalogue rather than the configuration,
 *     answered nothing even after the reindex finished.
 *
 * The rule the suite pins: reads follow the ACTIVE model, writes go to every
 * space that exists, and the flip is a separate, explicit act.
 */

const DIFFERENT_DIMENSIONS = 384;

describe('changing the embedding model', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let deps: AppDeps;
  let spaceId: string;
  let orgId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    deps = t.deps;
    spaceId = t.defaultSpaceId;
    orgId = t.defaultOrgId;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  const addNote = async (title: string, contentMd: string) => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title, contentMd },
    });
    expect(r.statusCode).toBe(201);
    return (r.json() as { id: string }).id;
  };

  /** Semantic only, so the keyword channel cannot carry the result. */
  const semantic = async (query: string) =>
    (await deps.search.search(spaceId, query, 5, 'semantic')).map((r) => r.title);

  const models = async () =>
    Object.fromEntries(
      (
        await sql<{ slot: string; state: string }[]>`
          SELECT slot, state FROM embedding_models WHERE org_id = ${orgId}`
      ).map((r) => [r.slot.split(':').slice(1).join(':'), r.state]),
    );

  const vectorsBySlot = async () =>
    Object.fromEntries(
      (
        await sql<{ slot: string; count: string }[]>`
          SELECT slot, count(*) FROM chunk_embeddings GROUP BY slot`
      ).map((r) => [r.slot.split(':').slice(1).join(':'), Number(r.count)]),
    );

  const chooseModel = async (dimensions: number) => {
    const r = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${orgId}/embeddings/config`,
      payload: { provider: 'local', model: null, dimensions, endpoint: null },
    });
    expect(r.statusCode).toBe(200);
    return r.json() as { nextStep: string };
  };

  it('search keeps working from the moment the new model is saved', async () => {
    await addNote('Arquitectura', 'La búsqueda combina BM25 con pgvector y fusiona con RRF.');
    expect(await semantic('pgvector')).toContain('Arquitectura');

    await chooseModel(DIFFERENT_DIMENSIONS);

    // The window that used to be an outage: between the save and the reindex.
    expect(await semantic('pgvector')).toContain('Arquitectura');
  });

  it('the reindex fills the new space without emptying the live one', async () => {
    await addNote('Arquitectura', 'La búsqueda combina BM25 con pgvector y fusiona con RRF.');
    await chooseModel(DIFFERENT_DIMENSIONS);

    const re = await app.inject({ method: 'POST', url: '/api/admin/reindex', payload: { orgId } });
    expect(re.statusCode).toBe(200);

    const vectors = await vectorsBySlot();
    // Both, not one: building alongside is the whole point.
    expect(vectors['local:default@1536'], 'the live space was emptied').toBeGreaterThan(0);
    expect(vectors[`local:default@${DIFFERENT_DIMENSIONS}`], 'the new space is empty').toBeGreaterThan(
      0,
    );
    expect(await semantic('pgvector')).toContain('Arquitectura');
  });

  it('a note saved during the change lands in both spaces', async () => {
    await chooseModel(DIFFERENT_DIMENSIONS);
    await addNote('Durante', 'Una nota escrita mientras el modelo nuevo se construye.');

    const vectors = await vectorsBySlot();
    expect(vectors['local:default@1536']).toBeGreaterThan(0);
    expect(vectors[`local:default@${DIFFERENT_DIMENSIONS}`]).toBeGreaterThan(0);
  });

  it('the catalogue still says which model is live, and it is the old one', async () => {
    await addNote('Arquitectura', 'pgvector y RRF.');
    await chooseModel(DIFFERENT_DIMENSIONS);
    expect(await models()).toEqual({
      'local:default@1536': 'active',
      [`local:default@${DIFFERENT_DIMENSIONS}`]: 'building',
    });
    // And the console says what is left to do rather than implying it happened.
    const saved = await chooseModel(DIFFERENT_DIMENSIONS);
    expect(saved.nextStep).toBe('reindex-then-activate');
  });

  it('activating is a separate act, and it refuses an unfilled space', async () => {
    await addNote('Arquitectura', 'La búsqueda combina BM25 con pgvector.');
    await chooseModel(DIFFERENT_DIMENSIONS);

    // Nothing has filled the new space yet — a flip now is a search that
    // stops finding things.
    const early = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgId}/embeddings/activate`,
      payload: {},
    });
    expect(early.statusCode).toBe(409);
    expect(await models()).toMatchObject({ 'local:default@1536': 'active' });

    await app.inject({ method: 'POST', url: '/api/admin/reindex', payload: { orgId } });
    const flip = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgId}/embeddings/activate`,
      payload: {},
    });
    expect(flip.statusCode).toBe(200);
    expect(await models()).toMatchObject({
      [`local:default@${DIFFERENT_DIMENSIONS}`]: 'active',
    });
    // And the search that follows reads the space that is now live.
    expect(await semantic('pgvector')).toContain('Arquitectura');
  });

  it('reindex can do both in one call when asked', async () => {
    await addNote('Arquitectura', 'La búsqueda combina BM25 con pgvector.');
    await chooseModel(DIFFERENT_DIMENSIONS);
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/reindex',
      payload: { orgId, activateWhenDone: true },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { activated: string | null }).activated).toContain(
      `local:default@${DIFFERENT_DIMENSIONS}`,
    );
    expect(await models()).toMatchObject({
      [`local:default@${DIFFERENT_DIMENSIONS}`]: 'active',
    });
    expect(await semantic('pgvector')).toContain('Arquitectura');
  });

  it('the neighbours panel answers from the same space search does', async () => {
    // `related` reads the catalogue and search used to read the configuration:
    // two answers to "which model is live", and after a change they disagreed.
    const id = await addNote('Arquitectura', 'La búsqueda combina BM25 con pgvector.');
    await addNote('Vecina', 'También habla de pgvector y de búsqueda vectorial.');
    expect((await deps.search.related(spaceId, id, 3)).length).toBeGreaterThan(0);

    await chooseModel(DIFFERENT_DIMENSIONS);
    await app.inject({ method: 'POST', url: '/api/admin/reindex', payload: { orgId } });
    expect(
      (await deps.search.related(spaceId, id, 3)).length,
      'related went silent after the model change',
    ).toBeGreaterThan(0);
  });
});
