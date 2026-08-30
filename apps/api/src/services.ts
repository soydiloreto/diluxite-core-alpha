import {
  createDb,
  DrizzleNotesRepository,
  DrizzleEntityProvenanceRepository,
  DrizzleFactsRepository,
  DrizzleOrgSettingsRepository,
  DrizzleNoteVersionsRepository,
  DrizzlePasskeysRepository,
  DrizzleSearchRepository,
  DrizzleEmbeddingModelsRepository,
  DrizzleEmbeddingConfigRepository,
  type EmbeddingConfigRow,
  scopedDb,
  tenantScoped,
  checkScopeUsable,
  DrizzleFoldersRepository,
  DrizzleMoveRepository,
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
  BedrockEmbeddingProvider,
  openSecret,
  secretPassphrase,
  DeterministicEmbeddingProvider,
  NoopEmailProvider,
  NotesService,
  OllamaEmbeddingProvider,
  SearchService,
  SessionAuthProvider,
  SingleUserAuthProvider,
  SmtpEmailProvider,
  hashPassword,
  type AuthProvider,
  type EmailProvider,
  type EmbeddingProvider,
} from '@diluxite/core';
import nodemailer from 'nodemailer';
import type { AppDeps } from './app';
import pkg from '../package.json' with { type: 'json' };

/**
 * Picks the email provider based on env. SMTP if `DILUXITE_SMTP_HOST` is set,
 * otherwise NoopEmailProvider (logs to stdout; the forgot-password reset link
 * shows up in `docker logs diluxite` so devs can copy it during onboarding
 * without setting up a real mail server).
 *
 * Env vars:
 *   DILUXITE_SMTP_HOST       (required to enable SMTP)
 *   DILUXITE_SMTP_PORT       default 587
 *   DILUXITE_SMTP_USER       optional (servers that require AUTH)
 *   DILUXITE_SMTP_PASS       optional
 *   DILUXITE_SMTP_SECURE     '1'|'true' → TLS on connect (port 465 style).
 *                            default false (STARTTLS upgrade on 587).
 *   DILUXITE_SMTP_FROM       default `noreply@diluxite.local`
 */
function pickEmailProvider(): EmailProvider {
  const host = process.env.DILUXITE_SMTP_HOST?.trim();
  if (!host) return new NoopEmailProvider();
  const port = Number(process.env.DILUXITE_SMTP_PORT ?? 587);
  const user = process.env.DILUXITE_SMTP_USER?.trim() || undefined;
  const pass = process.env.DILUXITE_SMTP_PASS || undefined;
  const secure = ['1', 'true', 'yes'].includes(
    (process.env.DILUXITE_SMTP_SECURE ?? '').toLowerCase(),
  );
  const defaultFrom =
    process.env.DILUXITE_SMTP_FROM?.trim() || 'noreply@diluxite.local';
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });
  return new SmtpEmailProvider({ transport, defaultFrom });
}

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
  // Azure partially configured: warn loudly instead of silently falling back
  // to deterministic (non-semantic) embeddings, which is almost never what an
  // operator who set *some* Azure vars intended.
  {
    const azureVars = {
      AZURE_OPENAI_ENDPOINT: azureEndpoint,
      AZURE_OPENAI_API_KEY: azureKey,
      AZURE_OPENAI_DEPLOYMENT: azureDeployment,
    };
    const azureSet = Object.entries(azureVars).filter(([, v]) => !!v);
    if (azureSet.length > 0 && azureSet.length < 3) {
      const missing = Object.entries(azureVars)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(', ');
      console.warn(
        `⚠️  Azure config incompleta: falta ${missing} — usando embeddings ` +
          'deterministas (no semánticos). Setea todas las vars de Azure para ' +
          'habilitar embeddings semánticos.',
      );
    }
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
  // Ollama partially configured (model without a positive dims, or vice-versa).
  if (
    (!!ollamaModel || ollamaDims > 0) &&
    !(ollamaModel && ollamaDims > 0)
  ) {
    const missing = !ollamaModel
      ? 'OLLAMA_EMBEDDING_MODEL'
      : 'OLLAMA_EMBEDDING_DIMENSIONS (>0)';
    console.warn(
      `⚠️  Ollama config incompleta: falta ${missing} — usando embeddings ` +
        'deterministas (no semánticos). Setea modelo + dimensiones para ' +
        'habilitar embeddings semánticos.',
    );
  }
  return { embedder: new DeterministicEmbeddingProvider(dimensions), name: 'local' };
}

