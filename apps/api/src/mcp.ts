import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AppDeps } from './app';

/** Crea un servidor MCP con las tools de la supermemoria (PRD §13). */
export function createMcpServer(deps: AppDeps): McpServer {
  const server = new McpServer({ name: 'diluxite', version: '0.1.0' });

  server.tool(
    'buscar_memoria',
    'Busca en la memoria por significado y por palabra clave; devuelve las notas más relevantes.',
    { query: z.string(), espacio: z.string().optional(), topK: z.number().optional() },
    async ({ query, espacio, topK }) => {
      const results = await deps.search.search(espacio ?? deps.defaultSpaceId, query, topK ?? 5);
      const text = results.length
        ? results.map((r, i) => `${i + 1}. ${r.titulo}\n   ${r.snippet}`).join('\n')
        : 'Sin resultados.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'listar_notas',
    'Lista las notas de un espacio.',
    { espacio: z.string().optional() },
    async ({ espacio }) => {
      const notes = await deps.notes.list(espacio ?? deps.defaultSpaceId);
      const text = notes.length
        ? notes.map((n) => `- ${n.titulo} (id: ${n.id})`).join('\n')
        : 'No hay notas.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'leer_nota',
    'Lee el contenido completo de una nota por id.',
    { id: z.string() },
    async ({ id }) => {
      const note = await deps.notes.get(id);
      return { content: [{ type: 'text', text: note ? note.contenidoMd : 'No existe.' }] };
    },
  );

  server.tool(
    'escribir_nota',
    'Crea o actualiza una nota por título (guarda un recuerdo en la memoria).',
    { titulo: z.string(), contenido: z.string(), espacio: z.string().optional() },
    async ({ titulo, contenido, espacio }) => {
      const sid = espacio ?? deps.defaultSpaceId;
      const note = await deps.notes.openOrCreate(sid, titulo);
      const updated = await deps.notes.update(note.id, { contenidoMd: contenido });
      return { content: [{ type: 'text', text: `Guardada "${titulo}" (id: ${updated?.id}).` }] };
    },
  );

  server.tool('listar_espacios', 'Lista los espacios de trabajo disponibles.', {}, async () => {
    const spaces = await deps.spaces.listForUser(deps.userId);
    const text = spaces.map((s) => `- ${s.nombre} (id: ${s.id})`).join('\n');
    return { content: [{ type: 'text', text }] };
  });

  return server;
}

/** Monta el endpoint MCP Streamable HTTP en /mcp (stateful por sesión). */
export function registerMcp(app: FastifyInstance, deps: AppDeps): void {
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? transports[sessionId] : undefined;

      if (!transport) {
        if (req.method === 'POST' && isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports[sid] = transport!;
            },
          });
          transport.onclose = () => {
            const sid = transport!.sessionId;
            if (sid) delete transports[sid];
          };
          await createMcpServer(deps).connect(transport);
        } else {
          reply.code(400).send({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Sesión MCP inválida o falta initialize' },
            id: null,
          });
          return;
        }
      }

      reply.hijack();
      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  });
}
