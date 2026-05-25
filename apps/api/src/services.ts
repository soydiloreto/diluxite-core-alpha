import {
  createDb,
  DrizzleNotesRepository,
  DrizzleSearchRepository,
  DrizzleSpacesRepository,
  DrizzleTokensRepository,
  DrizzleUsersRepository,
  ensureSingleUserBootstrap,
} from '@diluxite/db';
import {
  DeterministicEmbeddingProvider,
  NotesService,
  SearchService,
  SingleUserAuthProvider,
} from '@diluxite/core';
import type { AppDeps } from './app';

/**
 * Dependencias de la edición Core (single-user, sin login): embeddings
 * deterministas locales y un único usuario bootstrappeado. La edición Cloud
 * reemplaza el EmbeddingProvider/Reranker y el AuthProvider (Entra).
 */
export async function buildCoreDeps(databaseUrl: string): Promise<{
  sql: ReturnType<typeof createDb>['sql'];
  deps: AppDeps;
  userId: string;
  defaultSpaceId: string;
}> {
  const { sql, db } = createDb(databaseUrl);
  const { userId, espacioId } = await ensureSingleUserBootstrap(db);

  const notesRepo = new DrizzleNotesRepository(db);
  const searchRepo = new DrizzleSearchRepository(db);
  const search = new SearchService(searchRepo, new DeterministicEmbeddingProvider(1536), notesRepo);
  const notes = new NotesService(notesRepo, search);
  const spaces = new DrizzleSpacesRepository(db);
  const users = new DrizzleUsersRepository(db);
  const tokens = new DrizzleTokensRepository(db);
  const auth = new SingleUserAuthProvider(userId);

  return {
    sql,
    deps: { notes, search, spaces, users, tokens, auth },
    userId,
    defaultSpaceId: espacioId,
  };
}