/**
 * Build the embedder the STORED configuration asks for, if there is one.
 *
 * The database wins over the environment, so a choice made in the admin
 * console survives a restart and is not silently overridden by whatever the
 * container was started with. An installation that has never used the console
 * behaves exactly as before — `null` here means "fall back to `pickEmbedder`".
 *
 * A stored credential that cannot be opened — a rotated passphrase — is a
 * refusal, not a fallback: quietly reverting to the environment's provider
 * would change the vector space without anyone asking.
 */
export function embedderFromConfig(
  cfg: EmbeddingConfigRow | null,
  passphrase: string | null,
): { embedder: EmbeddingProvider; name: string } | null {
  if (!cfg) return null;
  const apiKey = cfg.apiKeySealed ? openSecret(cfg.apiKeySealed, passphrase) : null;

  switch (cfg.provider) {
    case 'azure':
      if (!cfg.endpoint || !apiKey || !cfg.model) {
        throw new Error('azure embedding config is incomplete (endpoint, model and key required)');
      }
      return {
        embedder: new AzureOpenAIEmbeddingProvider({
          endpoint: cfg.endpoint,
          apiKey,
          deployment: cfg.model,
          dimensions: cfg.dimensions,
        }),
        name: 'azure',
      };
    case 'ollama':
      if (!cfg.model) throw new Error('ollama embedding config needs a model');
      return {
        embedder: new OllamaEmbeddingProvider({
          model: cfg.model,
          dimensions: cfg.dimensions,
          endpoint: cfg.endpoint ?? undefined,
        }),
        name: 'ollama',
      };
    case 'bedrock':
      if (!cfg.model || !apiKey || !cfg.endpoint) {
        throw new Error('bedrock embedding config needs a model, a region and a key');
      }
      return {
        embedder: new BedrockEmbeddingProvider({
          model: cfg.model,
          // The region travels in `endpoint`: Bedrock has no host to choose,
          // only a region that becomes one.
          region: cfg.endpoint,
          apiKey,
          dimensions: cfg.dimensions,
        }),
        name: 'bedrock',
      };
    case 'local':
      return { embedder: new DeterministicEmbeddingProvider(cfg.dimensions), name: 'local' };
  }
}

/**
 * Register the configured embedder as the live model, and carry across the
 * vectors written before ADR-003 existed.
 *
 * A DIFFERENT model than last boot registers as `building` and does NOT take
 * over: search keeps answering from the model that has vectors while the new
 * one is empty. Promoting it is a deliberate act (a reindex, and later the
 * admin UI), because a flip with an empty partition is an outage.
 */
export async function ensureEmbeddingModel(
  models: DrizzleEmbeddingModelsRepository,
  embedder: EmbeddingProvider,
  providerName: string,
  searchRepo: DrizzleSearchRepository,
): Promise<{ key: string; state: string }> {
  const described = embedder.describe?.();
  const registered = await models.ensureRegistered({
    provider: described?.provider ?? providerName,
    model: described?.model ?? null,
    dimensions: embedder.dimensions,
  });

  // Whatever is live must have a partition to write into. Normally that is the
  // model just registered; after a change it is the previous one, still serving
  // while the new is filled. Either way the boot leaves the instance able to
  // index — a live model without a partition is a 500 on the next save.
  const live = await models.active();
  if (live) await models.ensurePartition(live.key, live.dimensions);

  if (registered.state === 'active') {
    // One-time carry-across from the pre-ADR-003 `chunks.embedding` column.
    // Idempotent (ON CONFLICT DO NOTHING), so it costs one no-op statement on
    // every later boot rather than needing a flag to remember it ran.
    const moved = await models.backfillFromChunks(registered.key, registered.dimensions);
    if (moved > 0) {
      console.log(`🧬 ${moved} embeddings migrados a la tabla por modelo (${registered.key})`);
    }
  } else {
    console.warn(
      `⚠️  El embedder configurado (${registered.key}) NO es el modelo activo.\n` +
        '   La búsqueda semántica sigue respondiendo con el modelo anterior.\n' +
        '   Reindexá para llenarlo y activarlo: POST /api/admin/reindex',
    );
  }
  searchRepo.forgetActiveModel();
  return { key: registered.key, state: registered.state };
}

