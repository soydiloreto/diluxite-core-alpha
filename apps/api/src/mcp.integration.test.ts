import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildTestApp } from '../test/helpers';

function textOf(res: unknown): string {
  return ((res as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n');
}

describe('MCP server (e2e with a real MCP client)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let client: Client;

  beforeEach(async () => {
    ({ app, sql } = await buildTestApp());
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });

  afterEach(async () => {
    await client.close();
    await app.close();
    await sql.end();
  });

  it('exposes the memory tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'search_memory',
        'list_notes',
        'read_note',
        'write_note',
        'list_spaces',
      ]),
    );
  });

  it('write_note + search_memory: stores and retrieves a memory', async () => {
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

  it('list_notes and list_spaces', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Note1', content: 'hi' } });
    expect(textOf(await client.callTool({ name: 'list_notes', arguments: {} }))).toContain('Note1');
    expect(textOf(await client.callTool({ name: 'list_spaces', arguments: {} }))).toContain(
      'My space',
    );
  });

  it('super-memory tools: tags and recent notes', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Infra', content: 'uses #pgvector and #azure' },
    });
    expect(textOf(await client.callTool({ name: 'list_tags', arguments: {} }))).toContain('pgvector');
    expect(textOf(await client.callTool({ name: 'recent_notes', arguments: {} }))).toContain('Infra');
  });
});
