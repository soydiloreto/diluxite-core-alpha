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

/** MCP server with the super-memory tools, scoped to a single user (PRD §13). */
export function createMcpServer(deps: AppDeps, ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'diluxite', version: '4.0.0-alpha.0' });

  // Resolves and authorises the space (default = the user's first space).
  const spaceFor = async (space?: string): Promise<string | null> => {
    const target = space ?? ctx.defaultSpaceId;
    if (!target) return null;
    return (await deps.spaces.isMember(target, ctx.userId)) ? target : null;
  };

  const authorizedNote = async (id: string) => {
    const note = await deps.notes.get(id);
    return note && (await deps.spaces.isMember(note.spaceId, ctx.userId)) ? note : null;
  };

  server.tool(
    'search_memory',
    'Searches memory by meaning and keywords; returns the most relevant notes.',
    { query: z.string(), space: z.string().optional(), topK: z.number().optional() },
    async ({ query, space, topK }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      const results = await deps.search.search(target, query, topK ?? 5);
      const text = results.length
        ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join('\n')
        : 'No results.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'list_notes',
    'Lists every note in a space.',
    { space: z.string().optional() },
    async ({ space }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      const notes = await deps.notes.list(target);
      const text = notes.length
        ? notes.map((n) => `- ${n.title} (id: ${n.id})`).join('\n')
        : 'No notes.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'read_note',
    'Reads the full content of a note by id.',
    { id: z.string() },
    async ({ id }) => {
      const note = await deps.notes.get(id);
      const ok = note && (await deps.spaces.isMember(note.spaceId, ctx.userId));
      return { content: [{ type: 'text', text: ok ? note!.contentMd : 'Not found.' }] };
    },
  );

  server.tool(
    'write_note',
    'Creates or updates a note by title (stores a memory).',
    { title: z.string(), content: z.string(), space: z.string().optional() },
    async ({ title, content, space }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      const note = await deps.notes.openOrCreate(target, title);
      const updated = await deps.notes.update(note.id, { contentMd: content });
      return { content: [{ type: 'text', text: `Saved "${title}" (id: ${updated?.id}).` }] };
    },
  );

  server.tool('list_spaces', "Lists the user's workspaces (spaces).", {}, async () => {
    const spaces = await deps.spaces.listForUser(ctx.userId);
    const text = spaces.map((s) => `- ${s.name} (id: ${s.id})`).join('\n') || 'No spaces.';
    return { content: [{ type: 'text', text }] };
  });

  server.tool(
    'list_tags',
    'Lists the tags in a space with their note count.',
    { space: z.string().optional() },
    async ({ space }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      const tags = await deps.tags.listForSpace(target);
      const text = tags.map((t) => `#${t.tag} (${t.count})`).join('\n') || 'No tags.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'search_by_tag',
    'Returns the notes that carry a given tag.',
    { tag: z.string(), space: z.string().optional() },
    async ({ tag, space }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      const ids = new Set(await deps.tags.noteIdsByTag(target, tag));
      const notes = (await deps.notes.list(target)).filter((n) => ids.has(n.id));
      const text = notes.map((n) => `- ${n.title} (id: ${n.id})`).join('\n') || 'No notes with that tag.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'recent_notes',
    'Lists the most recently updated notes.',
    { space: z.string().optional(), limit: z.number().optional() },
    async ({ space, limit }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      const notes = (await deps.notes.list(target)).slice(0, limit ?? 10);
      const text = notes.map((n) => `- ${n.title} (id: ${n.id})`).join('\n') || 'No notes.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'backlinks_of',
    'Lists the notes that link to a given note (by id).',
    { id: z.string() },
    async ({ id }) => {
      const note = await authorizedNote(id);
      if (!note) return { content: [{ type: 'text', text: 'Not found.' }] };
      const ids = new Set(await deps.links.backlinkIds(note.spaceId, note.title));
      const notes = (await deps.notes.list(note.spaceId)).filter((n) => ids.has(n.id));
      const text = notes.map((n) => `- ${n.title} (id: ${n.id})`).join('\n') || 'No backlinks.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'append_to_note',
    'Appends content to the end of a note (so the AI can "jot" memories).',
    { id: z.string(), content: z.string() },
    async ({ id, content }) => {
      const note = await authorizedNote(id);
      if (!note) return { content: [{ type: 'text', text: 'Not found.' }] };
      const next = note.contentMd ? `${note.contentMd}\n${content}` : content;
      await deps.notes.update(note.id, { contentMd: next });
      return { content: [{ type: 'text', text: `Appended to "${note.title}".` }] };
    },
  );

  return server;
}

/** Mounts the MCP Streamable HTTP endpoint at /mcp (stateful per session, identity via AuthProvider). */
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
              error: { code: -32001, message: 'Unauthenticated' },
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
            error: { code: -32000, message: 'Invalid MCP session or missing initialize' },
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
