import {
  createDb,
  DrizzleNotesRepository,
  DrizzleSearchRepository,
  DrizzleFoldersRepository,
  DrizzleLinksRepository,
  DrizzleOrganizationsRepository,
  DrizzleSessionsRepository,
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
  SessionAuthProvider,
  SingleUserAuthProvider,
  hashPassword,
  type AuthProvider,
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
 * Auth mode is decided at install time and baked into the compose env.
 *   - `local` (default): passwordless single-user — `SingleUserAuthProvider`
 *     wraps the bootstrapped `local@diluxite` user. The web ships with no
 *     login screen; you're always "in".
 *   - `server`: multi-user with email+password sessions + Bearer tokens
 *     (`SessionAuthProvider`). The first admin's email + password come from
 *     DILUXITE_ADMIN_EMAIL + DILUXITE_ADMIN_PASSWORD env vars, set by the
 *     installer; they're applied once on first boot.
 */
export type AuthMode = 'local' | 'server';

function pickAuthMode(): AuthMode {
  const raw = (process.env.DILUXITE_AUTH_MODE ?? 'local').trim().toLowerCase();
  return raw === 'server' ? 'server' : 'local';
}

async function bootstrapServerAdmin(
  users: DrizzleUsersRepository,
  organizations: DrizzleOrganizationsRepository,
): Promise<void> {
  // Idempotent: only seeds the admin user if it's missing. Password hash is
  // re-applied on every boot only if the current hash is null (lets the
  // operator rotate the env var by clearing the column).
  const email = (process.env.DILUXITE_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.DILUXITE_ADMIN_PASSWORD ?? '';
  if (!email || !password) return;
  const existing = await users.findWithPasswordByEmail(email);
  if (existing && existing.passwordHash) return;
  const user = existing
    ? { id: existing.id, email: existing.email }
    : await users.create(email, 'local');
  await users.setPassword(user.id, hashPassword(password));
  // Ensure the admin has an org to land in.
  await organizations.ensureForUser(user.id, email.split('@')[0] ?? 'Org');
}

/**
 * Dependencies for the Core edition. Two flavours, picked by env:
 *   - local  → SingleUserAuthProvider + bootstrap of `local@diluxite`
 *   - server → SessionAuthProvider (cookie session + Bearer fallback) +
 *              bootstrap of the admin user from env vars
 */
export async function buildCoreDeps(databaseUrl: string): Promise<{
  sql: ReturnType<typeof createDb>['sql'];
  deps: AppDeps;
  userId: string;
  defaultSpaceId: string;
  defaultOrgId: string;
  authMode: AuthMode;
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
  const sessions = new DrizzleSessionsRepository(db);
  const tags = new DrizzleTagsRepository(db);
  const links = new DrizzleLinksRepository(db);
  const folders = new DrizzleFoldersRepository(db);

  const authMode = pickAuthMode();
  let auth: AuthProvider;
  if (authMode === 'server') {
    await bootstrapServerAdmin(users, organizations);
    auth = new SessionAuthProvider(sessions, tokens);
  } else {
    auth = new SingleUserAuthProvider(userId);
  }

  const info = {
    embedder: embedderName,
    version: '4.1.0-alpha.0',
    authMode,
  };

  return {
    sql,
    deps: {
      notes,
      search,
      spaces,
      organizations,
      users,
      tokens,
      sessions,
      tags,
      links,
      folders,
      auth,
      info,
    },
    userId,
    defaultSpaceId: spaceId,
    defaultOrgId: orgId,
    authMode,
  };
}
