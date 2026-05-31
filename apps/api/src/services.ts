import {
  createDb,
  DrizzleNotesRepository,
  DrizzleSearchRepository,
  DrizzleFoldersRepository,
  DrizzleLinksRepository,
  DrizzleOrganizationsRepository,
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
  OllamaEmbeddingProvider,
  SearchService,
  SingleUserAuthProvider,
  type EmbeddingProvider,
} from '@diluxite/core';
import type { AppDeps } from './app';

/** Picks the embeddings provider: Azure > Ollama (local) > deterministic. */
function pickEmbedder(): { embedder: EmbeddingProvider; name: string } {
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureKey = process.env.AZURE_OPENAI_API_KEY;
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);
  if (azureEndpoint && azureKey && azureDeployment) {
    return {
      embedder: new AzureOpenAIEmbeddingProvider({
        endpoint: azureEndpoint,
        apiKey: azureKey,
        deployment: azureDeployment,
        dimensions,
      }),
      name: 'azure',
    };
  }
  const ollamaModel = process.env.OLLAMA_EMBEDDING_MODEL;
  const ollamaDims = Number(process.env.OLLAMA_EMBEDDING_DIMENSIONS ?? 0);
  if (ollamaModel && ollamaDims > 0) {
    return {
      embedder: new OllamaEmbeddingProvider({
        model: ollamaModel,
        dimensions: ollamaDims,
        endpoint: process.env.OLLAMA_ENDPOINT,
      }),
      name: 'ollama',
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
  defaultOrgId: string;
}> {
  const { sql, db } = createDb(databaseUrl);
  const { userId, orgId, spaceId } = await ensureSingleUserBootstrap(db);

  const notesRepo = new DrizzleNotesRepository(db);
  const searchRepo = new DrizzleSearchRepository(db);
  const { embedder, name: embedderName } = pickEmbedder();
  const search = new SearchService(searchRepo, embedder, notesRepo);
  const notes = new NotesService(notesRepo, search);
  const spaces = new DrizzleSpacesRepository(db);
  const organizations = new DrizzleOrganizationsRepository(db);
  const users = new DrizzleUsersRepository(db);
  const tokens = new DrizzleTokensRepository(db);
  const tags = new DrizzleTagsRepository(db);
  const links = new DrizzleLinksRepository(db);
  const folders = new DrizzleFoldersRepository(db);
  const auth = new SingleUserAuthProvider(userId);
  const info = { embedder: embedderName, version: '4.1.0-alpha.0' };

  return {
    sql,
    deps: {
      notes,
      search,
      spaces,
      organizations,
      users,
      tokens,
      tags,
      links,
      folders,
      auth,
      info,
    },
    userId,
    defaultSpaceId: spaceId,
    defaultOrgId: orgId,
  };
}
