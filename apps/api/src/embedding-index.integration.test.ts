import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { partitionNameOf } from '@diluxite/db';
import { buildTestApp } from '../test/helpers';

/**
 * The vector index is used, and the vectors land in the right space — ADR-003.
 *
 * Both are invisible failures. An index that exists but is never chosen by the
 * planner reads as "we have an index" and performs like a sequential scan. And
 * vectors filed under a model that did not produce them are not wrong-ish, they
 * are meaningless — the search still returns results, they just have nothing to
 * do with the question.
 */
describe('embeddings land in one vector space, and the index is used', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;
  let orgId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
    orgId = t.defaultOrgId;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  const createNote = async (title: string, body = 'cuerpo con texto suficiente para un chunk.') => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title, contentMd: `# ${title}\n\n${body}\n` },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };

  it('saving a note writes its vectors into the live model, not into `chunks`', async () => {
    await createNote('Uno');

    const [{ n: vectors }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM chunk_embeddings`;
    expect(vectors).toBeGreaterThan(0);

    // The pre-ADR-003 column is no longer written. It still exists so this
    // change is reversible, but nothing depends on it.
    const [{ n: legacy }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chunks WHERE embedding IS NOT NULL`;
    expect(legacy).toBe(0);

    const rows = await sql<{ slot: string }[]>`SELECT DISTINCT slot FROM chunk_embeddings`;
    expect(rows).toHaveLength(1);
    const [{ slot }] = await sql<{ slot: string }[]>`
      SELECT slot FROM embedding_models WHERE org_id = ${orgId} AND state = 'active'`;
    expect(rows[0].slot).toBe(slot);
    // ADR-005: the organisation comes first in the slot, so two organisations
    // on the same model never share a partition.
    expect(slot.startsWith(orgId)).toBe(true);
  });

  it('the vectors physically live in that model\'s partition', async () => {
    await createNote('Uno');
    const [{ slot }] = await sql<{ slot: string }[]>`
      SELECT slot FROM embedding_models WHERE org_id = ${orgId} AND state = 'active'`;

    // Not the parent — the partition. This is what makes the index possible.
    const [{ n }] = await sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ONLY ${partitionNameOf(slot)}`,
    );
    expect(n).toBeGreaterThan(0);
  });

  it('deleting a note takes its vectors with it', async () => {
    const id = await createNote('Uno');
    await app.inject({ method: 'DELETE', url: `/api/notes/${id}/purge` }).catch(() => undefined);
    await app.inject({ method: 'DELETE', url: `/api/notes/${id}` });
    await app.inject({ method: 'DELETE', url: `/api/notes/${id}/purge` });

    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chunk_embeddings e
      JOIN chunks c ON c.id = e.chunk_id WHERE c.note_id = ${id}`;
    expect(n).toBe(0);
  });

  it('re-saving replaces the vectors rather than accumulating them', async () => {
    const id = await createNote('Uno');
    const before = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM chunk_embeddings`;

    await app.inject({
      method: 'PUT',
      url: `/api/notes/${id}`,
      payload: { contentMd: '# Uno\n\notro cuerpo, igual de largo que el anterior.\n' },
    });

    const after = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM chunk_embeddings`;
    expect(after[0].n).toBe(before[0].n);
  });

  it('the planner CHOOSES the HNSW index — an unused index is a decoration', async () => {
    // Seeded straight into the partition: what matters is the plan, and a
    // handful of rows would let the planner pick a scan for good reasons.
    const [{ slot, dimensions }] = await sql<{ slot: string; dimensions: number }[]>`
      SELECT slot, dimensions FROM embedding_models WHERE org_id = ${orgId} AND state = 'active'`;
    const noteId = await createNote('Semilla');
    const [{ id: chunkId }] = await sql<{ id: string }[]>`
      SELECT id FROM chunks WHERE note_id = ${noteId} LIMIT 1`;
    expect(chunkId).toBeTruthy();

    await sql.unsafe(`
      INSERT INTO chunk_embeddings (chunk_id, slot, org_id, space_id, embedding)
      SELECT gen_random_uuid(), $1, $3, $2,
             (SELECT ('[' || string_agg(random()::text, ',') || ']')::vector
              FROM generate_series(1, ${dimensions}))
      FROM generate_series(1, 3000)
      ON CONFLICT DO NOTHING`, [slot, spaceId, orgId]).catch(() => undefined);

    await sql`ANALYZE chunk_embeddings`;
    const probe = `[${Array.from({ length: dimensions }, () => '0.01').join(',')}]`;
    const plan = await sql.unsafe<{ 'QUERY PLAN': string }[]>(`
      EXPLAIN (COSTS OFF)
      SELECT e.chunk_id FROM chunk_embeddings e
      WHERE e.slot = $1 AND e.space_id = $2
      ORDER BY e.embedding::vector(${dimensions}) <=> $3::vector(${dimensions})
      LIMIT 5`, [slot, spaceId, probe]);

    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text, `the planner did not use the HNSW index:\n${text}`).toMatch(/Index Scan using .*hnsw/i);
    // And it pruned to one partition rather than reading every model's.
    expect(text).not.toMatch(/Append/);
  });
});
