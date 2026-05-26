import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AuthProvider, Identity, NotesService, SearchService } from '@diluxite/core';
import type {
  DrizzleCarpetasRepository,
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
  carpetas: DrizzleCarpetasRepository;
  auth: AuthProvider;
  info?: { embedder: string; version: string };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok', service: 'diluxite-core' }));

  // Identidad por request (RS-1: siempre del token validado, nunca de un header libre).
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api')) return; // /health y /mcp manejan lo suyo
    const id = await deps.auth.resolve(req.headers);
    if (!id) {
      reply.code(401).send({ error: 'no autenticado' });
      return reply;
    }
    req.identity = id;
  });

  const uid = (req: FastifyRequest) => req.identity!.userId;

  // RS-2: autorización por espacio en cada operación.
  async function requireMember(
    req: FastifyRequest,
    reply: FastifyReply,
    spaceId: string,
  ): Promise<boolean> {
    if (await deps.spaces.isMember(spaceId, uid(req))) return true;
    reply.code(403).send({ error: 'sin acceso a este espacio' });
    return false;
  }

  // Carga la nota solo si el usuario es miembro de su espacio (404 si no, para no filtrar existencia).
  async function loadAuthorizedNote(req: FastifyRequest) {
    const { id } = req.params as { id: string };
    const note = await deps.notes.get(id);
    if (!note) return null;
    if (!(await deps.spaces.isMember(note.espacioId, uid(req)))) return null;
    return note;
  }

  // --- Espacios ---
  app.get('/api/spaces', async (req) => deps.spaces.listForUser(uid(req)));

  app.post('/api/spaces', async (req, reply) => {
    const { nombre } = (req.body ?? {}) as { nombre?: string };
    if (!nombre?.trim()) return reply.code(400).send({ error: 'nombre requerido' });
    return reply.code(201).send(await deps.spaces.create(nombre, uid(req)));
  });

  // Invitar miembro (solo el owner). Comparte TODO el espacio (PRD §7.2).
  app.post('/api/spaces/:spaceId/members', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if ((await deps.spaces.role(spaceId, uid(req))) !== 'owner')
      return reply.code(403).send({ error: 'solo el owner puede invitar' });
    const { email } = (req.body ?? {}) as { email?: string };
    if (!email?.trim()) return reply.code(400).send({ error: 'email requerido' });
    const invitee = await deps.users.findByEmail(email.trim());
    if (!invitee) return reply.code(404).send({ error: 'usuario no encontrado' });
    await deps.spaces.addMember(spaceId, invitee.id);
    return { ok: true };
  });

  // --- Notas ---
  app.get('/api/spaces/:spaceId/notes', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const { tag, carpeta } = req.query as { tag?: string; carpeta?: string };
    let notes = await deps.notes.list(spaceId);
    if (tag) {
      const ids = new Set(await deps.tags.noteIdsByTag(spaceId, tag));
      notes = notes.filter((n) => ids.has(n.id));
    }
    if (carpeta !== undefined) {
      const target = carpeta === 'root' ? null : carpeta;
      notes = notes.filter((n) => n.carpetaId === target);
    }
    return notes;
  });

  // Tags del espacio (con conteo)
  app.get('/api/spaces/:spaceId/tags', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    return deps.tags.listForSpace(spaceId);
  });

  // Grafo del espacio (nodos + aristas)
  app.get('/api/spaces/:spaceId/graph', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    return deps.links.graph(spaceId);
  });

  app.post('/api/spaces/:spaceId/notes', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const { titulo, contenidoMd, carpetaId } = (req.body ?? {}) as {
      titulo?: string;
      contenidoMd?: string;
      carpetaId?: string | null;
    };
    if (!titulo?.trim()) return reply.code(400).send({ error: 'titulo requerido' });
    return reply
      .code(201)
      .send(await deps.notes.create({ espacioId: spaceId, titulo, contenidoMd, carpetaId }));
  });

  app.get('/api/notes/:id', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    return note ?? reply.code(404).send({ error: 'no existe' });
  });

  app.put('/api/notes/:id', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'no existe' });
    return deps.notes.update(note.id, (req.body ?? {}) as { titulo?: string; contenidoMd?: string });
  });

  app.delete('/api/notes/:id', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'no existe' });
    await deps.notes.delete(note.id);
    return { ok: true };
  });

  // Backlinks: qué notas enlazan a esta
  app.get('/api/notes/:id/backlinks', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'no existe' });
    const ids = new Set(await deps.links.backlinkIds(note.espacioId, note.titulo));
    const all = await deps.notes.list(note.espacioId);
    return all.filter((n) => ids.has(n.id)).map((n) => ({ id: n.id, titulo: n.titulo }));
  });

  // Append: agregar contenido al final (útil para que la IA "anote" en una nota)
  app.post('/api/notes/:id/append', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'no existe' });
    const { contenido } = (req.body ?? {}) as { contenido?: string };
    if (!contenido?.trim()) return reply.code(400).send({ error: 'contenido requerido' });
    const nuevo = note.contenidoMd ? `${note.contenidoMd}\n${contenido}` : contenido;
    return deps.notes.update(note.id, { contenidoMd: nuevo });
  });

  // --- Búsqueda ---
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

  // Info de la instancia (proveedor de embeddings + versión + usuario autenticado)
  app.get('/api/info', async (req) => {
    const base = deps.info ?? { embedder: 'local', version: '0.1.0' };
    const user = await deps.users.findById(uid(req));
    return { ...base, user: user ? { email: user.email } : null };
  });

  // Estadísticas del espacio (para la home y ajustes)
  app.get('/api/spaces/:spaceId/stats', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const [g, tags] = await Promise.all([
      deps.links.graph(spaceId),
      deps.tags.listForSpace(spaceId),
    ]);
    return { notas: g.nodes.length, links: g.edges.length, tags: tags.length };
  });

  // --- v2: Carpetas (árbol jerárquico por espacio) ---
  async function authorizeCarpeta(
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
  ): Promise<string | null> {
    const espacio = await deps.carpetas.espacioDe(id);
    if (!espacio || !(await deps.spaces.isMember(espacio, uid(req)))) {
      reply.code(404).send({ error: 'no existe' });
      return null;
    }
    return espacio;
  }

  app.get('/api/spaces/:spaceId/carpetas', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    return deps.carpetas.list(spaceId);
  });

  app.post('/api/spaces/:spaceId/carpetas', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const { nombre, padreId } = (req.body ?? {}) as { nombre?: string; padreId?: string | null };
    if (!nombre?.trim()) return reply.code(400).send({ error: 'nombre requerido' });
    return reply.code(201).send(await deps.carpetas.create(spaceId, nombre.trim(), padreId ?? null));
  });

  app.put('/api/carpetas/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await authorizeCarpeta(req, reply, id))) return reply;
    const { nombre, padreId } = (req.body ?? {}) as { nombre?: string; padreId?: string | null };
    let result = null;
    if (nombre !== undefined) result = await deps.carpetas.rename(id, nombre);
    if (padreId !== undefined) result = await deps.carpetas.mover(id, padreId);
    return result ?? reply.code(400).send({ error: 'nombre o padreId requerido' });
  });

  app.delete('/api/carpetas/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await authorizeCarpeta(req, reply, id))) return reply;
    await deps.carpetas.delete(id);
    return { ok: true };
  });

  // --- v2: Favorita toggle ---
  app.put('/api/notes/:id/favorita', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'no existe' });
    const { favorita } = (req.body ?? {}) as { favorita?: boolean };
    if (typeof favorita !== 'boolean')
      return reply.code(400).send({ error: 'favorita boolean requerido' });
    return deps.notes.setFavorita(note.id, favorita);
  });

  // --- v2: Borrado masivo (autoriza nota por nota) ---
  app.post('/api/notes/delete-many', async (req, reply) => {
    const { ids } = (req.body ?? {}) as { ids?: string[] };
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids requerido' });
    const authorized: string[] = [];
    for (const id of ids) {
      const note = await deps.notes.get(id);
      if (note && (await deps.spaces.isMember(note.espacioId, uid(req)))) authorized.push(id);
    }
    const deleted = await deps.notes.deleteManyIds(authorized);
    return { deleted };
  });

  // --- Tokens de acceso (para conectar Claude/Copilot por MCP) ---
  app.post('/api/tokens', async (req, reply) => {
    const { nombre } = (req.body ?? {}) as { nombre?: string };
    const { token, info } = await deps.tokens.create(uid(req), nombre?.trim() || 'token');
    return reply.code(201).send({ token, ...info }); // el token en claro se ve UNA sola vez
  });

  app.get('/api/tokens', async (req) => deps.tokens.list(uid(req)));

  app.delete('/api/tokens/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deps.tokens.revoke(uid(req), id);
    return ok ? { ok: true } : reply.code(404).send({ error: 'no existe' });
  });

  registerMcp(app, deps);
  return app;
}
