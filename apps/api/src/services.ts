import {
  createDb,
  DrizzleNotesRepository,
  DrizzleSearchRepository,
  DrizzleSpacesRepository,
  ensureSingleUserBootstrap,
} from '@diluxite/db';
import { DeterministicEmbeddingProvider, NotesService, SearchService } from '@diluxite/core';
import type { AppDeps } from './app';

/**
 * Arma todas las dependencias del Core a partir de una conexión.
 * Edición Core: embeddings deterministas locales (sin claves) y single-user.
 * La edición Cloud reemplaza el EmbeddingProvider/Reranker y el bootstrap.
 */
export async function buildCoreDeps(databaseUrl: string): Promise<AppDeps & { sql: ReturnType<typeof createDb>['sql'] }> {
  const { sql, db } = createDb(databaseUrl);
  const { userId, espacioId } = await ensureSingleUserBootstrap(db);

  const notesRepo = new DrizzleNotesRepository(db);
  const searchRepo = new DrizzleSearchRepository(db);
  const search = new SearchService(searchRepo, new DeterministicEmbeddingProvider(1536), notesRepo);
  const notes = new NotesService(notesRepo, search);
  const spaces = new DrizzleSpacesRepository(db);

  return { sql, notes, search, spaces, userId, defaultSpaceId: espacioId };
}
