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

describe('Servidor MCP (e2e con cliente MCP real)', () => {
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

  it('expone las tools de la memoria', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'buscar_memoria',
        'listar_notas',
        'leer_nota',
        'escribir_nota',
        'listar_espacios',
      ]),
    );
  });

  it('escribir_nota + buscar_memoria: guarda y recupera un recuerdo', async () => {
    await client.callTool({
      name: 'escribir_nota',
      arguments: { titulo: 'Azure', contenido: 'Azure es la nube de Microsoft' },
    });
    const res = await client.callTool({
      name: 'buscar_memoria',
      arguments: { query: 'la nube de microsoft' },
    });
    expect(textOf(res)).toContain('Azure');
  });

  it('listar_notas y listar_espacios', async () => {
    await client.callTool({ name: 'escribir_nota', arguments: { titulo: 'Nota1', contenido: 'hola' } });
    expect(textOf(await client.callTool({ name: 'listar_notas', arguments: {} }))).toContain('Nota1');
    expect(textOf(await client.callTool({ name: 'listar_espacios', arguments: {} }))).toContain(
      'Mi espacio',
    );
  });

  it('tools de supermemoria: tags y recientes', async () => {
    await client.callTool({
      name: 'escribir_nota',
      arguments: { titulo: 'Infra', contenido: 'usa #pgvector y #azure' },
    });
    expect(textOf(await client.callTool({ name: 'listar_tags', arguments: {} }))).toContain('pgvector');
    expect(textOf(await client.callTool({ name: 'notas_recientes', arguments: {} }))).toContain('Infra');
  });
});
