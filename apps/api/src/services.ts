import {
  createDb,
  DrizzleNotesRepository,
  DrizzleEntityProvenanceRepository,
  DrizzleFactsRepository,
  DrizzleNoteVersionsRepository,
  DrizzlePasskeysRepository,
  DrizzleSearchRepository,
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
  const { sql, db } = createDb(databaseUrl);
  const { userId, orgId, spaceId } = await ensureSingleUserBootstrap(db);

  const notesRepo = new DrizzleNotesRepository(db);
  const searchRepo = new DrizzleSearchRepository(db);
  const { embedder, name: embedderName } = pickEmbedder();
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
  const provenanceRepo = new DrizzleEntityProvenanceRepository(db);
  const factsRepo = new DrizzleFactsRepository(db);
  const search = new SearchService(searchRepo, embedder, notesRepo, {
    cadence: provenanceRepo,
  });
  const noteVersionsRepo = new DrizzleNoteVersionsRepository(db);
  const notes = new NotesService(notesRepo, search, noteVersionsRepo);
  const spaces = new DrizzleSpacesRepository(db);
  const organizations = new DrizzleOrganizationsRepository(db);
  const users = new DrizzleUsersRepository(db);
  const tokens = new DrizzleTokensRepository(db);
  const sessions = new DrizzleSessionsRepository(db);
  const passkeys = new DrizzlePasskeysRepository(db);
  const tags = new DrizzleTagsRepository(db);
  const links = new DrizzleLinksRepository(db);
  const folders = new DrizzleFoldersRepository(db);
  const move = new DrizzleMoveRepository(db);
  const audit = new (await import('@diluxite/db')).DrizzleAuditEventsRepository(db);
  const totp = new (await import('@diluxite/db')).DrizzleTotpRepository(db);

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
      const orgSettings = new DrizzleOrgSettingsRepository(db);
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
          orgSettings: new DrizzleOrgSettingsRepository(db),
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
      auth,
      info,
      oidc: oidcDeps,
      audit,
      totp,
      email: pickEmailProvider(),
      passwordResets:
        authMode === 'server'
          ? new (await import('@diluxite/db')).DrizzlePasswordResetsRepository(db)
          : undefined,
      publicWebUrl: process.env.DILUXITE_PUBLIC_WEB_URL?.trim() || undefined,
    },
    userId,
    defaultSpaceId: spaceId,
    defaultOrgId: orgId,
    authMode,
  };
}
