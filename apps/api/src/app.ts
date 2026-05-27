import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AuthProvider, Identity, NotesService, SearchService } from '@diluxite/core';
import type {
  DrizzleFoldersRepository,
  DrizzleLinksRepository,
  DrizzleSpacesRepository,
  DrizzleTagsRepository,
  DrizzleTokensRepository,
  DrizzleUsersRepository,
} from '@diluxite/db';
import { registerMcp } from './mcp';

declare module 'fastify' {
  interface FastifyRequest {
    identity?: Identity;
  }
}

export interface AppDeps {
  notes: NotesService;
  search: SearchService;
  spaces: DrizzleSpacesRepository;
  users: DrizzleUsersRepository;
  tokens: DrizzleTokensRepository;
  tags: DrizzleTagsRepository;
  links: DrizzleLinksRepository;
  folders: DrizzleFoldersRepository;
  auth: AuthProvider;
  info?: { embedder: string; version: string };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok', service: 'diluxite-core' }));

  // Per-request identity (RS-1: always from the validated token, never a free header).
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api')) return; // /health and /mcp handle their own
    const id = await deps.auth.resolve(req.headers);
    if (!id) {
      reply.code(401).send({ error: 'unauthenticated' });
      return reply;
    }
    req.identity = id;
  });

  const uid = (req: FastifyRequest) => req.identity!.userId;

  // RS-2: per-space authorisation on every operation.
  async function requireMember(
    req: FastifyRequest,
    reply: FastifyReply,
    spaceId: string,
  ): Promise<boolean> {
    if (await deps.spaces.isMember(spaceId, uid(req))) return true;
    reply.code(403).send({ error: 'no access to this space' });
    return false;
  }

  // Load the note only if the user belongs to its space (404 if not, to avoid leaking existence).
  async function loadAuthorizedNote(req: FastifyRequest) {
    const { id } = req.params as { id: string };
    const note = await deps.notes.get(id);
    if (!note) return null;
    if (!(await deps.spaces.isMember(note.spaceId, uid(req)))) return null;
    return note;
  }

  // --- Spaces ---
  app.get('/api/spaces', async (req) => deps.spaces.listForUser(uid(req)));

  app.post('/api/spaces', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
    return reply.code(201).send(await deps.spaces.create(name, uid(req)));
  });

  // Invite member (owner only). Shares the WHOLE space (PRD §7.2).
  app.post('/api/spaces/:spaceId/members', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if ((await deps.spaces.role(spaceId, uid(req))) !== 'owner')
      return reply.code(403).send({ error: 'only the owner can invite' });
    const { email } = (req.body ?? {}) as { email?: string };
    if (!email?.trim()) return reply.code(400).send({ error: 'email required' });
    const invitee = await deps.users.findByEmail(email.trim());
    if (!invitee) return reply.code(404).send({ error: 'user not found' });
    await deps.spaces.addMember(spaceId, invitee.id);
    return { ok: true };
  });

  // --- Notes ---
  app.get('/api/spaces/:spaceId/notes', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const { tag, folder } = req.query as { tag?: string; folder?: string };
    let notes = await deps.notes.list(spaceId);
    if (tag) {
      const ids = new Set(await deps.tags.noteIdsByTag(spaceId, tag));
      notes = notes.filter((n) => ids.has(n.id));
    }
    if (folder !== undefined) {
      const target = folder === 'root' ? null : folder;
      notes = notes.filter((n) => n.folderId === target);
    }
    return notes;
  });

  // Space tags (with usage count)
  app.get('/api/spaces/:spaceId/tags', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    return deps.tags.listForSpace(spaceId);
  });

  // Space graph (nodes + edges)
  app.get('/api/spaces/:spaceId/graph', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    return deps.links.graph(spaceId);
  });

  app.post('/api/spaces/:spaceId/notes', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const { title, contentMd, folderId } = (req.body ?? {}) as {
      title?: string;
      contentMd?: string;
      folderId?: string | null;
    };
    if (!title?.trim()) return reply.code(400).send({ error: 'title required' });
    return reply
      .code(201)
      .send(await deps.notes.create({ spaceId, title, contentMd, folderId }));
  });

  app.get('/api/notes/:id', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    return note ?? reply.code(404).send({ error: 'not found' });
  });

  app.put('/api/notes/:id', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'not found' });
    return deps.notes.update(note.id, (req.body ?? {}) as { title?: string; contentMd?: string });
  });

  app.delete('/api/notes/:id', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'not found' });
    await deps.notes.delete(note.id);
    return { ok: true };
  });

  // Backlinks: notes that link to this one
  app.get('/api/notes/:id/backlinks', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'not found' });
    const ids = new Set(await deps.links.backlinkIds(note.spaceId, note.title));
    const all = await deps.notes.list(note.spaceId);
    return all.filter((n) => ids.has(n.id)).map((n) => ({ id: n.id, title: n.title }));
  });

  // Append: add content at the end (so the AI can "jot" into a note)
  app.post('/api/notes/:id/append', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'not found' });
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content?.trim()) return reply.code(400).send({ error: 'content required' });
    const next = note.contentMd ? `${note.contentMd}\n${content}` : content;
    return deps.notes.update(note.id, { contentMd: next });
  });

  // --- Search ---
  app.post('/api/search', async (req, reply) => {
    const { query, spaceId, topK } = (req.body ?? {}) as {
      query?: string;
      spaceId?: string;
      topK?: number;
    };
    let space = spaceId;
    if (!space) space = (await deps.spaces.listForUser(uid(req)))[0]?.id;
    if (!space) return [];
    if (!(await requireMember(req, reply, space))) return reply;
    const mode = (req.body as { mode?: 'hybrid' | 'keyword' | 'semantic' })?.mode ?? 'hybrid';
    return deps.search.search(space, query ?? '', topK ?? 5, mode);
  });

  // Instance info (embeddings provider + version + authenticated user)
  app.get('/api/info', async (req) => {
    const base = deps.info ?? { embedder: 'local', version: '0.1.0' };
    const user = await deps.users.findById(uid(req));
    return { ...base, user: user ? { email: user.email } : null };
  });

  // Space stats (for the home + settings)
  app.get('/api/spaces/:spaceId/stats', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const [g, tags] = await Promise.all([
      deps.links.graph(spaceId),
      deps.tags.listForSpace(spaceId),
    ]);
    return { notes: g.nodes.length, links: g.edges.length, tags: tags.length };
  });

  // --- Folders (hierarchical tree per space) ---
  async function authorizeFolder(
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
  ): Promise<string | null> {
    const space = await deps.folders.spaceOf(id);
    if (!space || !(await deps.spaces.isMember(space, uid(req)))) {
      reply.code(404).send({ error: 'not found' });
      return null;
    }
    return space;
  }

  app.get('/api/spaces/:spaceId/folders', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    return deps.folders.list(spaceId);
  });

  app.post('/api/spaces/:spaceId/folders', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const { name, parentId } = (req.body ?? {}) as { name?: string; parentId?: string | null };
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
    return reply.code(201).send(await deps.folders.create(spaceId, name.trim(), parentId ?? null));
  });

  app.put('/api/folders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await authorizeFolder(req, reply, id))) return reply;
    const { name, parentId } = (req.body ?? {}) as { name?: string; parentId?: string | null };
    let result = null;
    if (name !== undefined) result = await deps.folders.rename(id, name);
    if (parentId !== undefined) result = await deps.folders.move(id, parentId);
    return result ?? reply.code(400).send({ error: 'name or parentId required' });
  });

  app.delete('/api/folders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await authorizeFolder(req, reply, id))) return reply;
    await deps.folders.delete(id);
    return { ok: true };
  });

  // --- Favourite toggle ---
  app.put('/api/notes/:id/favorite', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'not found' });
    const { favorite } = (req.body ?? {}) as { favorite?: boolean };
    if (typeof favorite !== 'boolean')
      return reply.code(400).send({ error: 'favorite boolean required' });
    return deps.notes.setFavorite(note.id, favorite);
  });

  // --- Bulk delete (per-note authorisation) ---
  app.post('/api/notes/delete-many', async (req, reply) => {
    const { ids } = (req.body ?? {}) as { ids?: string[] };
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids required' });
    const authorized: string[] = [];
    for (const id of ids) {
      const note = await deps.notes.get(id);
      if (note && (await deps.spaces.isMember(note.spaceId, uid(req)))) authorized.push(id);
    }
    const deleted = await deps.notes.deleteManyIds(authorized);
    return { deleted };
  });

  // --- Access tokens (to connect Claude/Copilot via MCP) ---
  app.post('/api/tokens', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    const { token, info } = await deps.tokens.create(uid(req), name?.trim() || 'token');
    return reply.code(201).send({ token, ...info }); // cleartext token is shown ONLY once
  });

  app.get('/api/tokens', async (req) => deps.tokens.list(uid(req)));

  app.delete('/api/tokens/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deps.tokens.revoke(uid(req), id);
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  registerMcp(app, deps);
  return app;
}
