import {
  createDb,
  DrizzleNotesRepository,
  DrizzleSearchRepository,
  DrizzleFoldersRepository,
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

/** Picks the embeddings provider: Azure if credentials are present, deterministic local otherwise. */
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
 * Dependencies for the Core edition (single-user, no login): deterministic
 * local embeddings + a single bootstrapped user. The Cloud edition swaps
 * the EmbeddingProvider/Reranker and the AuthProvider (Entra).
 */
export async function buildCoreDeps(databaseUrl: string): Promise<{
  sql: ReturnType<typeof createDb>['sql'];
  deps: AppDeps;
  userId: string;
  defaultSpaceId: string;
}> {
  const { sql, db } = createDb(databaseUrl);
  const { userId, spaceId } = await ensureSingleUserBootstrap(db);

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
  const folders = new DrizzleFoldersRepository(db);
  const auth = new SingleUserAuthProvider(userId);
  const info = { embedder: embedderName, version: '4.0.0-alpha.0' };

  return {
    sql,
    deps: { notes, search, spaces, users, tokens, tags, links, folders, auth, info },
    userId,
    defaultSpaceId: spaceId,
  };
}
