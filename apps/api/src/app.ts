import Fastify, { type FastifyInstance } from 'fastify';
import type { NotesService, SearchService } from '@diluxite/core';
import type { DrizzleSpacesRepository } from '@diluxite/db';

export interface AppDeps {
  notes: NotesService;
  search: SearchService;
  spaces: DrizzleSpacesRepository;
  userId: string;
  defaultSpaceId: string;
}

/** Construye la app Fastify con las rutas REST (PRD §13). Sin listen: testeable con inject. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok', service: 'diluxite-core' }));

  // --- Espacios ---
  app.get('/api/spaces', async () => deps.spaces.listForUser(deps.userId));

  app.post('/api/spaces', async (req, reply) => {
    const { nombre } = (req.body ?? {}) as { nombre?: string };
    if (!nombre?.trim()) return reply.code(400).send({ error: 'nombre requerido' });
    return reply.code(201).send(await deps.spaces.create(nombre, deps.userId));
  });

  // --- Notas ---
  app.get('/api/spaces/:spaceId/notes', async (req) => {
    const { spaceId } = req.params as { spaceId: string };
    return deps.notes.list(spaceId);
  });

  app.post('/api/spaces/:spaceId/notes', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    const { titulo, contenidoMd } = (req.body ?? {}) as { titulo?: string; contenidoMd?: string };
    if (!titulo?.trim()) return reply.code(400).send({ error: 'titulo requerido' });
    return reply.code(201).send(await deps.notes.create({ espacioId: spaceId, titulo, contenidoMd }));
  });

  app.get('/api/notes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const note = await deps.notes.get(id);
    return note ?? reply.code(404).send({ error: 'no existe' });
  });

  app.put('/api/notes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = (req.body ?? {}) as { titulo?: string; contenidoMd?: string };
    const note = await deps.notes.update(id, patch);
    return note ?? reply.code(404).send({ error: 'no existe' });
  });

  app.delete('/api/notes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deps.notes.delete(id);
    return ok ? { ok: true } : reply.code(404).send({ error: 'no existe' });
  });

  // --- Búsqueda (memoria semántica) ---
  app.post('/api/search', async (req) => {
    const { query, spaceId, topK } = (req.body ?? {}) as {
      query?: string;
      spaceId?: string;
      topK?: number;
    };
    return deps.search.search(spaceId ?? deps.defaultSpaceId, query ?? '', topK ?? 5);
  });

  return app;
}