/**
 * Boot guard for embedder dimension drift. If the active embedder produces
 * vectors of a different dimension than the ones already stored in `chunks`,
 * pgvector aborts `vectorSearch` with a hard `different vector dimensions`
 * error (it does NOT silently return garbage). Keyword search keeps working,
 * so we DON'T abort the boot — we just warn loudly. A mass reindex is not yet
 * automated (it's risky); this only surfaces the mismatch.
 *
 * Returns the existing dimension if a mismatch was detected (for tests), or
 * null when there's nothing stored yet or the dims already match.
 */
export async function checkEmbeddingDimension(
  sql: ReturnType<typeof createDb>['sql'],
  activeDimensions: number,
): Promise<number | null> {
  // Only inspect a single indexed row — `vector_dims` is null-safe-guarded by
  // the WHERE so we never hit a non-vector value.
  const rows = await sql<{ dims: number | null }[]>`
    SELECT vector_dims(embedding) AS dims
    FROM chunks
    WHERE embedding IS NOT NULL
    LIMIT 1`;
  const existing = rows[0]?.dims ?? null;
  if (existing == null || existing === activeDimensions) return null;
  console.warn(
    '🚨🚨🚨 EMBEDDING DIMENSION MISMATCH 🚨🚨🚨\n' +
      `   Vectores existentes en 'chunks': ${existing} dims\n` +
      `   Embedder activo: ${activeDimensions} dims\n` +
      '   La búsqueda SEMÁNTICA (vectorSearch) fallará con ' +
      "'different vector dimensions' hasta reindexar.\n" +
      '   La búsqueda por keyword sigue funcionando.\n' +
      '   El reindex masivo automático todavía NO está implementado: ' +
      'reindexá las notas (re-guardar) para regenerar embeddings a la nueva dimensión.',
  );
  return existing;
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
  db: ReturnType<typeof createDb>['db'];
  notesRepo: DrizzleNotesRepository;
  deps: AppDeps;
  userId: string;
  defaultSpaceId: string;
  defaultOrgId: string;
  authMode: AuthMode;
}> {
  const { sql, db: pool } = createDb(databaseUrl);

  // ADR-004. `db` is the handle every repository holds: it resolves to the
  // current request's scoped transaction when there is one, and to the pool
  // otherwise. `pool` stays available for the work that must run privileged —
  // the bootstrap below, migrations, and the auth plane.
  const db = scopedDb(pool);
  const { userId, orgId, spaceId } = await ensureSingleUserBootstrap(pool);

  const scopeCheck = await checkScopeUsable(pool);
  if (!scopeCheck.ok) {
    // Silent by nature: an instance that cannot assume the role behaves
    // exactly like one with no policies, and nothing in the product looks
    // different. So it is said out loud.
    console.warn(
      `⚠️  RLS NO se está aplicando: no se pudo asumir el rol diluxite_app (${scopeCheck.reason}).\n` +
        '   El aislamiento entre organizaciones queda solo en la capa de aplicación.\n' +
        '   Revisá que la migración 0028 haya corrido contra esta base.',
    );
  }

  const notesRepo = tenantScoped(new DrizzleNotesRepository(db), pool);
  const searchRepo = tenantScoped(new DrizzleSearchRepository(db), pool);
  // The stored choice wins over the environment (ADR-003). An installation
  // that has never opened the admin console resolves exactly as before.
  const embeddingConfig = new DrizzleEmbeddingConfigRepository(pool);
  const passphrase = secretPassphrase();
  let fromConfig: { embedder: EmbeddingProvider; name: string } | null = null;
  try {
    fromConfig = embedderFromConfig(await embeddingConfig.read(), passphrase);
  } catch (e) {
    // A stored configuration that cannot be built is worth stopping on rather
    // than silently reverting: falling back to the environment would change
    // the vector space without anyone asking for it.
    console.error(
      `🚨 La configuración de embeddings guardada no se pudo aplicar: ${(e as Error).message}\n` +
        '   La búsqueda semántica queda con el proveedor anterior hasta corregirla en Admin → AI.',
    );
  }
  const { embedder, name: embedderName } = fromConfig ?? pickEmbedder();

  // ADR-003: the live embedding model is a row, not an assumption. Registering
  // it creates its partition of `chunk_embeddings`, pins the dimension and
  // builds the HNSW index — all idempotent, so the usual boot is one SELECT.
  // Unscoped on purpose: it creates partitions and indexes at boot, which is
  // DDL the data-plane role cannot and should not do.
  const embeddingModels = new DrizzleEmbeddingModelsRepository(pool);
  const activeModel = await ensureEmbeddingModel(embeddingModels, embedder, embedderName, searchRepo);
  // Warn (don't abort) if stored vectors don't match the active embedder's
  // dimension — semantic search would otherwise fail with a hard pgvector
  // error until a reindex. Best-effort: never block boot on this probe.
  try {
    await checkEmbeddingDimension(sql, embedder.dimensions);
  } catch (e) {
    console.warn(`⚠️  No se pudo verificar la dimensión de embeddings: ${(e as Error).message}`);
  }
  // The provenance repo doubles as the cadence source: every search result
  // then carries how it is ageing, in its own rhythm (ADR-002). One batch
  // query for the results returned — no pass over the corpus.
  const provenanceRepo = tenantScoped(new DrizzleEntityProvenanceRepository(db), pool);
  const factsRepo = tenantScoped(new DrizzleFactsRepository(db), pool);
  const search = new SearchService(searchRepo, embedder, notesRepo, {
    cadence: provenanceRepo,
  });
  const noteVersionsRepo = tenantScoped(new DrizzleNoteVersionsRepository(db), pool);
  const notes = new NotesService(notesRepo, search, noteVersionsRepo);
  const spaces = tenantScoped(new DrizzleSpacesRepository(db), pool);
  const organizations = tenantScoped(new DrizzleOrganizationsRepository(db), pool);
  const users = tenantScoped(new DrizzleUsersRepository(db), pool);
  const tokens = tenantScoped(new DrizzleTokensRepository(db), pool);
  const sessions = tenantScoped(new DrizzleSessionsRepository(db), pool);
  const passkeys = tenantScoped(new DrizzlePasskeysRepository(db), pool);
  const tags = tenantScoped(new DrizzleTagsRepository(db), pool);
  const links = tenantScoped(new DrizzleLinksRepository(db), pool);
  const folders = tenantScoped(new DrizzleFoldersRepository(db), pool);
  const move = tenantScoped(new DrizzleMoveRepository(db), pool);
  // Both on the pool rather than the scoped handle (ADR-004):
  //   - the audit log is a security record that must be written even when the
  //     actor could not read the row they acted on. A policy silently dropping
  //     an audit entry is the worst possible failure of an audit log.
  //   - TOTP secrets belong to the auth plane, which runs privileged because
  //     gating credentials by the identity they establish is circular.
  const audit = new (await import('@diluxite/db')).DrizzleAuditEventsRepository(pool);
  const totp = new (await import('@diluxite/db')).DrizzleTotpRepository(pool);

  const authMode = pickAuthMode();
  let auth: AuthProvider;
  if (authMode === 'server') {
    await bootstrapServerAdmin(users, organizations);
    const sessionAuth = new SessionAuthProvider(sessions, tokens);

    // Auth chain, highest priority first. Each external-IdP layer is opt-in
    // via env and only added when configured:
    //   1. Session / Bearer (explicit cookie or token) — always.
    //   2. Cloudflare Access (signed JWT, cryptographically verified) — secure
    //      even without a tunnel; a spoofed header has no valid signature.
    //   3. TrustedHeader (plaintext email header) — INSECURE unless ALL traffic
    //      is forced through the proxy; kept for Authelia/Pomerium operators.
    const chain: AuthProvider[] = [sessionAuth];

    const needsPolicy =
      !!process.env.DILUXITE_CF_ACCESS_TEAM_DOMAIN?.trim() ||
      !!process.env.DILUXITE_TRUSTED_IDENTITY_HEADER?.trim();
    let getAuthPolicy: (() => Promise<import('@diluxite/core').AuthPolicy>) | null = null;
    if (needsPolicy) {
      const { DrizzleOrgSettingsRepository } = await import('@diluxite/db');
      const orgSettings = tenantScoped(new DrizzleOrgSettingsRepository(db), pool);
      getAuthPolicy = () => orgSettings.getAuthPolicy(orgId);
    }

    const cfTeam = process.env.DILUXITE_CF_ACCESS_TEAM_DOMAIN?.trim();
    const cfAud = process.env.DILUXITE_CF_ACCESS_AUD?.trim();
    if (cfTeam && cfAud && getAuthPolicy) {
      const { CfAccessJwtAuthProvider } = await import('./cf-access');
      chain.push(
        new CfAccessJwtAuthProvider(users, { teamDomain: cfTeam, aud: cfAud }, getAuthPolicy),
      );
      console.log(`🛡️  Cloudflare Access (JWT-verified) enabled — team=${cfTeam}`);
    }

    const trustedHeaderName = process.env.DILUXITE_TRUSTED_IDENTITY_HEADER?.trim();
    if (trustedHeaderName && getAuthPolicy) {
      const { TrustedHeaderAuthProvider } = await import('@diluxite/core');
      chain.push(
        new TrustedHeaderAuthProvider(users, {
          headerName: trustedHeaderName,
          getAuthPolicy,
        }),
      );
      console.log(
        `🛡️  TrustedHeader provider enabled — header=${trustedHeaderName} ` +
          `(⚠️ plaintext: requires forcing ALL traffic through your proxy)`,
      );
    }

    auth =
      chain.length === 1
        ? sessionAuth
        : {
            async resolve(headers) {
              for (const provider of chain) {
                const id = await provider.resolve(headers);
                if (id) return id;
              }
              return null;
            },
          };
  } else {
    auth = new SingleUserAuthProvider(userId);
  }

  // Read the version straight from this package's package.json so /api/info
  // never lies about what's actually deployed. The previous hardcoded value
  // (4.1.0-alpha.0) drifted away from the real version several alphas ago.
  //
  // collabUrl is set when the collab WS is reachable from the browser. Two
  // flavours:
  //   - DILUXITE_COLLAB_PUBLIC_URL=<url> (explicit override, e.g. wss://...)
  //   - DILUXITE_COLLAB_DISABLED=1 → null (no collab)
  //   - otherwise → same-origin `/collab` (nginx routes it to the api
  //     sibling on :3031). The browser builds the absolute URL from
  //     window.location at runtime.
  const collabUrl = (() => {
    if (process.env.DILUXITE_COLLAB_DISABLED === '1') return null;
    const override = process.env.DILUXITE_COLLAB_PUBLIC_URL;
    if (override) return override;
    return '/collab';
  })();

  // OIDC wire-up — only when both server mode is on AND env vars are set.
  // We do the discovery here at boot so the first user click on "Sign in
  // with SSO" doesn't pay the metadata fetch latency.
  let oidcDeps: AppDeps['oidc'] = undefined;
  if (authMode === 'server') {
    const { readOidcConfig, buildOidcClient } = await import('./oidc');
    const oidcConfig = readOidcConfig();
    if (oidcConfig) {
      try {
        const client = await buildOidcClient(oidcConfig);
        const { DrizzleOidcCeremoniesRepository, DrizzleOrgSettingsRepository } =
          await import('@diluxite/db');
        oidcDeps = {
          config: oidcConfig,
          client,
          ceremonies: new DrizzleOidcCeremoniesRepository(sql),
          orgSettings: tenantScoped(new DrizzleOrgSettingsRepository(db), pool),
          orgId,
        };
        console.log(`🔐 OIDC enabled — issuer=${oidcConfig.issuerUrl}`);
      } catch (e) {
        console.error(
          `⚠️  OIDC config present but discovery failed: ${
            (e as Error).message
          }. Continuing without OIDC.`,
        );
      }
    }
  }

  const info = {
    embedder: embedderName,
    version: pkg.version,
    authMode,
    collabUrl,
    oidcEnabled: !!oidcDeps,
  };

  return {
    sql,
    db,
    notesRepo,
    deps: {
      notes,
      search,
      embedder,
      embeddingStats: () => searchRepo.embeddingStats(),
      embeddingConfig,
      embeddingModels,
      spaces,
      organizations,
      users,
      tokens,
      sessions,
      passkeys,
      tags,
      links,
      folders,
      move,
      provenance: provenanceRepo,
    facts: factsRepo,
    // Always wired, not only in server mode: the search configuration is
    // per-org and a local install has an org too.
    orgSettings: tenantScoped(new DrizzleOrgSettingsRepository(db), pool),
      auth,
      info,
      oidc: oidcDeps,
      audit,
      totp,
      email: pickEmailProvider(),
      passwordResets:
        authMode === 'server'
          ? // Auth plane: the table is deny-all by design, and a reset happens
            // before anyone is authenticated.
            new (await import('@diluxite/db')).DrizzlePasswordResetsRepository(pool)
          : undefined,
      publicWebUrl: process.env.DILUXITE_PUBLIC_WEB_URL?.trim() || undefined,
    },
    userId,
    defaultSpaceId: spaceId,
    defaultOrgId: orgId,
    authMode,
  };
}
