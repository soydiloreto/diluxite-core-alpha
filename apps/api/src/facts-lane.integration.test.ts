import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildTestApp } from '../test/helpers';

/**
 * The structured lane, end to end — ADR-001 step 2.
 *
 * A table written inside a note becomes rows at save time, and a question
 * naming one of its keys gets the exact value ABOVE the prose, with the note
 * and line it came from.
 *
 * What is really under test is the composition. Getting the fact into the
 * database is the easy half; the half that fails silently is an exact answer
 * averaged into the prose ranking, where it lands third and nobody reads it.
 */

const METRICS = `# Métricas del trimestre

Venimos midiendo esto desde marzo.

| Métrica | Valor | Dueño |
| --- | --- | --- |
| MRR | 42k | Ana |
| Altas | 120 | Beto |
| Churn | 3% | Ana |
`;

describe('the structured lane answers from tables', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;
  let client: Client;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
    await app.listen({ port: 0, host: '127.0.0.1' });
    client = new Client({ name: 'facts-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`),
      ),
    );
  });

  afterEach(async () => {
    await client.close();
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

  const ask = async (query: string): Promise<string> => {
    const res = await client.callTool({ name: 'search_memory', arguments: { query } });
    return ((res as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n');
  };

  it('derives facts from a table at save time', async () => {
    const id = await createNote('Métricas', METRICS);
    const rows = await sql<{ key: string; column_name: string; value: string; source_line: number }[]>`
      SELECT key, column_name, value, source_line FROM facts WHERE note_id = ${id}
      ORDER BY source_line, column_name`;
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ key: 'MRR', column_name: 'Dueño', value: 'Ana' });
    // The line is the ROW's, not the note's — an answer can point at it.
    expect(rows[0].source_line).toBe(7);
  });

  it('puts the exact value ABOVE the prose, with its source', async () => {
    await createNote('Métricas', METRICS);
    const text = await ask('cuánto es el MRR');

    expect(text).toContain('FACTS');
    expect(text).toContain('MRR · Valor: 42k');
    expect(text).toContain('Métricas:7');

    // Composition, not fusion: the fact block precedes the prose block.
    expect(text.indexOf('FACTS')).toBeLessThan(text.indexOf('---'));
  });

  it('narrows to the column the question asks for', async () => {
    await createNote('Métricas', METRICS);
    const text = await ask('quién es el dueño del MRR');
    expect(text).toContain('MRR · Dueño: Ana');
    expect(text).not.toContain('MRR · Valor');
  });

  it('hands over the whole row when no column is named', async () => {
    await createNote('Métricas', METRICS);
    const text = await ask('MRR');
    expect(text).toContain('MRR · Valor: 42k');
    expect(text).toContain('MRR · Dueño: Ana');
  });

  // The lane runs on every query and costs one lookup. A question naming no
  // key simply gets the prose it would have got anyway.
  it('stays out of the way when the question names no key', async () => {
    await createNote('Métricas', METRICS);
    const text = await ask('cómo venimos con el producto en general');
    expect(text).not.toContain('FACTS');
  });

  it('re-deriving replaces the note\'s facts rather than accumulating them', async () => {
    const id = await createNote('Métricas', METRICS);
    await app.inject({
      method: 'PUT',
      url: `/api/notes/${id}`,
      payload: {
        contentMd: `| Métrica | Valor |
| --- | --- |
| MRR | 55k |
| Altas | 130 |
`,
      },
    });
    const rows = await sql<{ key: string; value: string }[]>`
      SELECT key, value FROM facts WHERE note_id = ${id} ORDER BY key`;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.key === 'MRR')!.value).toBe('55k');
    // The old owner column is gone, not orphaned alongside the new set.
    expect(rows.some((r) => r.value === 'Ana')).toBe(false);
  });

  it('a table it refuses to index answers nothing, and the prose still does', async () => {
    // Repeated keys: a lookup would return conflicting rows with the
    // confidence of an exact hit, so nothing is indexed.
    await createNote(
      'Equipos',
      `| Equipo | Persona |
| --- | --- |
| Data | Ana |
| Data | Beto |
| UX | Caro |
`,
    );
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM facts`;
    expect(n).toBe(0);

    const text = await ask('Data');
    expect(text).not.toContain('FACTS');
  });

  it('trashing a note takes its facts with it', async () => {
    const id = await createNote('Métricas', METRICS);
    await app.inject({ method: 'DELETE', url: `/api/notes/${id}` });
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM facts WHERE note_id = ${id}`;
    expect(n).toBe(0);
  });
});
