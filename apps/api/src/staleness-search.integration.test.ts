import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * A search result knows how it is ageing — ADR-002, end to end.
 *
 * The unit tests pin the arithmetic; this pins that the cadence actually
 * reaches a result over HTTP, which is the half that silently does not happen
 * when a dependency is left unwired.
 *
 * Ages are forced by writing `entity_change_stats` directly. Waiting months
 * for a note to age is not a test, and the alternative — mocking the clock
 * through four layers — would test the mock.
 */

describe('search results carry their freshness', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  const createNote = async (title: string, contentMd: string): Promise<string> => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title, contentMd },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };

  /** Force a measured cadence and a last-changed date onto a note. */
  const setCadence = async (
    noteId: string,
    opts: { avgIntervalDays: number; changeCount: number; lastChangedDaysAgo: number },
  ) => {
    await sql`
      UPDATE entity_change_stats
      SET avg_interval_seconds = ${opts.avgIntervalDays * 86400},
          change_count = ${opts.changeCount},
          last_changed_at = now() - (${opts.lastChangedDaysAgo} || ' days')::interval
      WHERE entity_kind = 'note' AND entity_id = ${noteId}`;
  };

  const search = async (query: string) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query, spaceId, topK: 10 },
    });
    expect(r.statusCode).toBe(200);
    return r.json() as {
      noteId: string;
      title: string;
      freshness?: {
        level: string;
        usingPrior: boolean;
        intervalsElapsed: number;
        expectedIntervalSeconds: number;
      };
    }[];
  };

  it('every result comes back with a freshness assessment', async () => {
    await createNote('Azure', 'Azure is the Microsoft cloud');
    const hits = await search('microsoft cloud');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].freshness).toBeDefined();
  });

  it('a fresh note and a long-neglected one are told apart, same query', async () => {
    const fresh = await createNote('Métricas al día', 'MRR y usuarios del trimestre');
    const stale = await createNote('Métricas viejas', 'MRR y usuarios del trimestre');

    // Both change about monthly. One was touched last week, the other eight
    // months ago — that is eight of its own cycles.
    await setCadence(fresh, { avgIntervalDays: 30, changeCount: 10, lastChangedDaysAgo: 7 });
    await setCadence(stale, { avgIntervalDays: 30, changeCount: 10, lastChangedDaysAgo: 240 });

    const hits = await search('MRR usuarios trimestre');
    const byId = new Map(hits.map((h) => [h.noteId, h]));
    expect(byId.get(fresh)!.freshness!.level).toBe('fresh');
    expect(byId.get(stale)!.freshness!.level).toBe('stale');
  });

  /**
   * The point of judging in the entity's own rhythm rather than by the
   * calendar. These two notes were last touched on the SAME day; a fixed
   * "older than N days" rule would have to give them the same verdict, and one
   * of those verdicts would be wrong.
   */
  it('two notes of identical age get opposite verdicts on their own cadences', async () => {
    const slow = await createNote('Arquitectura', 'decisiones de arquitectura del motor');
    const fast = await createNote('Panel semanal', 'decisiones de arquitectura del motor');

    await setCadence(slow, { avgIntervalDays: 365, changeCount: 4, lastChangedDaysAgo: 60 });
    await setCadence(fast, { avgIntervalDays: 7, changeCount: 30, lastChangedDaysAgo: 60 });

    const hits = await search('decisiones arquitectura motor');
    const byId = new Map(hits.map((h) => [h.noteId, h]));
    expect(byId.get(slow)!.freshness!.level).toBe('fresh');
    expect(byId.get(fast)!.freshness!.level).toBe('stale');
  });

  it('says when it is leaning on a prior instead of on evidence', async () => {
    // A note created and never edited again: one change is a point, not an
    // interval. The answer still comes, and it declares what it rests on.
    await createNote('Recién nacida', 'contenido nuevo sobre pgvector');
    const [hit] = await search('pgvector');
    expect(hit.freshness!.usingPrior).toBe(true);
  });

  it('a table-shaped note starts from the structured prior, not the prose one', async () => {
    const table = await createNote(
      'Tabla de métricas',
      ['| Métrica | Valor |', '| --- | --- |', '| MRR | 42k |', '| Altas | 120 |'].join('\n'),
    );
    const prose = await createNote(
      'Notas de métricas',
      'Venimos midiendo el MRR y las altas todos los meses desde marzo.',
    );
    // Neither has a measured cadence; only their shape differs.
    await sql`UPDATE entity_change_stats
              SET last_changed_at = now() - interval '100 days'
              WHERE entity_id IN (${table}, ${prose})`;

    const hits = await search('MRR altas métricas');
    const byId = new Map(hits.map((h) => [h.noteId, h]));
    expect(byId.get(table)!.freshness!.usingPrior).toBe(true);
    expect(byId.get(prose)!.freshness!.usingPrior).toBe(true);
    // 100 days is nothing for something shaped like a table, and two cycles
    // for something shaped like prose.
    expect(byId.get(table)!.freshness!.expectedIntervalSeconds).toBeGreaterThan(
      byId.get(prose)!.freshness!.expectedIntervalSeconds,
    );
    expect(byId.get(table)!.freshness!.level).toBe('fresh');
    expect(byId.get(prose)!.freshness!.level).toBe('aging');
  });

  /**
   * The scenario the whole feature exists for: an agent asks, the note is
   * eight months past its own rhythm, and the answer says so IN THE TEXT the
   * model will read out. A `freshness` object on a JSON response an agent
   * never parses would have been a feature nobody uses.
   */
  it('MCP search warns in plain words about a note past its cadence', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );

    const stale = await createNote('Métricas del trimestre', 'MRR del trimestre: 42k');
    await setCadence(stale, { avgIntervalDays: 30, changeCount: 12, lastChangedDaysAgo: 240 });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as import('node:net').AddressInfo;
    const client = new Client({ name: 'staleness-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      const res = await client.callTool({
        name: 'search_memory',
        arguments: { query: 'MRR del trimestre' },
      });
      const text = ((res as { content: { text: string }[] }).content ?? [])
        .map((c) => c.text)
        .join('\n');

      expect(text).toContain('Métricas del trimestre');
      expect(text).toContain('240 days ago');
      expect(text).toContain('30-day cadence');
      expect(text).toContain('unconfirmed');
    } finally {
      await client.close();
    }
  });

  it('MCP search stays quiet about a note that is on time', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );

    const fresh = await createNote('Nota al día', 'pgvector y búsqueda híbrida');
    await setCadence(fresh, { avgIntervalDays: 30, changeCount: 12, lastChangedDaysAgo: 2 });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as import('node:net').AddressInfo;
    const client = new Client({ name: 'staleness-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      const res = await client.callTool({
        name: 'search_memory',
        arguments: { query: 'pgvector búsqueda híbrida' },
      });
      const text = ((res as { content: { text: string }[] }).content ?? [])
        .map((c) => c.text)
        .join('\n');

      expect(text).toContain('Nota al día');
      expect(text).not.toContain('⚠');
    } finally {
      await client.close();
    }
  });

  it('GET /api/notes/:id carries the freshness with the note', async () => {
    // Opening a note is exactly when "is this still good?" is worth
    // answering, so it rides along rather than needing a second request that
    // some caller will forget to make.
    const id = await createNote('Con vejez', 'contenido sobre despliegues');
    await setCadence(id, { avgIntervalDays: 14, changeCount: 20, lastChangedDaysAgo: 120 });

    const r = await app.inject({ method: 'GET', url: `/api/notes/${id}` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { freshness?: { level: string; usingPrior: boolean } };
    expect(body.freshness).toBeDefined();
    expect(body.freshness!.level).toBe('stale');
    expect(body.freshness!.usingPrior).toBe(false);
  });

  /**
   * The web app reads notes out of the LIST payload, never out of the detail
   * endpoint. A field present only on GET /api/notes/:id was wired in the API
   * and invisible in the product — every integration test passed and the badge
   * did not render. Found by opening the app; pinned here so it is not found
   * that way twice.
   */
  it('the notes LIST carries freshness too, which is where the UI reads it', async () => {
    const id = await createNote('En la lista', 'contenido sobre despliegues');
    await setCadence(id, { avgIntervalDays: 14, changeCount: 20, lastChangedDaysAgo: 120 });

    const r = await app.inject({ method: 'GET', url: `/api/spaces/${spaceId}/notes` });
    expect(r.statusCode).toBe(200);
    const listed = (r.json() as { id: string; freshness?: { level: string } }[]).find(
      (n) => n.id === id,
    );
    expect(listed!.freshness).toBeDefined();
    expect(listed!.freshness!.level).toBe('stale');
  });
});
