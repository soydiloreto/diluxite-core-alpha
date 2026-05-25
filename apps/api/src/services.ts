import {
  createDb,
  DrizzleNotesRepository,
  DrizzleSearchRepository,
  DrizzleLinksRepository,
  DrizzleSpacesRepository,
  DrizzleTagsRepository,
  DrizzleTokensRepository,
  DrizzleUsersRepository,
  ensureSingleUserBootstrap,
} from '@diluxite/db';
import {
  AzureOpenAIEmbeddingProvider,
  DeterministicEmbeddingProvider,
  NotesService,
  SearchService,
  SingleUserAuthProvider,
  type EmbeddingProvider,
} from '@diluxite/core';
import type { AppDeps } from './app';

/** Elige el proveedor de embeddings: Azure si hay credenciales, si no determinista local. */
function pickEmbedder(): { embedder: EmbeddingProvider; name: string } {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);
  if (endpoint && apiKey && deployment) {
    return {
      embedder: new AzureOpenAIEmbeddingProvider({ endpoint, apiKey, deployment, dimensions }),
      name: 'azure',
    };
  }
  return { embedder: new DeterministicEmbeddingProvider(dimensions), name: 'local' };
}

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
  const { embedder, name: embedderName } = pickEmbedder();
  const search = new SearchService(searchRepo, embedder, notesRepo);
  const notes = new NotesService(notesRepo, search);
  const spaces = new DrizzleSpacesRepository(db);
  const users = new DrizzleUsersRepository(db);
  const tokens = new DrizzleTokensRepository(db);
  const tags = new DrizzleTagsRepository(db);
  const links = new DrizzleLinksRepository(db);
  const auth = new SingleUserAuthProvider(userId);
  const info = { embedder: embedderName, version: '0.1.0' };

  return {
    sql,
    deps: { notes, search, spaces, users, tokens, tags, links, auth, info },
    userId,
    defaultSpaceId: espacioId,
  };
}
