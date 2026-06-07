import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDb } from '@diluxite/db';
import { buildApp } from './app';
import { buildTestApp, TEST_DATABASE_URL } from '../test/helpers';

/**
 * MCP server e2e con un cliente MCP REAL (el mismo SDK que usan Claude/Copilot/
 * Codex) sobre Streamable HTTP. Cubrimos el "segundo cerebro" completo: las 10
 * tools, además de los caminos de seguridad (sin auth → rechazo) y de
 * autorización (no podés tocar un space del que no sos miembro).
 */

function textOf(res: unknown): string {
  return ((res as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n');
}
function idOf(listText: string, title: string): string | undefined {
  return listText.match(new RegExp(`${title}\\s*\\(id:\\s*([0-9a-f-]+)\\)`, 'i'))?.[1];
}

async function connectClient(port: number): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

describe('MCP server — second-brain tools (real MCP client)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let client: Client;
  let userId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    userId = t.userId;
    await app.listen({ port: 0, host: '127.0.0.1' });
    client = await connectClient((app.server.address() as AddressInfo).port);
  });

  afterEach(async () => {
    await client.close();
    await app.close();
    await sql.end();
  });

  it('lists all ten memory tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'append_to_note',
        'backlinks_of',
        'list_notes',
        'list_spaces',
        'list_tags',
        'read_note',
        'recent_notes',
        'search_by_tag',
        'search_memory',
        'write_note',
      ].sort(),
    );
  });

  it('write_note + search_memory: stores and retrieves a memory by meaning', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Azure', content: 'Azure is the Microsoft cloud' },
    });
    const res = await client.callTool({
      name: 'search_memory',
      arguments: { query: 'the microsoft cloud' },
    });
    expect(textOf(res)).toContain('Azure');
  });

  it('read_note returns the full content of a note by id', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Doc', content: 'full body here' } });
    const list = textOf(await client.callTool({ name: 'list_notes', arguments: {} }));
    const id = idOf(list, 'Doc');
    expect(id).toBeTruthy();
    const read = textOf(await client.callTool({ name: 'read_note', arguments: { id } }));
    expect(read).toContain('full body here');
  });

  it('append_to_note lets the AI jot onto an existing memory', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Journal', content: 'line 1' } });
    const id = idOf(textOf(await client.callTool({ name: 'list_notes', arguments: {} })), 'Journal');
    await client.callTool({ name: 'append_to_note', arguments: { id, content: 'line 2' } });
    const read = textOf(await client.callTool({ name: 'read_note', arguments: { id } }));
    expect(read).toContain('line 1');
    expect(read).toContain('line 2');
  });

  it('list_notes and list_spaces', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Note1', content: 'hi' } });
    expect(textOf(await client.callTool({ name: 'list_notes', arguments: {} }))).toContain('Note1');
    expect(textOf(await client.callTool({ name: 'list_spaces', arguments: {} }))).toContain('My space');
  });

  it('list_tags + search_by_tag + recent_notes', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Infra', content: 'uses #pgvector and #azure' },
    });
    expect(textOf(await client.callTool({ name: 'list_tags', arguments: {} }))).toContain('pgvector');
    expect(
      textOf(await client.callTool({ name: 'search_by_tag', arguments: { tag: 'pgvector' } })),
    ).toContain('Infra');
    expect(textOf(await client.callTool({ name: 'recent_notes', arguments: {} }))).toContain('Infra');
  });

  it('backlinks_of lists notes that wikilink to a target', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Target', content: 'the target' } });
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Source', content: 'see [[Target]] for details' },
    });
    const targetId = idOf(textOf(await client.callTool({ name: 'list_notes', arguments: {} })), 'Target');
    const res = textOf(await client.callTool({ name: 'backlinks_of', arguments: { id: targetId } }));
    expect(res).toContain('Source');
  });

  it('write_note into a space the user does NOT belong to is refused', async () => {
    // Crear otro usuario + org + space que el single-user NO posee.
    const db = createDb(TEST_DATABASE_URL);
    const [other] = await db.sql<{ id: string }[]>`
      INSERT INTO users (email, provider) VALUES ('stranger@x.com', 'local') RETURNING id`;
    const [org] = await db.sql<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES ('Other', 'other-org') RETURNING id`;
    const [foreign] = await db.sql<{ id: string }[]>`
      INSERT INTO spaces (name, owner_id, org_id) VALUES ('Foreign', ${other.id}, ${org.id}) RETURNING id`;
    await db.sql.end();

    const res = textOf(
      await client.callTool({
        name: 'write_note',
        arguments: { title: 'sneaky', content: 'x', space: foreign.id },
      }),
    );
    expect(res).toMatch(/no accessible space/i);
    expect(userId).toBeTruthy();
  });
});

describe('MCP server — authentication gate', () => {
  let app: FastifyInstance;
  let sql: Sql;

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('rejects an unauthenticated MCP client (no identity → 401)', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    // Reconstruir la app con un AuthProvider que nunca resuelve identidad.
    await t.app.close();
    app = await buildApp({ ...t.deps, auth: { resolve: async () => null } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const client = new Client({ name: 'anon', version: '0.0.0' });
    await expect(
      client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))),
    ).rejects.toThrow();
  });
});
