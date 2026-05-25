import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AppDeps } from './app';

export interface McpContext {
  userId: string;
  defaultSpaceId: string | null;
}

/** Servidor MCP con las tools de la supermemoria, scopeado a un usuario (PRD §13). */
export function createMcpServer(deps: AppDeps, ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'diluxite', version: '0.1.0' });

  // Resuelve y autoriza el espacio (default = primer espacio del usuario).
  const spaceFor = async (espacio?: string): Promise<string | null> => {
    const space = espacio ?? ctx.defaultSpaceId;
    if (!space) return null;
    return (await deps.spaces.isMember(space, ctx.userId)) ? space : null;
  };

  const authorizedNote = async (id: string) => {
    const note = await deps.notes.get(id);
    return note && (await deps.spaces.isMember(note.espacioId, ctx.userId)) ? note : null;
  };

  server.tool(
    'buscar_memoria',
    'Busca en la memoria por significado y palabra clave; devuelve las notas más relevantes.',
    { query: z.string(), espacio: z.string().optional(), topK: z.number().optional() },
    async ({ query, espacio, topK }) => {
      const space = await spaceFor(espacio);
      if (!space) return { content: [{ type: 'text', text: 'Sin espacio o sin acceso.' }] };
      const results = await deps.search.search(space, query, topK ?? 5);
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
      const space = await spaceFor(espacio);
      if (!space) return { content: [{ type: 'text', text: 'Sin espacio o sin acceso.' }] };
      const notes = await deps.notes.list(space);
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
      const ok = note && (await deps.spaces.isMember(note.espacioId, ctx.userId));
      return { content: [{ type: 'text', text: ok ? note!.contenidoMd : 'No existe.' }] };
    },
  );

  server.tool(
    'escribir_nota',
    'Crea o actualiza una nota por título (guarda un recuerdo en la memoria).',
    { titulo: z.string(), contenido: z.string(), espacio: z.string().optional() },
    async ({ titulo, contenido, espacio }) => {
      const space = await spaceFor(espacio);
      if (!space) return { content: [{ type: 'text', text: 'Sin espacio o sin acceso.' }] };
      const note = await deps.notes.openOrCreate(space, titulo);
      const updated = await deps.notes.update(note.id, { contenidoMd: contenido });
      return { content: [{ type: 'text', text: `Guardada "${titulo}" (id: ${updated?.id}).` }] };
    },
  );

  server.tool('listar_espacios', 'Lista los espacios de trabajo del usuario.', {}, async () => {
    const spaces = await deps.spaces.listForUser(ctx.userId);
    const text = spaces.map((s) => `- ${s.nombre} (id: ${s.id})`).join('\n') || 'No hay espacios.';
    return { content: [{ type: 'text', text }] };
  });

  server.tool(
    'listar_tags',
    'Lista los tags del espacio con su cantidad de notas.',
    { espacio: z.string().optional() },
    async ({ espacio }) => {
      const space = await spaceFor(espacio);
      if (!space) return { content: [{ type: 'text', text: 'Sin espacio o sin acceso.' }] };
      const tags = await deps.tags.listForSpace(space);
      const text = tags.map((t) => `#${t.tag} (${t.count})`).join('\n') || 'No hay tags.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'buscar_por_tag',
    'Devuelve las notas que tienen un tag dado.',
    { tag: z.string(), espacio: z.string().optional() },
    async ({ tag, espacio }) => {
      const space = await spaceFor(espacio);
      if (!space) return { content: [{ type: 'text', text: 'Sin espacio o sin acceso.' }] };
      const ids = new Set(await deps.tags.noteIdsByTag(space, tag));
      const notes = (await deps.notes.list(space)).filter((n) => ids.has(n.id));
      const text = notes.map((n) => `- ${n.titulo} (id: ${n.id})`).join('\n') || 'Sin notas con ese tag.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'notas_recientes',
    'Lista las notas modificadas más recientemente.',
    { espacio: z.string().optional(), limite: z.number().optional() },
    async ({ espacio, limite }) => {
      const space = await spaceFor(espacio);
      if (!space) return { content: [{ type: 'text', text: 'Sin espacio o sin acceso.' }] };
      const notes = (await deps.notes.list(space)).slice(0, limite ?? 10);
      const text = notes.map((n) => `- ${n.titulo} (id: ${n.id})`).join('\n') || 'No hay notas.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'backlinks_de',
    'Lista las notas que enlazan a una nota dada (por id).',
    { id: z.string() },
    async ({ id }) => {
      const note = await authorizedNote(id);
      if (!note) return { content: [{ type: 'text', text: 'No existe.' }] };
      const ids = new Set(await deps.links.backlinkIds(note.espacioId, note.titulo));
      const notes = (await deps.notes.list(note.espacioId)).filter((n) => ids.has(n.id));
      const text = notes.map((n) => `- ${n.titulo} (id: ${n.id})`).join('\n') || 'Sin backlinks.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'agregar_a_nota',
    'Agrega contenido al final de una nota (para que la IA "anote" recuerdos).',
    { id: z.string(), contenido: z.string() },
    async ({ id, contenido }) => {
      const note = await authorizedNote(id);
      if (!note) return { content: [{ type: 'text', text: 'No existe.' }] };
      const nuevo = note.contenidoMd ? `${note.contenidoMd}\n${contenido}` : contenido;
      await deps.notes.update(note.id, { contenidoMd: nuevo });
      return { content: [{ type: 'text', text: `Agregado a "${note.titulo}".` }] };
    },
  );

  return server;
}

/** Monta el endpoint MCP Streamable HTTP en /mcp (stateful por sesión, identidad vía AuthProvider). */
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
          const identity = await deps.auth.resolve(req.headers);
          if (!identity) {
            reply.code(401).send({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'No autenticado' },
              id: null,
            });
            return;
          }
          const spaces = await deps.spaces.listForUser(identity.userId);
          const ctx: McpContext = { userId: identity.userId, defaultSpaceId: spaces[0]?.id ?? null };

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
          await createMcpServer(deps, ctx).connect(transport);
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
