import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { unzipSync, zipSync } from 'fflate';
import { beginScope, setScopeUser } from '@diluxite/db';
import { embedderFromConfig } from './services';
import {
  METRICS_CONTENT_TYPE,
  addTagToMarkdown,
  planImport,
  normaliseTag,
  removeTagFromMarkdown,
  sealSecret,
  secretPassphrase,
  apiErrorMessage,
  assessStaleness,
  canReadSpace,
  exportWorkspace,
  safeSegment,
  negotiateLocale,
  isEmailShaped,
  structuralKindOf,
  canWriteSpace,
  hashPassword,
  identityUserId,
  TOKEN_SCOPE_READ,
  TOKEN_SCOPE_WRITE,
  type AuthProvider,
  type Identity,
  type NotesService,
  type SearchService,
  type SpaceAuthzDeps,
  type WriteAttribution,
} from '@diluxite/core';
import { DEFAULT_SEARCH_CONFIG, FolderCycleError, MAX_SEARCH_TOP_K } from '@diluxite/db';
import type {
  DrizzleFoldersRepository,
  DrizzleMoveRepository,
  DrizzleLinksRepository,
  DrizzleOrganizationsRepository,
  DrizzleSpacesRepository,
  DrizzleTagsRepository,
  DrizzleTokensRepository,
  DrizzleUsersRepository,
  OrgRole,
  WorkspaceRole,
} from '@diluxite/db';
import { registerMcp } from './mcp';
import { registerPasskeyRoutes } from './passkey-routes';
import { applyServerEdit, replaceWholeText } from './collab';

const ORG_ROLES: readonly OrgRole[] = ['org_admin', 'org_member'];
const WS_ROLES: readonly WorkspaceRole[] = ['admin', 'editor', 'viewer'];

function isOrgRole(r: string): r is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(r);
}
function isWorkspaceRole(r: string): r is WorkspaceRole {
  return (WS_ROLES as readonly string[]).includes(r);
}
function isNewer(remote: string, local: string): boolean {
  const stripV = (s: string) => s.replace(/^v/, '').split('-')[0];
  const r = stripV(remote).split('.').map((n) => Number(n) || 0);
  const l = stripV(local).split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const ri = r[i] ?? 0;
    const li = l[i] ?? 0;
    if (ri > li) return true;
    if (ri < li) return false;
  }
  return false;
}

/**
 * A real, valid password hash used ONLY to spend pbkdf2 time when the login
 * email is unknown — equalising the response time so an attacker can't
 * enumerate which emails exist by timing. Computed once at module load (its
 * plaintext is irrelevant; no real account uses it).
 */
const DUMMY_PASSWORD_HASH = hashPassword('diluxite-login-timing-equaliser');

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

declare module 'fastify' {
  interface FastifyRequest {
    identity?: Identity;
  }
}

/**
 * Thrown by `requireUser` when an ORG token hits a user-only route (TOTP,
 * sessions, password, passkeys, token minting, member management). The global
 * error handler honours `statusCode` in the 4xx range, so this surfaces as a
 * clean 403 — never a 500.
 */
class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message = 'this action requires a user; an org token cannot perform it') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export interface AppDeps {
  notes: NotesService;
  search: SearchService;
  /**
   * The active embedder, for the admin health endpoint to describe. Optional:
   * without it that endpoint reports `active: null` rather than guessing.
   */
  embedder?: import('@diluxite/core').EmbeddingProvider;
  /** What an organisation has stored, by model — see `embeddingStats()`. */
  embeddingStats?: (orgId: string) => Promise<import('@diluxite/db').EmbeddingStats>;
  /**
   * Where the process counts what it did — see `/metrics`.
   *
   * Optional so a test app and any other embedder of this API can leave it
   * out; without it the hooks are not installed and the endpoint does not
   * exist, rather than existing and answering nothing.
   */
  metrics?: import('@diluxite/core').MetricsRegistry;
  /** The stored provider choice (ADR-003). Without it the console is read-only. */
  embeddingConfig?: import('@diluxite/db').DrizzleEmbeddingConfigRepository;
  /** The vector-space catalogue, so a saved choice can be registered. */
  embeddingModels?: import('@diluxite/db').DrizzleEmbeddingModelsRepository;
  /**
   * Drop the memoised embedder for one organisation.
   *
   * The provider an organisation searches with is built once and kept, since
   * reading its configuration is a query and every search asks. That memo had
   * no way to be told the configuration changed: an admin could point the
   * organisation at a different endpoint, get a saved confirmation, and the
   * running process would go on embedding with the old one until somebody
   * restarted the container. Whoever writes the configuration has to say so.
   */
  forgetOrgEmbedder?: (orgId: string) => void;
  /**
   * Which organisations a given user belongs to, read OUTSIDE the request
   * scope (ADR-004).
   *
   * Needed by the authorisation decisions that are about somebody other than
   * the caller: under RLS the ordinary repository answers "what can I see",
   * which for another person's account is nothing — and "nothing" read as
   * "belongs to no one" is how a check quietly inverts itself.
   */
  membershipLookup?: (userId: string) => Promise<{ id: string }[]>;
  spaces: DrizzleSpacesRepository;
  organizations: DrizzleOrganizationsRepository;
  users: DrizzleUsersRepository;
  tokens: DrizzleTokensRepository;
  sessions?: import('@diluxite/db').DrizzleSessionsRepository;
  passkeys?: import('@diluxite/db').DrizzlePasskeysRepository;
  tags: DrizzleTagsRepository;
  links: DrizzleLinksRepository;
  folders: DrizzleFoldersRepository;
  /** Atomic bulk move of notes + folders into one destination (multi-select). */
  move: DrizzleMoveRepository;
  /**
   * Change cadences (ADR-002). Optional: a deployment without it simply
   * returns notes with no freshness field, rather than one that claims
   * everything is current.
   */
  provenance?: import('@diluxite/db').DrizzleEntityProvenanceRepository;
  /**
   * The structured lane (ADR-001 step 2). Optional: without it a deployment
   * simply has no exact-fact channel, rather than one answering from nothing.
   */
  facts?: import('@diluxite/db').DrizzleFactsRepository;
  /**
   * Per-org settings, including the search configuration. Optional: without
   * it every org falls back to the shipped defaults.
   */
  orgSettings?: import('@diluxite/db').DrizzleOrgSettingsRepository;
  auth: AuthProvider;
  info?: { embedder: string; version: string; authMode?: 'local' | 'server' };
  /**
   * Optional collaborative editing bridge. When set, server-authored edits
   * (MCP append, future programmatic writes) go through the in-memory Y.Doc
   * if it's live, so connected clients see the change in real time. Without
   * it the endpoints take the legacy DB-only path.
   */
  collab?: {
    notesRepo: import('@diluxite/core').NotesRepository;
    yjs: import('@diluxite/core').YjsStateRepository;
    hocuspocus: { documents: Map<string, { name: string }> };
    /** Reindex hook so server-authored edits keep search/tags fresh. */
    indexer?: import('@diluxite/core').NoteIndexer;
  };
  /**
   * Enterprise SSO via OIDC. Optional — when present, the /api/auth/oidc/*
   * routes are registered. Built by services.ts when env vars are set.
   * Includes the org_settings + oidc_ceremonies repos needed for the flow.
   */
  oidc?: {
    config: import('./oidc').OidcConfig;
    client: import('openid-client').Configuration;
    ceremonies: import('@diluxite/db').DrizzleOidcCeremoniesRepository;
    orgSettings: import('@diluxite/db').DrizzleOrgSettingsRepository;
    /** Org whose auth_policy this OIDC integration belongs to (server mode → one org). */
    orgId: string;
  };
  /**
   * Append-only audit log for security and admin actions. Optional in local
   * mode (single-user, no audience for the log). Recorded by `recordEvent`
   * helpers throughout the endpoints; surfaced via /api/admin/orgs/:orgId/audit.
   */
  audit?: import('@diluxite/db').DrizzleAuditEventsRepository;
  /**
   * TOTP / 2FA repository — only relevant in server mode. When absent the
   * 2FA endpoints return 404 and the password login path skips the gate.
   */
  totp?: import('@diluxite/db').DrizzleTotpRepository;
  /**
   * Email provider for transactional messages (forgot-password reset,
   * future SSO invites, audit alerts). Always present — pickEmailProvider()
   * falls back to NoopEmailProvider when SMTP isn't configured, so endpoints
   * can rely on `deps.email.send(...)` without a null check.
   */
  email?: import('@diluxite/core').EmailProvider;
  /**
   * Forgot-password reset tokens repository. Only relevant in server mode;
   * when absent the /api/auth/forgot and /api/auth/reset endpoints return 404.
   */
  passwordResets?: import('@diluxite/db').DrizzlePasswordResetsRepository;
  /**
   * Public base URL of the web (https://diluxite.acme.com). Used to build
   * the reset link sent by email. Falls back to `Origin` header if absent.
   */
  publicWebUrl?: string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // DILUXITE_TRUST_PROXY=1 → trust X-Forwarded-* headers from the reverse
  // proxy in front of the api (Caddy in the default install), so `req.ip`
  // resolves to the real client address. Leave it OFF when the api is
  // exposed directly: a client-supplied X-Forwarded-For must NOT be trusted
  // (it would let an attacker rotate "IPs" and bypass the login rate-limit).
  // Set by the installer alongside the other DILUXITE_* env vars.
  const app = Fastify({
    logger: false,
    trustProxy: process.env.DILUXITE_TRUST_PROXY === '1',
  });

  // ── Empty JSON body tolerance ───────────────────────────────────────────
  // Action-style POSTs from the browser (e.g. POST /notes/:id/restore, TOTP
  // enroll) carry no payload, but our CSRF helper still sends
  // `content-type: application/json`. Fastify's default JSON parser rejects an
  // empty body with 400 ("Body cannot be empty…"), which broke those routes.
  // Treat an empty (or whitespace-only) JSON body as `{}`.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // ── Global error handler ────────────────────────────────────────────────
  // Routes answer their own 4xx via `reply.code(4xx).send({error})` (those
  // never reach here). This catches what falls THROUGH: thrown exceptions,
  // driver errors, Fastify schema-validation failures. Two goals:
  //   1. Don't leak Postgres/driver internals to the client on a 500 — the
  //      raw `err.message` can disclose schema, queries, IPs. Log it
  //      server-side, answer with a generic body.
  //   2. Map a malformed input that reaches the driver — most notably a bad
  //      UUID in a `:id` param (Postgres 22P02 "invalid text representation")
  //      — to a 400, not a 500. A garbage id is a client error.
  app.setErrorHandler((err, req, reply) => {
    // Drizzle wraps the postgres driver error in a DrizzleQueryError, so the
    // SQLSTATE lives on `err.cause.code`; a raw driver error carries it on
    // `err.code`. Check both.
    const code =
      (err as { code?: string }).code ??
      (err as { cause?: { code?: string } }).cause?.code;
    // Fastify validation errors carry `.validation`; treat as 400.
    const isValidation = Array.isArray((err as { validation?: unknown[] }).validation);
    // 22P02 = invalid_text_representation (bad uuid / int / enum cast).
    // 22003 = numeric_value_out_of_range. Both are bad client input.
    if (code === '22P02' || code === '22003' || isValidation) {
      return reply.code(400).send({ error: 'invalid request' });
    }
    // Honour an explicit statusCode if a thrown error set one (e.g. the
    // content-type parser sets 400 on malformed JSON).
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const message = (err as { message?: string }).message;
      return reply.code(statusCode).send({ error: message || 'bad request' });
    }
    // Anything else is a server fault. Log the FULL error for operators; the
    // client only ever sees a generic message (no driver detail).
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal server error' });
  });

  // ── Security headers via @fastify/helmet ────────────────────────────────
  // We harden responses with CSP / HSTS / X-Frame-Options / etc. The CSP
  // is permissive enough for the Vite-built SPA (inline styles for theme
  // tokens, blob: for Web Workers if/when we add them) but blocks
  // arbitrary inline scripts — that's the XSS-relevant bit.
  //
  // Skipped in test mode (DILUXITE_HELMET_DISABLED=1) so integration tests
  // that flood the API don't pay the CSP cost on every request (also some
  // jsdom tests don't honour these headers and add noise).
  if (process.env.DILUXITE_HELMET_DISABLED !== '1') {
    const helmet = (await import('@fastify/helmet')).default;
    await app.register(helmet, {
      // Same-origin SPA + WebSocket to /collab on the same host. No CDN.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Vite-built CSS includes hashed-inline style tags for the
          // critical-CSS path. 'unsafe-inline' for styles is the standard
          // SPA compromise. JS stays strict (no 'unsafe-inline').
          styleSrc: ["'self'", "'unsafe-inline'"],
          // The HMR / source-maps story needs ws: in dev. In prod we only
          // ever talk to ws(s)://<same-origin>/collab.
          connectSrc: ["'self'", 'ws:', 'wss:'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          // Workers (Monaco was; CodeMirror 6 doesn't need; future-proofing).
          workerSrc: ["'self'", 'blob:'],
          // Block anything else by default.
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"], // protect against being iframed
        },
      },
      // HSTS is only meaningful behind HTTPS. We enable it with a year-long
      // max-age — the proxy/installer is responsible for serving TLS.
      strictTransportSecurity: {
        maxAge: 60 * 60 * 24 * 365,
        includeSubDomains: true,
      },
      // No Referer leaks on cross-origin nav.
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      // Force MIME-sniff off (browsers won't guess content-type).
      noSniff: true,
      // No old IE compat.
      xXssProtection: false,
      // Embedder-policy / COEP off so embeddable assets (Pixabay images, etc)
      // keep working. Tighten later if we ship a hardened mode.
      crossOriginEmbedderPolicy: false,
      // The frontend is same-origin with the API. No need for popups / postMessage.
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      // Cross-origin resources can be read from the same origin.
      crossOriginResourcePolicy: { policy: 'same-origin' },
    });
  }

  // Rate limiting — registered with global:false so it ONLY engages on routes
  // that opt-in via `config.rateLimit`. Login is the main target: brute-force
  // resistance for `POST /api/auth/login` without throttling normal API
  // traffic. Test env shortcut: integration tests set DILUXITE_RATE_LIMIT_DISABLED=1
  // to keep their flooding-the-endpoint scenarios working without 429.
  //
  // Must `await` the register so the plugin is in place BEFORE the routes
  // below declare their `config.rateLimit`. Without the await, fastify would
  // see the route options as un-handled extra config and the gate never
  // fires. This is why buildApp() is async.
  if (process.env.DILUXITE_RATE_LIMIT_DISABLED !== '1') {
    const rateLimit = (await import('@fastify/rate-limit')).default;
    await app.register(rateLimit, {
      global: false,
      max: 5,
      timeWindow: '1 minute',
      // Identifier: `req.ip`. Fastify resolves X-Forwarded-For safely on its
      // own when `trustProxy` is enabled (DILUXITE_TRUST_PROXY=1); without
      // it, the socket remote address is used — never a client-controlled
      // header, which would let an attacker bypass the limit by rotating XFF.
      keyGenerator: (req) => req.ip,
    });
  }

  app.get('/health', async () => ({ status: 'ok', service: 'diluxite-core' }));

  // ── Metrics (Prometheus) ────────────────────────────────────────────────
  //
  // Two halves, and both are opt-in:
  //
  //   - The HTTP counters only exist if a registry was handed in. A test app
  //     builds none, so its requests cost nothing.
  //   - `/metrics` only exists if DILUXITE_METRICS_TOKEN is set. An endpoint
  //     that lists every route, its traffic and the running version is a map
  //     of the installation, and a default-on map with no credential is one
  //     more thing an operator has to remember to close.
  if (deps.metrics) {
    const requests = deps.metrics.counter(
      'diluxite_http_requests_total',
      'HTTP requests handled, by method, route and status.',
    );
    const duration = deps.metrics.histogram(
      'diluxite_http_request_duration_seconds',
      'How long a request took, by method and route.',
    );

    app.addHook('onResponse', (req, reply, done) => {
      // The ROUTE, never the URL. `/api/notes/:id` is one series; the path
      // it resolved from is one series per note, and a scanner walking made-up
      // paths would mint a new one on every request — the classic way to fill
      // a time-series database from outside.
      const route = req.routeOptions?.url ?? 'unmatched';
      requests.inc({ method: req.method, route, status: String(reply.statusCode) });
      // Fastify measures this itself, in milliseconds; Prometheus counts
      // seconds and a histogram in the wrong unit is worse than none.
      duration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
      done();
    });

    const token = process.env.DILUXITE_METRICS_TOKEN?.trim();
    if (token) {
      const expected = Buffer.from(`Bearer ${token}`);
      app.get('/metrics', async (req, reply) => {
        const offered = Buffer.from(req.headers.authorization ?? '');
        // Constant-time, and length-checked first because `timingSafeEqual`
        // throws on a length mismatch rather than returning false.
        const ok =
          offered.length === expected.length && crypto.timingSafeEqual(offered, expected);
        // 404, not 401: an unauthenticated caller learns nothing about
        // whether this installation exposes metrics at all.
        if (!ok) return reply.code(404).send({ error: 'not found' });
        reply.header('content-type', METRICS_CONTENT_TYPE);
        return deps.metrics!.render();
      });
    }
  }

  // ── Auth endpoints (server mode) ────────────────────────────────────────
  // These are deliberately ABOVE the /api preHandler so login itself doesn't
  // require an existing session. They no-op gracefully in local mode (the
  // login UI never reaches them; the server-side guard returns 404).
  const SESSION_COOKIE = 'diluxite_session';
  const sessionCookie = (token: string, maxAgeSeconds: number) =>
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  const clearCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

  // Account/security endpoints (TOTP, sessions, password, logout) resolve their
  // OWN identity above the /api preHandler and are strictly user-only. Resolve
  // to a `{ userId }`, or null for anything that isn't a user (org token) — so
  // an org token gets the same "sign in first" 401 as an anonymous caller and
  // can never touch a human's account surface.
  const resolveSessionUser = async (
    headers: import('fastify').FastifyRequest['headers'],
  ): Promise<{ userId: string } | null> => {
    const id = await deps.auth.resolve(headers);
    if (!id) return null;
    const userId = identityUserId(id);
    return userId ? { userId } : null;
  };

  // Standard helper to capture the real client IP from a request. Fastify
  // already resolves X-Forwarded-For safely when `trustProxy` is on
  // (DILUXITE_TRUST_PROXY=1 behind Caddy); reading the header by hand would
  // trust a client-controlled value when the api is exposed directly.
  function clientIp(req: FastifyRequest): string | undefined {
    return req.ip;
  }

  // CSRF — double-submit cookie. The session cookie and the CSRF cookie are
  // minted together; the SPA reads the CSRF cookie from `document.cookie` and
  // echoes it into `X-CSRF-Token` on every state-changing request.
  const { mintCsrfToken, csrfCookieHeader, clearCsrfCookieHeader, csrfCheck } = await import(
    './csrf'
  );
  const setSessionAndCsrf = (
    reply: FastifyReply,
    sessionToken: string,
    maxAge: number,
  ): string => {
    // The CSRF token is derived from the session token (HMAC) so csrfCheck can
    // confirm the echoed token belongs to THIS session, not just any cookie.
    const csrf = mintCsrfToken(sessionToken);
    reply.header('Set-Cookie', [
      sessionCookie(sessionToken, maxAge),
      csrfCookieHeader(csrf, maxAge),
    ]);
    return csrf;
  };

  app.post(
    '/api/auth/login',
    {
      // 5 intentos por IP por minuto. 6º intento → 429. Cubre el caso
      // brute-force de password sin pegarle a la app normal.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
    if (deps.info?.authMode !== 'server' || !deps.sessions) {
      return reply.code(404).send({ error: 'login only available in server mode' });
    }
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    if (!email || !password) {
      return fail(req, reply, 400, 'auth.emailAndPasswordRequired');
    }
    const user = await deps.users.findWithPasswordByEmail(email.trim().toLowerCase());
    const { verifyPassword } = await import('@diluxite/core');
    // Constant-time-ish: if the user is unknown (or has no password hash), run
    // a dummy verifyPassword against a fixed hash so the pbkdf2 cost is paid
    // either way. Otherwise an attacker times the response to enumerate which
    // emails exist (existing email → slow pbkdf2; unknown → fast bail).
    if (!user || !user.passwordHash) {
      verifyPassword(password, DUMMY_PASSWORD_HASH);
    }
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      await deps.audit?.record({
        action: 'auth.login.failed',
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] as string | undefined,
        metadata: { attemptedEmail: email.trim().toLowerCase() },
      });
      return fail(req, reply, 401, 'auth.invalidCredentials');
    }
    // A soft-disabled account must not get a session even with the right
    // password. We answer AFTER the password check so we don't leak which
    // emails are disabled to someone guessing passwords.
    if (user.active === false) {
      await deps.audit?.record({
        actorId: user.id,
        action: 'auth.login.failed',
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] as string | undefined,
        metadata: { reason: 'account_disabled' },
      });
      return reply.code(403).send({ error: 'your admin disabled this account' });
    }
    // 2FA gate — if the user has TOTP enrolled, password alone is not enough.
    // We return an `mfaToken` opaque to the client; the SPA collects the code
    // and POSTs it to /api/auth/login/totp. No cookies are set at this stage.
    if (deps.totp) {
      const totpRow = await deps.totp.getForUser(user.id);
      if (totpRow) {
        const { mintMfaToken } = await import('./mfa-tokens');
        const mfaToken = mintMfaToken(user.id);
        return reply.code(200).send({ requiresMfa: true, mfaToken });
      }
    }
    const { token, expiresAt } = await deps.sessions.createSession(user.id, undefined, {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    const csrf = setSessionAndCsrf(reply, token, maxAge);
    await deps.audit?.record({
      actorId: user.id,
      action: 'auth.login.success',
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
      metadata: { method: 'password' },
    });
    return { ok: true, user: { id: user.id, email: user.email }, expiresAt, csrf };
  });

  // Second step of the 2FA login flow. Consumes the mfaToken minted by the
  // password handler, verifies the TOTP code (or a single-use backup code),
  // and finally mints the session + CSRF cookies.
  app.post(
    '/api/auth/login/totp',
    {
      // Same rate-limit budget as /api/auth/login. The mfaToken is bound to
      // a userId but an attacker could brute-force the 6-digit code if not
      // throttled.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      if (deps.info?.authMode !== 'server' || !deps.sessions || !deps.totp) {
        return reply.code(404).send({ error: 'TOTP login only available in server mode with 2FA enabled' });
      }
      const { mfaToken, code, backupCode } = (req.body ?? {}) as {
        mfaToken?: string;
        code?: string;
        backupCode?: string;
      };
      if (!mfaToken || (!code && !backupCode)) {
        return reply.code(400).send({ error: 'mfaToken and (code OR backupCode) required' });
      }
      const {
        verifyMfaToken,
        isMfaTokenConsumed,
        consumeMfaToken,
        isUserTotpLocked,
        recordTotpFailure,
        clearTotpFailures,
      } = await import('./mfa-tokens');
      const parsed = verifyMfaToken(mfaToken);
      if (!parsed) {
        return fail(req, reply, 401, 'mfa.tokenExpired');
      }
      // Single-use: a token spent by a successful login OR retired after the
      // failure cap can't be replayed.
      if (isMfaTokenConsumed(mfaToken)) {
        return fail(req, reply, 401, 'mfa.tokenUsed');
      }
      const userId = parsed.userId;
      // Per-user lockout (IP-independent): an attacker rotating IPs can't keep
      // grinding the 6-digit space against one user.
      if (isUserTotpLocked(userId)) {
        await deps.audit?.record({
          actorId: userId,
          action: 'auth.totp.locked',
          ip: clientIp(req),
          userAgent: req.headers['user-agent'] as string | undefined,
        });
        return reply
          .code(429)
          .send({ error: 'too many invalid codes — try again later' });
      }
      const totp = await deps.totp.getForUser(userId);
      if (!totp) {
        // The mfaToken was minted because the user had 2FA, but the row is
        // gone now (admin disabled?). Refuse rather than silently let through.
        return fail(req, reply, 401, 'totp.notConfigured');
      }
      const { verifyTotpCode, hashBackupCode } = await import('@diluxite/core');
      let ok = false;
      let viaBackup = false;
      if (code) {
        ok = verifyTotpCode(totp.secret, code);
      } else if (backupCode) {
        const consumed = await deps.totp.consumeBackupCode(userId, hashBackupCode(backupCode));
        ok = consumed;
        viaBackup = consumed;
      }
      if (!ok) {
        const lockedNow = recordTotpFailure(userId);
        // At the cap, retire THIS mfaToken so the attacker must redo the
        // password step (can't keep hammering with the same handoff token).
        if (lockedNow) consumeMfaToken(mfaToken);
        await deps.audit?.record({
          actorId: userId,
          action: 'auth.totp.failed',
          ip: clientIp(req),
          userAgent: req.headers['user-agent'] as string | undefined,
          metadata: { method: backupCode ? 'backup' : 'code', locked: lockedNow },
        });
        return reply
          .code(lockedNow ? 429 : 401)
          .send({ error: lockedNow ? 'too many invalid codes — try again later' : 'invalid code' });
      }
      // Success — spend the handoff token (single-use) and clear the counter.
      consumeMfaToken(mfaToken);
      clearTotpFailures(userId);
      const user = await deps.users.findById(userId);
      if (!user) return reply.code(401).send({ error: 'user not found' });
      if (user.active === false) {
        return reply.code(403).send({ error: 'your admin disabled this account' });
      }
      const { token, expiresAt } = await deps.sessions.createSession(user.id);
      const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      const csrf = setSessionAndCsrf(reply, token, maxAge);
      await deps.audit?.record({
        actorId: user.id,
        action: 'auth.login.success',
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] as string | undefined,
        metadata: { method: viaBackup ? 'totp+backup' : 'totp' },
      });
      return { ok: true, user: { id: user.id, email: user.email }, expiresAt, csrf };
    },
  );

  // ── 2FA enrollment endpoints ──────────────────────────────────────────
  // These three are AUTHENTICATED (the user must already be signed in to
  // enroll a TOTP). We require an existing session because the secret +
  // backup codes leak the second factor — only the actual user should see
  // the QR.
  app.post(
    '/api/auth/totp/enroll',
    // Enrolling mints a fresh secret; verify-enroll below takes a 6-digit
    // code and is therefore brute-forceable by an authenticated session.
    // Same budget as the login family — these are the auth surface, and
    // being behind a session does not make a 6-digit space large.
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
    if (deps.info?.authMode !== 'server' || !deps.totp) {
      return reply.code(404).send({ error: 'TOTP only available in server mode' });
    }
    const id = await resolveSessionUser(req.headers);
    if (!id) return reply.code(401).send({ error: 'sign in first' });
    const { generateTotpSecret, buildOtpauthUrl } = await import('@diluxite/core');
    const secret = generateTotpSecret();
    const user = await deps.users.findById(id.userId);
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const otpauthUrl = buildOtpauthUrl({
      issuer: 'Diluxite',
      accountName: user.email,
      secret,
    });
    // Mint an mfaToken that binds the candidate secret to the user. Verify
    // step needs both. We embed the secret in the token by stuffing it into
    // the userId slot? — no, cleaner to return it to the client and let it
    // come back via the verify body. The candidate secret is NOT persisted
    // until verify-enroll succeeds.
    return { secret, otpauthUrl };
    },
  );

  app.post(
    '/api/auth/totp/verify-enroll',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
    if (deps.info?.authMode !== 'server' || !deps.totp) {
      return reply.code(404).send({ error: 'TOTP only available in server mode' });
    }
    const id = await resolveSessionUser(req.headers);
    if (!id) return reply.code(401).send({ error: 'sign in first' });
    const { secret, code } = (req.body ?? {}) as { secret?: string; code?: string };
    if (!secret || !code) {
      return reply.code(400).send({ error: 'secret and code required' });
    }
    const { verifyTotpCode, generateBackupCodes } = await import('@diluxite/core');
    if (!verifyTotpCode(secret, code)) {
      return reply.code(401).send({ error: 'invalid code — try the next one your app shows' });
    }
    const { plaintext, hashes } = generateBackupCodes(10);
    await deps.totp.enroll({ userId: id.userId, secret, backupCodes: hashes });
    await deps.audit?.record({
      actorId: id.userId,
      action: 'admin.totp.enrolled',
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    return { ok: true, backupCodes: plaintext };
  });

  app.delete('/api/auth/totp', async (req, reply) => {
    if (deps.info?.authMode !== 'server' || !deps.totp) {
      return reply.code(404).send({ error: 'TOTP only available in server mode' });
    }
    const id = await resolveSessionUser(req.headers);
    if (!id) return reply.code(401).send({ error: 'sign in first' });
    const deleted = await deps.totp.deleteForUser(id.userId);
    if (deleted) {
      await deps.audit?.record({
        actorId: id.userId,
        action: 'admin.totp.disabled',
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] as string | undefined,
      });
    }
    return { ok: deleted };
  });

  app.get('/api/auth/totp/status', async (req, reply) => {
    if (deps.info?.authMode !== 'server' || !deps.totp) {
      return { enabled: false };
    }
    const id = await resolveSessionUser(req.headers);
    if (!id) return reply.code(401).send({ error: 'sign in first' });
    const row = await deps.totp.getForUser(id.userId);
    return {
      enabled: Boolean(row),
      backupCodesRemaining: row ? row.backupCodes.length : 0,
    };
  });

  // ── Active sessions management ─────────────────────────────────────────
  // GET  /api/auth/sessions               → ActiveSession[]
  // DELETE /api/auth/sessions/:id         → revoke a specific session
  // POST /api/auth/sessions/revoke-others → revoke ALL except the current one
  //
  // The caller's CURRENT session is marked with `current:true` so the UI can
  // refuse to revoke it from this surface (logout is the right action).
  function readSessionTokenFromCookie(req: FastifyRequest): string | null {
    const cookieHeader = (req.headers['cookie'] ?? req.headers['Cookie']) as string | undefined;
    if (!cookieHeader) return null;
    for (const pair of cookieHeader.split(/;\s*/)) {
      const [k, v] = pair.split('=');
      if (k === SESSION_COOKIE && v) return v;
    }
    return null;
  }

  app.get('/api/auth/sessions', async (req, reply) => {
    if (deps.info?.authMode !== 'server' || !deps.sessions) {
      return reply.code(404).send({ error: 'sessions only available in server mode' });
    }
    const id = await resolveSessionUser(req.headers);
    if (!id) return reply.code(401).send({ error: 'sign in first' });
    const currentToken = readSessionTokenFromCookie(req);
    const list = await deps.sessions.listActiveForUser(id.userId, currentToken);
    return { sessions: list };
  });

  app.delete('/api/auth/sessions/:id', async (req, reply) => {
    if (deps.info?.authMode !== 'server' || !deps.sessions) {
      return reply.code(404).send({ error: 'sessions only available in server mode' });
    }
    const id = await resolveSessionUser(req.headers);
    if (!id) return reply.code(401).send({ error: 'sign in first' });
    const { id: sessionId } = req.params as { id: string };
    const ok = await deps.sessions.revokeForUser(id.userId, sessionId);
    if (!ok) return reply.code(404).send({ error: 'session not found' });
    await deps.audit?.record({
      actorId: id.userId,
      action: 'admin.session.revoked',
      resource: `session:${sessionId}`,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    return { ok: true };
  });

  // ── Password change ───────────────────────────────────────────────────
  // POST /api/auth/password { currentPassword, newPassword }
  //
  // Re-verifies the current password (anti-CSRF defense in depth +
  // protects against opportunistic attacks if the user steps away with
  // an unlocked session). On success:
  //   1. Hashes the new password and persists it.
  //   2. Revokes EVERY other session of the user. The cookie that made
  //      this call survives — otherwise the user is logged out immediately
  //      and has to sign back in for no reason.
  //   3. Records an audit event with method=password (no metadata
  //      includes the actual password, of course).
  app.post(
    '/api/auth/password',
    {
      // Same rate budget as /login — a leaked session could still try to
      // brute-force current_password before changing it.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      if (deps.info?.authMode !== 'server' || !deps.sessions) {
        return reply.code(404).send({ error: 'password change only available in server mode' });
      }
      const id = await resolveSessionUser(req.headers);
      if (!id) return reply.code(401).send({ error: 'sign in first' });
      const { currentPassword, newPassword } = (req.body ?? {}) as {
        currentPassword?: string;
        newPassword?: string;
      };
      if (!currentPassword || !newPassword) {
        return fail(req, reply, 400, 'auth.passwordsRequired');
      }
      if (newPassword.length < 8) {
        return reply.code(400).send({ error: 'password must be at least 8 characters' });
      }
      if (newPassword === currentPassword) {
        return fail(req, reply, 400, 'auth.passwordMustDiffer');
      }
      const user = await deps.users.findById(id.userId);
      if (!user) return reply.code(404).send({ error: 'user not found' });
      const full = await deps.users.findWithPasswordByEmail(user.email);
      const { verifyPassword, hashPassword } = await import('@diluxite/core');
      if (!full || !full.passwordHash || !verifyPassword(currentPassword, full.passwordHash)) {
        await deps.audit?.record({
          actorId: id.userId,
          action: 'auth.password.change_failed',
          ip: clientIp(req),
          userAgent: req.headers['user-agent'] as string | undefined,
          metadata: { reason: 'current_password_wrong' },
        });
        return fail(req, reply, 401, 'auth.currentPasswordWrong');
      }
      await deps.users.setPassword(id.userId, hashPassword(newPassword));
      const currentToken = readSessionTokenFromCookie(req);
      const revoked = await deps.sessions.revokeAllForUser(id.userId, currentToken);
      await deps.audit?.record({
        actorId: id.userId,
        action: 'auth.password.changed',
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] as string | undefined,
        metadata: { otherSessionsRevoked: revoked },
      });
      return { ok: true, otherSessionsRevoked: revoked };
    },
  );

  // ── Forgot password ───────────────────────────────────────────────────
  // POST /api/auth/forgot { email }
  //
  // ALWAYS returns 200 — we never leak whether `email` is registered. If it
  // is, we mint a random 32-byte token, persist its SHA-256 hash with a 1h
  // TTL, and email the plain token in a reset link. If it isn't, we just
  // skip and return the same 200 (with a small delay to discourage timing
  // attacks on existence).
  //
  // Rate-limited 5/min/IP to make brute-force enumeration painful.
  app.post(
    '/api/auth/forgot',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (
        deps.info?.authMode !== 'server' ||
        !deps.passwordResets ||
        !deps.email
      ) {
        return reply
          .code(404)
          .send({ error: 'forgot password only available in server mode' });
      }
      const { email } = (req.body ?? {}) as { email?: string };
      const normalized = email?.trim().toLowerCase();
      if (!normalized || !isEmailShaped(normalized)) {
        // Same shape as success — no enumeration leak.
        return reply.code(200).send({ ok: true });
      }
      const user = await deps.users.findWithPasswordByEmail(normalized);
      if (user) {
        const { randomBytes, createHash } = await import('node:crypto');
        const tokenBytes = randomBytes(32);
        const token = tokenBytes.toString('base64url');
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const ttlMs = 60 * 60 * 1000; // 1 hour
        const expiresAt = new Date(Date.now() + ttlMs);
        await deps.passwordResets.create({
          userId: user.id,
          tokenHash,
          expiresAt,
          requestedIp: clientIp(req),
        });
        // Build the reset link from a SERVER-controlled base, never the
        // client-supplied `Origin` header — otherwise an attacker can poison
        // the link host (send the victim a reset email pointing at evil.com to
        // harvest the token). In server mode we require `publicWebUrl`; with it
        // unset we fall back to a fixed safe default, never `Origin`.
        const base =
          deps.publicWebUrl?.replace(/\/$/, '') || 'http://localhost:5173';
        const link = `${base}/reset?token=${encodeURIComponent(token)}`;
        await deps.email.send({
          to: normalized,
          subject: 'Reset your Diluxite password',
          text:
            `Hi,\n\nWe got a request to reset your Diluxite password.\n\n` +
            `Click here to set a new one (link valid for 1 hour):\n${link}\n\n` +
            `If you did not request this, ignore this email — your password ` +
            `stays unchanged.\n`,
          html:
            `<p>Hi,</p>` +
            `<p>We got a request to reset your Diluxite password.</p>` +
            `<p><a href="${link}">Click here to set a new one</a> ` +
            `(link valid for 1 hour).</p>` +
            `<p>If you did not request this, ignore this email — your ` +
            `password stays unchanged.</p>`,
        });
        await deps.audit?.record({
          actorId: user.id,
          action: 'auth.password.reset_requested',
          ip: clientIp(req),
          userAgent: req.headers['user-agent'] as string | undefined,
        });
      }
      return reply.code(200).send({ ok: true });
    },
  );

  // POST /api/auth/reset { token, newPassword }
  //
  // Atomically consumes the token by SHA-256(token) (verifies not-expired +
  // not-consumed in the same UPDATE), updates the user's password_hash, and revokes
  // ALL sessions of that user (no cookie to preserve — the user is doing this
  // because they lost access; signing out other devices is the right default).
  app.post(
    '/api/auth/reset',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (
        deps.info?.authMode !== 'server' ||
        !deps.passwordResets ||
        !deps.sessions
      ) {
        return reply
          .code(404)
          .send({ error: 'reset only available in server mode' });
      }
      const { token, newPassword } = (req.body ?? {}) as {
        token?: string;
        newPassword?: string;
      };
      if (!token || !newPassword) {
        return reply.code(400).send({ error: 'token and newPassword required' });
      }
      if (newPassword.length < 8) {
        return reply.code(400).send({ error: 'password must be at least 8 characters' });
      }
      const { createHash } = await import('node:crypto');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      // Atomic check-and-consume: a single UPDATE … RETURNING means two
      // concurrent requests with the same token can never both succeed.
      const row = await deps.passwordResets.consumeActiveByHash(tokenHash);
      if (!row) {
        await deps.audit?.record({
          action: 'auth.password.reset_failed',
          ip: clientIp(req),
          userAgent: req.headers['user-agent'] as string | undefined,
          metadata: { reason: 'token_invalid_or_expired' },
        });
        return fail(req, reply, 400, 'auth.invalidOrExpiredToken');
      }
      const { hashPassword } = await import('@diluxite/core');
      await deps.users.setPassword(row.userId, hashPassword(newPassword));
      const revoked = await deps.sessions.revokeAllForUser(row.userId);
      await deps.audit?.record({
        actorId: row.userId,
        action: 'auth.password.reset_completed',
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] as string | undefined,
        metadata: { sessionsRevoked: revoked },
      });
      return { ok: true, sessionsRevoked: revoked };
    },
  );

  app.post('/api/auth/sessions/revoke-others', async (req, reply) => {
    if (deps.info?.authMode !== 'server' || !deps.sessions) {
      return reply.code(404).send({ error: 'sessions only available in server mode' });
    }
    const id = await resolveSessionUser(req.headers);
    if (!id) return reply.code(401).send({ error: 'sign in first' });
    const currentToken = readSessionTokenFromCookie(req);
    const revoked = await deps.sessions.revokeAllForUser(id.userId, currentToken);
    await deps.audit?.record({
      actorId: id.userId,
      action: 'admin.session.revoked_all_others',
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
      metadata: { revoked },
    });
    return { revoked };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (deps.info?.authMode !== 'server' || !deps.sessions) {
      return reply.code(404).send({ error: 'logout only available in server mode' });
    }
    let endedSessionUserId: string | undefined;
    const cookieHeader = (req.headers['cookie'] ?? req.headers['Cookie']) as string | undefined;
    if (cookieHeader) {
      for (const pair of cookieHeader.split(/;\s*/)) {
        const [k, v] = pair.split('=');
        if (k === SESSION_COOKIE && v) {
          // Best-effort resolve so the audit event has the actor. If the
          // session is already expired/invalid, we still clear cookies.
          const id = await resolveSessionUser(req.headers);
          endedSessionUserId = id?.userId;
          await deps.sessions.deleteSession(v);
          break;
        }
      }
    }
    reply.header('Set-Cookie', [clearCookie, clearCsrfCookieHeader()]);
    await deps.audit?.record({
      actorId: endedSessionUserId,
      action: 'auth.logout',
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    return { ok: true };
  });

  // ── OIDC SSO (alpha.25 — Fase 1.1) ──────────────────────────────────────
  // Only registered when env config is present at boot. Two endpoints:
  //
  //   GET /api/auth/oidc/login    → 302 to the IdP authorize endpoint
  //   GET /api/auth/oidc/callback → exchanges code, JIT-applies policy,
  //                                 mints local session cookie, 302 to /
  //
  // The state/nonce/PKCE-verifier triplet lives in the `oidc_ceremonies`
  // table for the 10-minute window between the two calls. State is the
  // public ID (travels through the IdP), the verifier is secret and never
  // leaves the server.
  if (deps.oidc) {
    const oidcDeps = deps.oidc;
    const { buildAuthorizeUrl, handleCallback } = await import('./oidc');

    app.get(
      '/api/auth/oidc/login',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (_req, reply) => {
        const { url, state, nonce, codeVerifier } = await buildAuthorizeUrl(
          oidcDeps.client,
          oidcDeps.config,
        );
        await oidcDeps.ceremonies.save(state, nonce, codeVerifier);
        return reply.redirect(url);
      },
    );

    app.get(
      '/api/auth/oidc/callback',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const query = req.query as { state?: string; code?: string; error?: string };
        if (query.error) {
          return reply.code(400).send({ error: `IdP returned: ${query.error}` });
        }
        if (!query.state) return reply.code(400).send({ error: 'missing state' });
        const ceremony = await oidcDeps.ceremonies.consume(query.state);
        if (!ceremony) {
          return reply
            .code(400)
            .send({ error: 'unknown or expired ceremony — start over' });
        }

        // Reconstruct the full callback URL the way openid-client expects.
        // We use the redirect_uri from config + the raw query because that's
        // what was signed in the original authorize request.
        const callbackUrl = new URL(oidcDeps.config.redirectUri);
        for (const [k, v] of Object.entries(req.query as Record<string, string>)) {
          callbackUrl.searchParams.set(k, v);
        }

        let claims;
        try {
          claims = await handleCallback(oidcDeps.client, callbackUrl, {
            state: ceremony.state,
            nonce: ceremony.nonce,
            codeVerifier: ceremony.codeVerifier,
          });
        } catch (e) {
          // Don't reflect the raw error to the client — it can disclose IdP
          // internals / token details. Log server-side, answer generic.
          req.log.error({ err: e }, 'OIDC callback validation failed');
          return reply.code(400).send({ error: 'OIDC validation failed' });
        }

        // JIT with policy enforcement.
        const existing = await deps.users.findByEmail(claims.email);
        const policy = await oidcDeps.orgSettings.getAuthPolicy(oidcDeps.orgId);

        let jit = false;
        if (!existing) {
          if (policy === 'deny_unknown') {
            await deps.audit?.record({
              orgId: oidcDeps.orgId,
              action: 'auth.oidc.denied',
              ip: clientIp(req),
              userAgent: req.headers['user-agent'] as string | undefined,
              metadata: { reason: 'deny_unknown', attemptedEmail: claims.email },
            });
            return reply.code(403).send({ error: 'unknown user (deny_unknown policy)' });
          }
          if (policy === 'pre_provisioned_only') {
            await deps.audit?.record({
              orgId: oidcDeps.orgId,
              action: 'auth.oidc.denied',
              ip: clientIp(req),
              userAgent: req.headers['user-agent'] as string | undefined,
              metadata: { reason: 'pre_provisioned_only', attemptedEmail: claims.email },
            });
            return reply.code(403).send({
              error:
                'your account is not provisioned in Diluxite yet — ask an admin to import your email',
            });
          }
          // allow_unknown_as_member → JIT, but ONLY for a positively verified
          // email. If the IdP doesn't assert email_verified (or asserts false)
          // we refuse: an attacker who controls an OP could otherwise register
          // an unverified address and seize the matching org identity.
          if (claims.emailVerified !== true) {
            await deps.audit?.record({
              orgId: oidcDeps.orgId,
              action: 'auth.oidc.denied',
              ip: clientIp(req),
              userAgent: req.headers['user-agent'] as string | undefined,
              metadata: { reason: 'email_unverified', attemptedEmail: claims.email },
            });
            return reply.code(403).send({
              error: 'the identity provider did not verify this email address',
            });
          }
          await deps.users.createFromExternal({
            email: claims.email,
            firstName: claims.firstName,
            lastName: claims.lastName,
            provider: 'oidc',
          });
          jit = true;
        } else if (existing.provider !== 'oidc') {
          // An account with this email already exists but was NOT created by
          // this OIDC integration. We must NOT implicitly mint an OIDC session
          // for it — doing so would let SSO bypass the credentials that account
          // already carries (a local password + TOTP, a passkey).
          //
          //   - provider 'local' (has a password) → hard takeover risk. Deny.
          //   - provider 'csv_import' / other, NO password → the email was
          //     pre-provisioned by an admin for SSO. We allow the link ONLY if
          //     the IdP positively verified the email; otherwise an attacker
          //     who controls an unverified address could claim a seat an admin
          //     staged for someone else.
          //
          // We never overwrite `provider` here: the pre-provisioning audit
          // trail (csv_import) stays intact, and re-running this branch keeps
          // applying the same gate.
          const linkable = !existing.passwordHash && claims.emailVerified === true;
          if (!linkable) {
            await deps.audit?.record({
              orgId: oidcDeps.orgId,
              actorId: existing.id,
              action: 'auth.oidc.denied',
              ip: clientIp(req),
              userAgent: req.headers['user-agent'] as string | undefined,
              metadata: {
                reason: existing.passwordHash ? 'different_signin_method' : 'email_unverified',
                provider: existing.provider,
              },
            });
            return reply.code(403).send({
              error:
                'an account with this email already exists with a different sign-in method',
            });
          }
        }
        const user = (await deps.users.findByEmail(claims.email))!;
        if (!user.active) {
          await deps.audit?.record({
            orgId: oidcDeps.orgId,
            actorId: user.id,
            action: 'auth.oidc.denied',
            ip: clientIp(req),
            userAgent: req.headers['user-agent'] as string | undefined,
            metadata: { reason: 'account_disabled' },
          });
          return reply.code(403).send({ error: 'your admin disabled this account' });
        }

        await deps.users.touchLastLogin(user.id);

        // Mint local session cookie (same path as password login).
        if (!deps.sessions) {
          return reply.code(500).send({ error: 'sessions backend not configured' });
        }
        const { token, expiresAt } = await deps.sessions.createSession(user.id);
        const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
        setSessionAndCsrf(reply, token, maxAge);
        await deps.audit?.record({
          orgId: oidcDeps.orgId,
          actorId: user.id,
          action: 'auth.oidc.success',
          ip: clientIp(req),
          userAgent: req.headers['user-agent'] as string | undefined,
          metadata: { jit },
        });
        return reply.redirect('/');
      },
    );
  }

  // CSRF gate — applied to all /api state-changing requests authenticated by
  // session cookie. Bearer-token requests and safe methods skip. See csrf.ts
  // for the full rationale and decision tree. `DILUXITE_CSRF_DISABLED=1`
  // turns the check off (test suite + dev).
  const csrfDisabled = process.env.DILUXITE_CSRF_DISABLED === '1';
  if (!csrfDisabled) {
    app.addHook('preHandler', async (req, reply) => {
      if (!req.url.startsWith('/api')) return;
      // The login + OIDC handshake endpoints can't have a CSRF cookie yet —
      // they MINT it on success. Skip them; everything else with a session
      // cookie must echo the token.
      //
      // The passkey pre-auth ceremonies (/api/auth/passkey/authenticate-*)
      // need no entry here: they run without a session cookie, and csrfCheck
      // already skips requests that carry none (no ambient credential → no
      // CSRF risk). Earlier entries for /api/auth/passkey/login|options
      // pointed at routes that never existed and were removed.
      if (
        req.url.startsWith('/api/auth/login') ||
        req.url.startsWith('/api/auth/oidc/')
      ) {
        // Includes /api/auth/login/totp — the second step has no session yet.
        return;
      }
      const decision = csrfCheck({
        method: req.method,
        headers: req.headers as Record<string, unknown>,
      });
      if (!decision.ok) {
        reply.code(403).send({ error: `csrf rejected: ${decision.reason}` });
        return reply;
      }
    });
  }

  // ADR-004: every request runs inside a scope from its first moment. It
  // starts empty — nobody is authenticated yet — and the identity hook below
  // fills it in. Opening it here rather than there is not a detail: a hook can
  // only wrap what follows by running the continuation inside it.
  app.addHook('onRequest', (req, reply, done) => {
    beginScope(done);
  });

  // Per-request identity (RS-1: always from the validated token, never a free header).
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api')) return; // /health and /mcp handle their own
    if (req.url.startsWith('/api/auth/')) return; // login/logout/passkey handle their own auth
    const id = await deps.auth.resolve(req.headers);
    if (!id) {
      reply.code(401).send({ error: 'unauthenticated' });
      return reply;
    }
    req.identity = id;

    // ADR-004: from here on, the request is the DATA plane. Everything above
    // — resolving the token, reading the session — had to run privileged,
    // because the policies on those tables ask who the user is and that is
    // precisely what was being established.
    //
    // An org token has no user, so it enters a privileged scope: its
    // authorisation is scope-based and enforced in `space-authz`, and there is
    // no `app.current_user_id` that would describe it. Narrowing that is
    // future work, recorded in ADR-004.
    setScopeUser(identityUserId(id));
  });

  /**
   * The caller's userId — ONLY valid for user identities. Throws a 403 (mapped
   * by the global error handler) when called for an ORG token, so a single
   * `requireUser(req)` at the top of a user-only route locks org tokens out of
   * everything they must never touch (account/security/admin surfaces).
   */
  const requireUser = (req: FastifyRequest): string => {
    const id = req.identity!;
    if (id.kind !== 'user') {
      throw new ForbiddenError();
    }
    return id.userId;
  };
  /** Alias kept for the many user-plane routes that read the caller's id. */
  const uid = requireUser;

  /**
   * Traceability for unattended ORG-token writes. User actions are already
   * attributed via `actorId` on the security/admin endpoints; data-plane
   * writes by an org token have no user actor, so we record them with the
   * token's id in `metadata.orgTokenId` (never a fake actorId) so an admin can
   * see "this note was written by service token X". No-op for user identities
   * and when audit is disabled (local mode).
   */
  const auditOrgWrite = async (
    req: FastifyRequest,
    action: string,
    resource: string,
  ): Promise<void> => {
    const id = req.identity!;
    if (id.kind !== 'org' || !deps.audit) return;
    await deps.audit.record({
      orgId: id.orgId,
      action,
      resource,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
      metadata: { orgTokenId: id.tokenId },
    });
  };

  /**
   * How a note is ageing, in its own cadence (ADR-002).
   *
   * One row read. Returns null when the deployment has no cadence source, so
   * a caller can tell "we did not measure" from "measured and fresh" — a
   * default would erase that difference, which is the distinction the whole
   * record exists to keep.
   */
  const withFreshness = async <T extends { id: string; contentMd: string }>(
    list: T[],
  ): Promise<T[]> => {
    if (!deps.provenance || list.length === 0) return list;
    const cadences = await deps.provenance.cadenceForNotes(list.map((n) => n.id));
    return list.map((n) => {
      const cadence = cadences.get(n.id);
      return cadence
        ? { ...n, freshness: assessStaleness(cadence, structuralKindOf(n.contentMd)) }
        : n;
    });
  };

  const freshnessOf = async (note: { id: string; contentMd: string }) => {
    if (!deps.provenance) return null;
    const cadences = await deps.provenance.cadenceForNotes([note.id]);
    const cadence = cadences.get(note.id);
    if (!cadence) return null;
    return assessStaleness(cadence, structuralKindOf(note.contentMd));
  };

  /**
   * The search configuration that applies to a space, via its organisation.
   *
   * Falls back to the shipped defaults when there is no org settings row or no
   * settings repository at all, so a deployment that never configures this
   * behaves exactly as it did before.
   */
  const searchConfigFor = async (spaceId: string) => {
    const settings = deps.oidc?.orgSettings ?? deps.orgSettings;
    if (!settings) return { ...DEFAULT_SEARCH_CONFIG };
    const space = await deps.spaces.findById(spaceId);
    if (!space) return { ...DEFAULT_SEARCH_CONFIG };
    return settings.getSearchConfig(space.orgId);
  };

  /**
   * Reply with a localised error and a stable code.
   *
   * The web renders `body.error` straight to the user, so this is what a
   * Spanish speaker actually reads on the login screen. `code` is the part
   * clients should branch on: string-matching a message breaks the moment the
   * wording improves, and breaks once per language.
   *
   * English is byte-identical to what these endpoints returned before, so the
   * migration is additive for every existing client and test.
   */
  const fail = (
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    key: string,
    params?: Record<string, string | number>,
  ) => {
    const locale = negotiateLocale(req.headers['accept-language'] as string | undefined);
    return reply.code(status).send({ error: apiErrorMessage(key, locale, params), code: key });
  };

  /**
   * The request's identity, as a PROV attribution (ADR-002).
   *
   * A user token and a cookie session both name a person; an org token names
   * a process acting for an organisation and has no user behind it, so
   * `attributedTo` is null and `agentKind` says which it was. `generatedBy` is
   * the door — the caller passes it, because only the caller knows.
   */
  const attributionOf = (req: FastifyRequest, generatedBy: string): WriteAttribution => {
    const id = req.identity!;
    return id.kind === 'user'
      ? { attributedTo: id.userId, agentKind: 'user', generatedBy }
      : { attributedTo: null, agentKind: 'org_token', generatedBy };
  };

  // The read/write rule itself lives in `@diluxite/core` (`space-authz.ts`),
  // not here, and that move is the fix for a real pair of bugs: MCP and the
  // collab WebSocket each re-implemented "may this identity touch this space"
  // and each got it wrong, because the rule was a closure inside `buildApp`
  // that neither could import. The helpers below are now only the HTTP shape
  // around it — the status code and the message.
  const authz: SpaceAuthzDeps = { spaces: deps.spaces, organizations: deps.organizations };

  /**
   * Data-plane read authorisation for a space. Replies 403 and returns false
   * on failure (mirrors the old `requireMember` contract).
   */
  async function requireReadSpace(
    req: FastifyRequest,
    reply: FastifyReply,
    spaceId: string,
  ): Promise<boolean> {
    if (await canReadSpace(authz, req.identity!, spaceId)) return true;
    fail(req, reply, 403, 'space.noAccess');
    return false;
  }

  /**
   * Data-plane WRITE authorisation. A `viewer` is refused, and so is an org
   * token without the `write` scope — with a clean 403, never a 500.
   */
  async function requireWriteSpace(
    req: FastifyRequest,
    reply: FastifyReply,
    spaceId: string,
  ): Promise<boolean> {
    if (await canWriteSpace(authz, req.identity!, spaceId)) return true;
    fail(req, reply, 403, 'space.noWriteAccess');
    return false;
  }

  /**
   * Same predicate without the reply — for the per-note helpers and the spots
   * that check access inline (delete-many, search default space). The caller
   * decides the status code.
   */
  async function hasSpaceAccess(
    req: FastifyRequest,
    spaceId: string,
    write: boolean,
  ): Promise<boolean> {
    const id = req.identity!;
    return write ? canWriteSpace(authz, id, spaceId) : canReadSpace(authz, id, spaceId);
  }

  // Query params can arrive as `string`, `string[]` (e.g. ?tag=a&tag=b), or
  // undefined. Normalize to the first string so a handler that calls
  // `.trim()` / passes it to a query never blows up on an array → 500.
  const firstStr = (v: unknown): string | undefined =>
    Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : undefined)
    : typeof v === 'string' ? v
    : undefined;

  // RS-2: per-space authorisation on every operation. `requireMember` keeps its
  // historical name (read access) and now routes through `requireReadSpace`
  // so org tokens with the `read` scope on a space of their org are honoured.
  const requireMember = requireReadSpace;

  /**
   * Load a note for an authorised caller, replying with the right status on
   * failure and returning null then. Distinguishes:
   *   - no READ access (or note absent) → 404 (don't leak existence).
   *   - read OK but no WRITE (viewer user / read-only org token) → 403.
   * `write` is set by mutating routes (PUT/DELETE/append/favorite). A reader
   * route passes write=false and only the 404 branch can fire.
   */
  async function loadAuthorizedNote(req: FastifyRequest, reply: FastifyReply, write = false) {
    const { id } = req.params as { id: string };
    const note = await deps.notes.get(id);
    if (!note) {
      fail(req, reply, 404, 'note.notFound');
      return null;
    }
    const decision = await resolveNoteAccess(req, reply, note.spaceId, write);
    return decision ? note : null;
  }

  /** Same auth check as loadAuthorizedNote, but allows soft-deleted rows.
   *  Used by /restore and /purge — `get` filters trashed rows out so they
   *  can't be loaded through the normal helper. Both are writes. */
  async function loadAuthorizedTrashedNote(req: FastifyRequest, reply: FastifyReply, write = true) {
    const { id } = req.params as { id: string };
    const note = await deps.notes.getIncludingTrashed(id);
    if (!note) {
      fail(req, reply, 404, 'note.notFound');
      return null;
    }
    const decision = await resolveNoteAccess(req, reply, note.spaceId, write);
    return decision ? note : null;
  }

  /**
   * Shared note-space access decision with the right status code:
   *   - write requested + caller can write (admin/editor, org-admin escalation,
   *     or org token with write scope) → ok.
   *   - write requested + caller can only read (viewer / read-only token) → 403.
   *   - no access at all → 404 (don't leak existence).
   * `write` implies read, so a writer never needs a separate membership check.
   */
  async function resolveNoteAccess(
    req: FastifyRequest,
    reply: FastifyReply,
    spaceId: string,
    write: boolean,
  ): Promise<boolean> {
    if (write) {
      if (await hasSpaceAccess(req, spaceId, true)) return true;
      // No write — distinguish "you can read but not write" (403) from "you
      // can't see this at all" (404).
      if (await hasSpaceAccess(req, spaceId, false)) {
        fail(req, reply, 403, 'space.noWriteAccess');
      } else {
        fail(req, reply, 404, 'note.notFound');
      }
      return false;
    }
    if (await hasSpaceAccess(req, spaceId, false)) return true;
    fail(req, reply, 404, 'note.notFound');
    return false;
  }

  // ── Authorisation helpers ──────────────────────────────────────────────
  async function requireOrgRole(
    req: FastifyRequest,
    reply: FastifyReply,
    orgId: string,
    allowed: readonly OrgRole[],
  ): Promise<OrgRole | null> {
    const role = await deps.organizations.roleOf(orgId, uid(req));
    if (!role) {
      fail(req, reply, 404, 'org.notFound');
      return null;
    }
    if (!allowed.includes(role)) {
      fail(req, reply, 403, 'workspace.requiresRole', { roles: allowed.join(', ') });
      return null;
    }
    return role;
  }

  /**
   * Returns the caller's effective role for a workspace, or null + a 403
   * reply if they can't do the operation.
   *
   * Effective role escalation: an org admin / org_admin is implicitly
   * treated as workspace admin for any workspace inside their org, even if
   * their direct membership is missing OR carries a lower role (or a legacy
   * value like 'owner' from pre-v4.1 installs).
   */
  async function requireWorkspaceRole(
    req: FastifyRequest,
    reply: FastifyReply,
    spaceId: string,
    allowed: readonly WorkspaceRole[],
  ): Promise<WorkspaceRole | null> {
    const directRole = (await deps.spaces.role(spaceId, uid(req))) as WorkspaceRole | null;
    let effective: WorkspaceRole | null = directRole;
    // If the direct role isn't sufficient, see if the user is an org admin
    // and can act with workspace-admin authority.
    if (!effective || !allowed.includes(effective)) {
      const space = await deps.spaces.findById(spaceId);
      if (space) {
        const orgRole = await deps.organizations.roleOf(space.orgId, uid(req));
        if (orgRole === 'org_admin') effective = 'admin';
      }
    }
    if (!effective) {
      fail(req, reply, 403, 'workspace.noAccess');
      return null;
    }
    if (!allowed.includes(effective)) {
      fail(req, reply, 403, 'workspace.requiresRole', { roles: allowed.join(', ') });
      return null;
    }
    return effective;
  }

  // ── Search configuration, per organization ──────────────────────────────
  // Reading is open to any member (the client needs the defaults it will be
  // searching under); writing is an admin action, because it changes how
  // search behaves for everyone in the org.
  app.get('/api/organizations/:orgId/search-config', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    if (!(await requireOrgRole(req, reply, orgId, ORG_ROLES))) return reply;
    if (!deps.orgSettings) return { ...DEFAULT_SEARCH_CONFIG };
    return deps.orgSettings.getSearchConfig(orgId);
  });

  app.put('/api/organizations/:orgId/search-config', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    if (!(await requireOrgRole(req, reply, orgId, ['org_admin']))) return reply;
    if (!deps.orgSettings) return fail(req, reply, 404, 'common.invalidRequest');
    const { mode, topK } = (req.body ?? {}) as { mode?: string; topK?: number };
    if (mode !== 'hybrid' && mode !== 'keyword' && mode !== 'semantic') {
      return fail(req, reply, 400, 'search.invalidMode');
    }
    if (!Number.isInteger(topK) || topK! < 1 || topK! > MAX_SEARCH_TOP_K) {
      return fail(req, reply, 400, 'search.invalidTopK', { max: MAX_SEARCH_TOP_K });
    }
    await deps.orgSettings.setSearchConfig(orgId, { mode, topK: topK! });
    await deps.audit?.record({
      orgId,
      actorId: uid(req),
      action: 'admin.search.configured',
      resource: `org:${orgId}`,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
      metadata: { mode, topK },
    });
    return { ok: true, mode, topK };
  });

  // ── Organizations ───────────────────────────────────────────────────────
  app.get('/api/organizations', async (req) => deps.organizations.listForUser(uid(req)));

  app.post('/api/organizations', async (req, reply) => {
    // Local mode is single-tenant by design: one org, no add. Creating new
    // organizations only makes sense in server mode (multi-user / multi-tenant).
    if (deps.info?.authMode !== 'server') {
      return reply.code(403).send({ error: 'organization creation requires server mode' });
    }
    // ADR-005: creating a tenant is an instance-wide act. On an installation
    // shared by organisations that do not trust each other, one tenant's
    // admin must not be able to add another — and whoever runs the
    // installation is the one who can.
    if (!(await requireSetupAdmin(req, reply))) return reply;
    const { name, slug } = (req.body ?? {}) as { name?: string; slug?: string };
    if (!name?.trim()) return fail(req, reply, 400, 'common.nameRequired');
    const finalSlug = (slug?.trim() ?? slugify(name)) || slugify(name);
    return reply
      .code(201)
      .send(await deps.organizations.create(name.trim(), finalSlug, uid(req)));
  });

  app.get('/api/organizations/:orgId', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    if (!(await requireOrgRole(req, reply, orgId, ORG_ROLES))) return reply;
    return deps.organizations.findById(orgId);
  });

  app.put('/api/organizations/:orgId', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    if (!(await requireOrgRole(req, reply, orgId, ['org_admin']))) return reply;
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return fail(req, reply, 400, 'common.nameRequired');
    await deps.organizations.rename(orgId, name.trim());
    return { ok: true };
  });

  app.delete('/api/organizations/:orgId', async (req, reply) => {
    // Local mode forbids deleting the single org — it would leave the user
    // without any landing context. Only server mode exposes this destructive op.
    if (deps.info?.authMode !== 'server') {
      return reply.code(403).send({ error: 'organization deletion requires server mode' });
    }
    const { orgId } = req.params as { orgId: string };
    if (!(await requireOrgRole(req, reply, orgId, ['org_admin']))) return reply;
    await deps.organizations.delete(orgId);
    return { ok: true };
  });

  // ── Organization members ────────────────────────────────────────────────
  app.get('/api/organizations/:orgId/members', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    if (!(await requireOrgRole(req, reply, orgId, ORG_ROLES))) return reply;
    return deps.organizations.members(orgId);
  });

  app.post('/api/organizations/:orgId/members', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const callerRole = await requireOrgRole(req, reply, orgId, ['org_admin']);
    if (!callerRole) return reply;
    const { email, role } = (req.body ?? {}) as { email?: string; role?: string };
    if (!email?.trim()) return fail(req, reply, 400, 'auth.emailRequired');
    const r = role ?? 'org_member';
    if (!isOrgRole(r)) return fail(req, reply, 400, 'role.invalid', { role: r });
    // Only org_admins can mint new org_admins.
    if (r === 'org_admin' && callerRole !== 'org_admin') {
      return reply.code(403).send({ error: 'requires one of: org_admin' });
    }
    const invitee = await deps.users.ensureByEmail(email.trim().toLowerCase());
    // This POST is an upsert (addOrUpdateMember), so it can demote an existing
    // member — guard the orphan case the same way PUT does, atomically.
    const outcome = await deps.organizations.demoteMemberGuarded(orgId, invitee.id, r);
    if (outcome === 'would_orphan') {
      return fail(req, reply, 409, 'org.lastAdminDemote');
    }
    return reply.code(201).send({ ok: true, userId: invitee.id, role: r });
  });

  app.put('/api/organizations/:orgId/members/:userId', async (req, reply) => {
    const { orgId, userId } = req.params as { orgId: string; userId: string };
    const callerRole = await requireOrgRole(req, reply, orgId, ['org_admin']);
    if (!callerRole) return reply;
    const { role } = (req.body ?? {}) as { role?: string };
    if (!role || !isOrgRole(role)) return reply.code(400).send({ error: 'invalid role' });
    // ADR-005 left one administrative role, so the old target-role checks
    // ("an admin may not demote a super_admin") are gone with the distinction
    // they enforced. What protects the organisation is the orphan guard below:
    // any org_admin may demote any other, and none of them may leave the
    // organisation with nobody able to administer it.
    // Atomic demote + orphan guard (races: two concurrent demotes can't both
    // pass, see demoteMemberGuarded).
    const outcome = await deps.organizations.demoteMemberGuarded(orgId, userId, role);
    if (outcome === 'would_orphan') {
      return fail(req, reply, 409, 'org.lastAdminDemote');
    }
    return { ok: true };
  });

  app.delete('/api/organizations/:orgId/members/:userId', async (req, reply) => {
    const { orgId, userId } = req.params as { orgId: string; userId: string };
    const callerRole = await requireOrgRole(req, reply, orgId, ['org_admin']);
    if (!callerRole) return reply;
    // Same as the demote path: one administrative role, so the orphan guard
    // is the whole rule.
    // Atomic remove + orphan guard.
    const outcome = await deps.organizations.removeMemberGuarded(orgId, userId);
    if (outcome === 'would_orphan') {
      return fail(req, reply, 409, 'org.lastAdminRemove');
    }
    return { ok: true };
  });

  // ── Spaces (workspaces) ─────────────────────────────────────────────────
  // Spaces the caller can reach: a user sees the workspaces they're a member
  // of; an ORG token sees every space inside its org (its reach isn't gated by
  // per-space membership).
  async function listAccessibleSpaces(req: FastifyRequest) {
    const id = req.identity!;
    return id.kind === 'user'
      ? deps.spaces.listForUser(id.userId)
      : deps.spaces.listForOrg(id.orgId);
  }

  app.get('/api/spaces', async (req) => listAccessibleSpaces(req));

  app.get('/api/organizations/:orgId/workspaces', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const role = await requireOrgRole(req, reply, orgId, ORG_ROLES);
    if (!role) return reply;
    // Members see only the workspaces they have access to; admins see all.
    return role === 'org_member'
      ? deps.spaces.listForUserInOrg(uid(req), orgId)
      : deps.spaces.listForOrg(orgId);
  });

  app.post('/api/spaces', async (req, reply) => {
    const { name, orgId } = (req.body ?? {}) as { name?: string; orgId?: string };
    if (!name?.trim()) return fail(req, reply, 400, 'common.nameRequired');
    // If orgId is omitted, fall back to the user's first org (typical for
    // single-org installs and the legacy single-user core).
    let targetOrg = orgId;
    if (!targetOrg) {
      const orgs = await deps.organizations.listForUser(uid(req));
      if (orgs.length === 0)
        return fail(req, reply, 400, 'org.noneCreateFirst');
      targetOrg = orgs[0].id;
    }
    // Creating a workspace is an admin action — enforce the role on BOTH paths.
    // The implicit "first org" fallback used to skip this, letting a plain
    // member spin up workspaces in an org they only belong to.
    if (!(await requireOrgRole(req, reply, targetOrg, ['org_admin']))) return reply;
    return reply.code(201).send(await deps.spaces.create(targetOrg, name.trim(), uid(req)));
  });

  app.put('/api/spaces/:spaceId', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireWorkspaceRole(req, reply, spaceId, ['admin']))) return reply;
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return fail(req, reply, 400, 'common.nameRequired');
    await deps.spaces.rename(spaceId, name.trim());
    return { ok: true };
  });

  app.delete('/api/spaces/:spaceId', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireWorkspaceRole(req, reply, spaceId, ['admin']))) return reply;
    await deps.spaces.delete(spaceId);
    return { ok: true };
  });

  // ── Workspace members ───────────────────────────────────────────────────
  app.get('/api/spaces/:spaceId/members', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireWorkspaceRole(req, reply, spaceId, WS_ROLES))) return reply;
    return deps.spaces.members(spaceId);
  });

  app.post('/api/spaces/:spaceId/members', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireWorkspaceRole(req, reply, spaceId, ['admin']))) return reply;
    const { email, role } = (req.body ?? {}) as { email?: string; role?: string };
    if (!email?.trim()) return fail(req, reply, 400, 'auth.emailRequired');
    const r = role ?? 'editor';
    if (!isWorkspaceRole(r)) return fail(req, reply, 400, 'role.invalid', { role: r });
    const invitee = await deps.users.ensureByEmail(email.trim().toLowerCase());
    await deps.spaces.addOrUpdateMember(spaceId, invitee.id, r);
    return reply.code(201).send({ ok: true, userId: invitee.id, role: r });
  });

  app.put('/api/spaces/:spaceId/members/:userId', async (req, reply) => {
    const { spaceId, userId } = req.params as { spaceId: string; userId: string };
    if (!(await requireWorkspaceRole(req, reply, spaceId, ['admin']))) return reply;
    const { role } = (req.body ?? {}) as { role?: string };
    if (!role || !isWorkspaceRole(role)) return reply.code(400).send({ error: 'invalid role' });
    await deps.spaces.addOrUpdateMember(spaceId, userId, role);
    return { ok: true };
  });

  app.delete('/api/spaces/:spaceId/members/:userId', async (req, reply) => {
    const { spaceId, userId } = req.params as { spaceId: string; userId: string };
    if (!(await requireWorkspaceRole(req, reply, spaceId, ['admin']))) return reply;
    await deps.spaces.removeMember(spaceId, userId);
    return { ok: true };
  });

  // --- Notes ---
  app.get('/api/spaces/:spaceId/notes', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const q = req.query as { tag?: unknown; folder?: unknown };
    const tag = firstStr(q.tag);
    const folder = firstStr(q.folder);
    let notes = await deps.notes.list(spaceId);
    if (tag) {
      const ids = new Set(await deps.tags.noteIdsByTag(spaceId, tag));
      notes = notes.filter((n) => ids.has(n.id));
    }
    if (folder !== undefined) {
      const target = folder === 'root' ? null : folder;
      notes = notes.filter((n) => n.folderId === target);
    }
    // Freshness comes with the list, not only with the detail: the web app
    // reads notes out of this payload, so a field present only on
    // GET /api/notes/:id was wired in the API and invisible in the product —
    // which is what a live check caught after the integration tests passed.
    // One batch query for the whole page, not one per note.
    return withFreshness(notes);
  });

  // Space tags (with usage count)
  app.get('/api/spaces/:spaceId/tags', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    return deps.tags.listForSpace(spaceId);
  });

  // Space graph (nodes + edges)
  app.get('/api/spaces/:spaceId/graph', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    return deps.links.graph(spaceId);
  });

  /** Postgres `unique_violation`, however deep the driver wrapped it. */
  function isUniqueViolation(e: unknown): boolean {
    for (let cur: unknown = e, depth = 0; cur && depth < 5; depth += 1) {
      if (typeof cur === 'object' && (cur as { code?: string }).code === '23505') return true;
      cur = (cur as { cause?: unknown }).cause;
    }
    return false;
  }

  app.post('/api/spaces/:spaceId/notes', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireWriteSpace(req, reply, spaceId))) return reply;
    const { title, contentMd, folderId } = (req.body ?? {}) as {
      title?: string;
      contentMd?: string;
      folderId?: string | null;
    };
    if (typeof title !== 'string' || !title.trim()) {
      return reply.code(400).send({ error: 'title required' });
    }
    if (contentMd !== undefined && typeof contentMd !== 'string') {
      return reply.code(400).send({ error: 'contentMd must be a string' });
    }
    // A folderId from the body must belong to THIS space — otherwise a member
    // of space A could file a note under a folder of space B (IDOR).
    if (folderId != null && (await deps.folders.spaceOf(folderId)) !== spaceId) {
      return fail(req, reply, 400, 'folder.wrongSpace');
    }
    let created;
    try {
      created = await deps.notes.create(
        { spaceId, title, contentMd, folderId },
        attributionOf(req, 'rest'),
      );
    } catch (e: unknown) {
      // Live titles are unique per space (migration 0020, so following a
      // wikilink twice cannot race into two notes). A caller reusing a title
      // is a request problem, not a server one: without this the unique
      // violation escaped as a 500 saying "internal server error", which
      // tells the person nothing about the one thing they can fix.
      if (isUniqueViolation(e)) return fail(req, reply, 409, 'note.titleTaken');
      throw e;
    }
    await auditOrgWrite(req, 'note.created', `note:${created.id}`);
    return reply.code(201).send(created);
  });

  app.get('/api/notes/:id', async (req, reply) => {
    const note = await loadAuthorizedNote(req, reply);
    if (!note) return reply;
    // Freshness rides along on the note (ADR-002) rather than sitting behind
    // its own endpoint: opening a note is exactly when "is this still good?"
    // is worth answering, and a second round trip is a second chance for the
    // answer not to arrive. Absent when no cadence source is wired — the
    // field is optional so "not measured" stays distinguishable from "fresh".
    const freshness = await freshnessOf(note);
    return freshness ? { ...note, freshness } : note;
  });

  app.put('/api/notes/:id', async (req, reply) => {
    const note = await loadAuthorizedNote(req, reply, true);
    if (!note) return reply;
    const body = (req.body ?? {}) as {
      title?: string;
      contentMd?: string;
      folderId?: string | null;
    };
    if (body.title !== undefined && typeof body.title !== 'string') {
      return reply.code(400).send({ error: 'title must be a string' });
    }
    if (body.contentMd !== undefined && typeof body.contentMd !== 'string') {
      return reply.code(400).send({ error: 'contentMd must be a string' });
    }
    // Reparenting into a folder must stay inside the note's own space.
    if (
      body.folderId != null &&
      (await deps.folders.spaceOf(body.folderId)) !== note.spaceId
    ) {
      return fail(req, reply, 400, 'folder.wrongSpace');
    }
    // Same rationale as /append below: a direct DB write to content_md would
    // be overwritten by the next onStoreDocument flush of a live Y.Doc, so
    // the body replace goes through applyServerEdit when collab is available.
    if (deps.collab && body.contentMd !== undefined) {
      const { contentMd, ...rest } = body;
      // applyServerEdit RETURNS the markdown actually applied to the live
      // Y.Text. Prefer it over re-reading content_md: while a live doc owns the
      // note, the DB column lags the debounced onStoreDocument flush, so a
      // re-read would hand the client stale text right after their own edit.
      const applied = await applyServerEdit(
        {
          auth: deps.auth,
          notes: deps.collab.notesRepo,
          yjs: deps.collab.yjs,
          indexer: deps.collab.indexer,
        },
        note.id,
        (text) => replaceWholeText(text, contentMd),
        deps.collab.hocuspocus as unknown as { documents: Map<string, { name: string }> },
        attributionOf(req, 'rest'),
      );
      // Apply any non-content fields (title / folder) in the DB too.
      const base =
        Object.keys(rest).length > 0
          ? await deps.notes.update(note.id, rest, attributionOf(req, 'rest'))
          : note;
      // Return the row with the authoritative, just-applied markdown.
      return { ...(base ?? note), contentMd: applied };
    }
    return deps.notes.update(note.id, body, attributionOf(req, 'rest'));
  });

  app.delete('/api/notes/:id', async (req, reply) => {
    // SOFT delete (alpha.43). The row moves to trash and is excluded from
    // listings + search; use POST /api/notes/:id/restore to un-trash or
    // DELETE /api/notes/:id/purge to actually drop it.
    const note = await loadAuthorizedNote(req, reply, true);
    if (!note) return reply;
    await deps.notes.delete(note.id);
    await auditOrgWrite(req, 'note.deleted', `note:${note.id}`);
    return { ok: true };
  });

  // ── Version history ───────────────────────────────────────────────────
  // Snapshots of what the note USED to say (NotesService records one before
  // every content-changing save). Read access mirrors the note's own; restore
  // is a write — and lands as a new save, so history is append-only.
  // The three routes carry an explicit budget on top of the authorisation.
  // Every one of them is already behind `loadAuthorizedNote`, so this is
  // defence in depth rather than the primary control — but a note with a
  // hundred snapshots makes the list a cheap way to pull a lot of text with
  // one valid session, and restore is a write that re-indexes and broadcasts.
  app.get(
    '/api/notes/:id/versions',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const note = await loadAuthorizedNote(req, reply);
      if (!note) return reply;
      return deps.notes.listVersions(note.id);
    },
  );

  app.get(
    '/api/notes/:id/versions/:versionId',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const note = await loadAuthorizedNote(req, reply);
      if (!note) return reply;
      const { versionId } = req.params as { versionId: string };
      const version = await deps.notes.getVersion(versionId);
      if (!version || version.noteId !== note.id) {
        return reply.code(404).send({ error: 'version not found' });
      }
      return version;
    },
  );

  app.post('/api/notes/:id/versions/:versionId/restore', {
    // Lower than the reads: a restore rewrites the note through
    // `applyServerEdit`, re-indexes it and broadcasts to every connected
    // editor. No human restores twenty times a minute.
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const note = await loadAuthorizedNote(req, reply, true);
    if (!note) return reply;
    const { versionId } = req.params as { versionId: string };
    const version = await deps.notes.getVersion(versionId);
    if (!version || version.noteId !== note.id) {
      return reply.code(404).send({ error: 'version not found' });
    }
    // Same rationale as PUT above: while a live Y.Doc owns the note, a
    // direct DB write is overwritten by the next onStoreDocument flush — a
    // restore that bypassed the doc looked like "nothing happened" and then
    // silently reverted (found live). Through applyServerEdit the live doc
    // (and every connected editor) adopts the restored text immediately.
    if (deps.collab) {
      const applied = await applyServerEdit(
        {
          auth: deps.auth,
          notes: deps.collab.notesRepo,
          yjs: deps.collab.yjs,
          indexer: deps.collab.indexer,
        },
        note.id,
        (text) => replaceWholeText(text, version.contentMd),
        deps.collab.hocuspocus as unknown as { documents: Map<string, { name: string }> },
      );
      await auditOrgWrite(req, 'note.version_restored', `note:${note.id}`);
      return { ...note, contentMd: applied };
    }
    const restored = await deps.notes.restoreVersion(note.id, versionId);
    if (!restored) return reply.code(404).send({ error: 'version not found' });
    await auditOrgWrite(req, 'note.version_restored', `note:${note.id}`);
    return restored;
  });

  // ── Trash bin ─────────────────────────────────────────────────────────
  app.get('/api/spaces/:id/trash', async (req, reply) => {
    const { id: spaceId } = req.params as { id: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const items = await deps.notes.listDeleted(spaceId);
    return items.map((n) => ({
      id: n.id,
      title: n.title,
      folderId: n.folderId,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    }));
  });

  app.post('/api/notes/:id/restore', async (req, reply) => {
    const note = await loadAuthorizedTrashedNote(req, reply);
    if (!note) return reply;
    const restored = await deps.notes.restore(note.id);
    if (!restored) {
      return reply.code(409).send({ error: 'note is not in trash' });
    }
    return { ok: true, note: restored };
  });

  app.delete('/api/notes/:id/purge', async (req, reply) => {
    const note = await loadAuthorizedTrashedNote(req, reply);
    if (!note) return reply;
    const purged = await deps.notes.purge(note.id);
    if (!purged) {
      return reply
        .code(409)
        .send({ error: 'note must be in trash before purging — delete it first' });
    }
    return { ok: true };
  });

  app.delete('/api/spaces/:id/trash', async (req, reply) => {
    const { id: spaceId } = req.params as { id: string };
    if (!(await requireWriteSpace(req, reply, spaceId))) return reply;
    const purged = await deps.notes.purgeTrashForSpace(spaceId);
    return { ok: true, purged };
  });

  // Backlinks: notes that link to this one
  app.get('/api/notes/:id/backlinks', async (req, reply) => {
    const note = await loadAuthorizedNote(req, reply);
    if (!note) return reply;
    const ids = new Set(await deps.links.backlinkIds(note.spaceId, note.title));
    const all = await deps.notes.list(note.spaceId);
    return all.filter((n) => ids.has(n.id)).map((n) => ({ id: n.id, title: n.title }));
  });

  /**
   * "Notes semantically close to this one." Returns up to `limit` neighbours
   * ranked by pgvector cosine distance on chunk embeddings, excluding the
   * source note itself. Powers the Neighbors panel in the editor.
   *
   * Each result carries the `distance` (0..2, smaller = closer) so the UI
   * can render a relevance hint.
   */
  app.get(
    '/api/notes/:id/related',
    // A vector scan per call — the same cost class as /api/search, so the
    // same budget. Generous for a human opening notes, a cap on a loop.
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
    const note = await loadAuthorizedNote(req, reply);
    if (!note) return reply;
    const limit = Number((req.query as { limit?: string }).limit ?? 10);
    const rows = await deps.search.related(note.spaceId, note.id, Math.min(Math.max(limit, 1), 50));
    const byId = new Map((await deps.notes.list(note.spaceId)).map((n) => [n.id, n] as const));
    return rows
      .map((r) => {
        const n = byId.get(r.noteId);
        if (!n) return null;
        return { id: n.id, title: n.title, distance: r.distance };
      })
      .filter((r): r is { id: string; title: string; distance: number } => r !== null);
  });

  // Append: add content at the end (so the AI can "jot" into a note).
  //
  // When collab is enabled and ≥1 client is connected to this note's Y.Doc,
  // the append goes through `applyServerEdit` → Hocuspocus DirectConnection
  // → broadcast to connected editors. With no live doc (collab off, or
  // nobody connected), it falls back to the DB update path the rest of the
  // app uses.
  app.post(
    '/api/notes/:id/append',
    // Every append is a write plus a re-index (chunks, embeddings, tags).
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
    const note = await loadAuthorizedNote(req, reply, true);
    if (!note) return reply;
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content?.trim()) return fail(req, reply, 400, 'note.contentRequired');
    await auditOrgWrite(req, 'note.appended', `note:${note.id}`);
    if (deps.collab) {
      await applyServerEdit(
        {
          auth: deps.auth,
          notes: deps.collab.notesRepo,
          yjs: deps.collab.yjs,
          indexer: deps.collab.indexer,
        },
        note.id,
        (text) => {
          const sep = text.length > 0 ? '\n' : '';
          text.insert(text.length, `${sep}${content}`);
        },
        deps.collab.hocuspocus as unknown as { documents: Map<string, { name: string }> },
      );
      // Return the fresh row so the caller sees the new contentMd.
      const fresh = await deps.notes.get(note.id);
      return fresh ?? note;
    }
    const next = note.contentMd ? `${note.contentMd}\n${content}` : content;
    return deps.notes.update(note.id, { contentMd: next }, attributionOf(req, 'rest'));
  });

  // --- Search ---
  app.post(
    '/api/search',
    {
      // Search fans out to pgvector + keyword scans; 60/min/IP is generous for
      // a human typing but caps a script hammering the embedder.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
    const { query, spaceId, topK } = (req.body ?? {}) as {
      query?: string;
      spaceId?: string;
      topK?: number;
    };
    let space = spaceId;
    if (!space) space = (await listAccessibleSpaces(req))[0]?.id;
    if (!space) return [];
    if (!(await requireReadSpace(req, reply, space))) return reply;
    // The org's configuration is the DEFAULT, and an explicit request still
    // wins — a caller asking for `keyword` gets keyword. Before this, the
    // control lived in the admin console and wrote to that browser's
    // localStorage, so an admin configured their laptop while believing they
    // were configuring the organisation.
    const orgCfg = await searchConfigFor(space);
    const requested = (req.body as { mode?: 'hybrid' | 'keyword' | 'semantic' })?.mode;
    const mode = requested ?? orgCfg.mode;
    // Clamp topK to 1..50, same bounds as /related — an unbounded value
    // would let a single request fan out into an arbitrarily large scan.
    const k = Math.min(Math.max(Number(topK ?? orgCfg.topK) || orgCfg.topK, 1), 50);
    return deps.search.search(space, query ?? '', k, mode);
  });

  // Instance info (embeddings provider + version + authenticated user)
  app.get('/api/info', async (req) => {
    const base = deps.info ?? { embedder: 'local', version: '0.1.0' };
    // An org token has no user — report null rather than throwing 403, so an
    // unattended client can still read instance info (version/embedder).
    const userId = identityUserId(req.identity!);
    const user = userId ? await deps.users.findById(userId) : null;
    return { ...base, user: user ? { email: user.email } : null };
  });

  app.get('/api/update/check', async (req) => {
    // Reads the latest release straight from the GitHub Releases API. This
    // avoids any "latest.json" file on main (which would force the release
    // workflow to push to a protected branch).
    const current = deps.info?.version ?? '0.0.0';
    const url =
      process.env.DILUXITE_LATEST_RELEASE_URL ??
      'https://api.github.com/repos/soydiloreto/diluxite-core-alpha/releases/latest';
    try {
      const res = await fetch(url, {
        headers: {
          'cache-control': 'no-cache',
          accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { current, latest: null, hasUpdate: false, error: `HTTP ${res.status}` };
      const remote = (await res.json()) as {
        tag_name: string;
        html_url?: string;
        published_at?: string;
      };
      const latest = remote.tag_name.replace(/^v/, '');
      return {
        current,
        latest,
        hasUpdate: isNewer(latest, current),
        releaseNotesUrl: remote.html_url ?? null,
        releasedAt: remote.published_at ?? null,
      };
    } catch (e) {
      // Generic error to the client; details only in the server log.
      req.log.error({ err: e }, 'update check failed');
      return { current, latest: null, hasUpdate: false, error: 'update check failed' };
    }
  });

  // Space stats (for the home + settings)
  /**
   * The workspace as a folder of Markdown files.
   *
   * Data portability, not a backup: what comes out is the note's own Markdown
   * in the folder tree it was written in, which Obsidian, VS Code and `grep`
   * read with no importer. The previous export was a JSON dump of the API's
   * own objects built in the browser — a shape only Diluxite understands, and
   * one that had to fit in a tab's memory first.
   *
   * Reader access is enough: anyone who can read every note in the space can
   * already copy them out one by one. Trashed notes stay out — they are in
   * Trash, and restoring is what un-deletes them.
   */
  app.get('/api/spaces/:spaceId/export.zip', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;

    const [notes, folders] = await Promise.all([
      deps.notes.list(spaceId),
      deps.folders.list(spaceId),
    ]);
    const files = exportWorkspace(notes, folders);

    // Built in memory: the corpus is text, and the installs Core targets fit
    // comfortably. A million-note workspace would want a stream, and that is
    // a different endpoint with a different shape.
    const encoder = new TextEncoder();
    const tree: Record<string, [Uint8Array, { mtime: Date }]> = {};
    for (const f of files) tree[f.path] = [encoder.encode(f.content), { mtime: f.modified }];
    const zip = zipSync(tree, { level: 6 });

    const space = await deps.spaces.findById(spaceId);
    const name = `${safeSegment(space?.name ?? 'workspace', 'workspace')}.zip`;
    return reply
      .header('content-type', 'application/zip')
      // The filename is user data. `filename*` carries the UTF-8 original and
      // the plain `filename` is the ASCII fallback, with quotes and
      // backslashes stripped so neither can break out of the header.
      .header(
        'content-disposition',
        `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')}"; ` +
          `filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .send(Buffer.from(zip));
  });

  app.get('/api/spaces/:spaceId/stats', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const [g, tags] = await Promise.all([
      deps.links.graph(spaceId),
      deps.tags.listForSpace(spaceId),
    ]);
    return { notes: g.nodes.length, links: g.edges.length, tags: tags.length };
  });

  // --- Folders (hierarchical tree per space) ---
  async function authorizeFolder(
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
    write = true,
  ): Promise<string | null> {
    const space = await deps.folders.spaceOf(id);
    if (!space) {
      fail(req, reply, 404, 'note.notFound');
      return null;
    }
    // Same status semantics as note access: writer (incl. org-admin escalation)
    // → ok; reader → 403 on a write; no access → 404.
    return (await resolveNoteAccess(req, reply, space, write)) ? space : null;
  }

  app.get('/api/spaces/:spaceId/folders', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    return deps.folders.list(spaceId);
  });

  app.post('/api/spaces/:spaceId/folders', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireWriteSpace(req, reply, spaceId))) return reply;
    const { name, parentId } = (req.body ?? {}) as { name?: string; parentId?: string | null };
    if (!name?.trim()) return fail(req, reply, 400, 'common.nameRequired');
    return reply.code(201).send(await deps.folders.create(spaceId, name.trim(), parentId ?? null));
  });

  app.put('/api/folders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await authorizeFolder(req, reply, id))) return reply;
    const { name, parentId } = (req.body ?? {}) as { name?: string; parentId?: string | null };
    if (name !== undefined && typeof name !== 'string') {
      return reply.code(400).send({ error: 'name must be a string' });
    }
    let result = null;
    if (name !== undefined) result = await deps.folders.rename(id, name);
    if (parentId !== undefined) result = await deps.folders.move(id, parentId);
    return result ?? reply.code(400).send({ error: 'name or parentId required' });
  });

  app.delete('/api/folders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await authorizeFolder(req, reply, id))) return reply;
    await deps.folders.delete(id);
    return { ok: true };
  });

  // --- Bulk move (multi-select): notes + folders → one destination, atomic ---
  // Scoped to the space so a single write-authz check covers the whole batch;
  // the repo additionally scopes every UPDATE to spaceId (defence in depth) and
  // rejects folder cycles, rolling the transaction back as a unit.
  app.post('/api/spaces/:spaceId/move', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireWriteSpace(req, reply, spaceId))) return reply;
    const body = (req.body ?? {}) as {
      targetFolderId?: string | null;
      noteIds?: unknown;
      folderIds?: unknown;
    };
    const targetFolderId = body.targetFolderId ?? null;
    if (targetFolderId !== null && typeof targetFolderId !== 'string') {
      return reply.code(400).send({ error: 'targetFolderId must be a string or null' });
    }
    const isStringArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === 'string');
    const noteIds = body.noteIds === undefined ? [] : body.noteIds;
    const folderIds = body.folderIds === undefined ? [] : body.folderIds;
    if (!isStringArray(noteIds) || !isStringArray(folderIds)) {
      return reply.code(400).send({ error: 'noteIds and folderIds must be arrays of strings' });
    }
    if (noteIds.length === 0 && folderIds.length === 0) {
      return reply.code(400).send({ error: 'nothing to move' });
    }
    // A non-null destination must be a folder of THIS space (IDOR guard).
    if (targetFolderId !== null && (await deps.folders.spaceOf(targetFolderId)) !== spaceId) {
      return reply.code(400).send({ error: 'target folder does not belong to this space' });
    }
    try {
      const result = await deps.move.moveItems({ spaceId, targetFolderId, noteIds, folderIds });
      await auditOrgWrite(req, 'items.moved', `space:${spaceId}`);
      return result;
    } catch (e) {
      if (e instanceof FolderCycleError) {
        return reply.code(409).send({ error: e.message });
      }
      throw e;
    }
  });

  // --- Favourite toggle ---
  app.put('/api/notes/:id/favorite', async (req, reply) => {
    const note = await loadAuthorizedNote(req, reply, true);
    if (!note) return reply;
    const { favorite } = (req.body ?? {}) as { favorite?: boolean };
    if (typeof favorite !== 'boolean')
      return reply.code(400).send({ error: 'favorite boolean required' });
    return deps.notes.setFavorite(note.id, favorite);
  });

  // --- Bulk delete (per-note authorisation) ---
  /**
   * Bulk delete, authorised one note at a time.
   *
   * A caller who may touch none of them used to get `200 {deleted: 0}`, which
   * is indistinguishable from "there was nothing to delete" — a success code
   * for a request that was entirely refused. Now the answer names what
   * happened: 403 when nothing was allowed, and the count of what was skipped
   * when only part was.
   *
   * Partial success stays a 200 on purpose. Selecting twenty notes across two
   * workspaces and being refused the lot because one was out of reach is worse
   * than deleting the nineteen and saying so.
   */
  app.post('/api/notes/delete-many', async (req, reply) => {
    const { ids } = (req.body ?? {}) as { ids?: string[] };
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids required' });
    const authorized: string[] = [];
    for (const id of ids) {
      const note = await deps.notes.get(id);
      if (note && (await hasSpaceAccess(req, note.spaceId, true))) authorized.push(id);
    }
    const refused = ids.length - authorized.length;
    if (authorized.length === 0) return fail(req, reply, 403, 'note.deleteManyRefused');
    const deleted = await deps.notes.deleteManyIds(authorized);
    return { deleted, refused };
  });

  // --- Import: a ZIP of Markdown files → notes + folders ---
  /**
   * The way in, mirroring the export.
   *
   * The archive arrives base64-encoded in the body rather than as multipart:
   * the CSV import already established that shape here, it works from `curl`
   * with `base64 vault.zip`, and it keeps the route a plain JSON handler.
   *
   * `dryRun` answers "what would this do" without writing anything — an import
   * is the one operation where finding out afterwards is expensive, and the
   * plan is exactly what the confirmation dialog needs.
   *
   * What it does NOT do: overwrite. A note whose title already exists in the
   * workspace is reported and left alone, which also makes re-running the same
   * import a no-op instead of a pile of duplicates.
   */
  app.post(
    '/api/spaces/:spaceId/import',
    {
      // Unzipping and creating N notes with their embeddings is the heaviest
      // thing a person can ask for. Five a minute is generous for a human
      // migrating a vault and caps a script.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { spaceId } = req.params as { spaceId: string };
      if (!(await requireWriteSpace(req, reply, spaceId))) return reply;
      const body = (req.body ?? {}) as {
        zipBase64?: unknown;
        dryRun?: unknown;
        format?: unknown;
      };
      if (typeof body.zipBase64 !== 'string' || body.zipBase64.length === 0) {
        return fail(req, reply, 400, 'import.zipRequired');
      }
      // Checked before decoding: 20 MB of base64 is ~15 MB of ZIP, and the
      // point of the limit is to refuse before spending the memory.
      if (body.zipBase64.length > 20 * 1024 * 1024) {
        return fail(req, reply, 413, 'import.tooLarge');
      }
      const format =
        body.format === 'obsidian' || body.format === 'notion' || body.format === 'markdown'
          ? body.format
          : undefined;

      let files: { path: string; content: string }[];
      try {
        const zip = unzipSync(Buffer.from(body.zipBase64, 'base64'));
        const decoder = new TextDecoder('utf-8', { fatal: false });
        files = Object.entries(zip)
          // A directory entry is a zero-length name ending in `/`.
          .filter(([path]) => !path.endsWith('/'))
          .map(([path, bytes]) => ({ path, content: decoder.decode(bytes) }));
      } catch {
        return fail(req, reply, 400, 'import.notAZip');
      }

      const plan = planImport(files, format);
      if (body.dryRun === true) {
        return {
          applied: false,
          format: plan.format,
          notes: plan.notes.map((n) => ({ title: n.title, folderPath: n.folderPath })),
          skipped: plan.skipped,
        };
      }

      // Existing titles, read once. Titles are unique per workspace, so a
      // collision is a failed insert; asking first turns it into a report.
      const taken = new Set((await deps.notes.list(spaceId)).map((n) => n.title.toLowerCase()));

      // Folders are created on demand, by path, and remembered — a vault with
      // four hundred notes in one folder should create that folder once.
      const existingFolders = await deps.folders.list(spaceId);
      const byPath = new Map<string, string>();
      for (const f of existingFolders) {
        // Only root-level names are resolvable without walking the tree; a
        // deeper existing folder is matched as this import builds its path.
        if (f.parentId === null) byPath.set(f.name, f.id);
      }
      const folderIdFor = async (path: string[]): Promise<string | null> => {
        let parent: string | null = null;
        let key = '';
        for (const name of path) {
          key = key === '' ? name : `${key}/${name}`;
          const known = byPath.get(key);
          if (known !== undefined) {
            parent = known;
            continue;
          }
          const created = await deps.folders.create(spaceId, name, parent);
          byPath.set(key, created.id);
          parent = created.id;
        }
        return parent;
      };

      let created = 0;
      const skipped = [...plan.skipped];
      for (const note of plan.notes) {
        if (taken.has(note.title.toLowerCase())) {
          skipped.push({ path: note.sourcePath, reason: 'a note with this title already exists' });
          continue;
        }
        const folderId = await folderIdFor(note.folderPath);
        await deps.notes.create(
          {
            spaceId,
            title: note.title,
            contentMd: note.contentMd,
            folderId,
          },
          attributionOf(req, 'rest'),
        );
        taken.add(note.title.toLowerCase());
        created++;
      }

      await auditOrgWrite(req, 'space.imported', `space:${spaceId}`);
      return { applied: true, format: plan.format, created, skipped };
    },
  );

  // --- Bulk tag (multi-select): add / remove a tag across many notes ---
  /**
   * Tagging in bulk means EDITING THE NOTES, not writing `note_tags` rows.
   *
   * Tags are derived: every save re-reads them from the body and replaces the
   * row set (`SearchService.index` → `parseTags` → `setTags`). Rows written
   * behind the text would look like the operation worked and then disappear
   * the next time somebody typed a character. So each note's markdown gets the
   * tag, through the same write path an ordinary edit takes — collab included,
   * or a live Y.Doc would flush the old text back over it.
   *
   * Authorised one note at a time, like `delete-many`, and for the same
   * reason: a selection can span workspaces. Refusing the whole batch because
   * one note is out of reach is worse than doing the rest and saying so.
   */
  app.post(
    '/api/notes/tag-many',
    // Every note in the batch is a write plus a re-index (chunks, embeddings,
    // tags), so this is the same cost as `append`, once per note.
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = (req.body ?? {}) as { ids?: unknown; add?: unknown; remove?: unknown };
      const isStringArray = (v: unknown): v is string[] =>
        Array.isArray(v) && v.every((x) => typeof x === 'string');
      if (!isStringArray(body.ids) || body.ids.length === 0) {
        return fail(req, reply, 400, 'note.tagManyIdsRequired');
      }
      const rawAdd = body.add === undefined ? [] : body.add;
      const rawRemove = body.remove === undefined ? [] : body.remove;
      if (!isStringArray(rawAdd) || !isStringArray(rawRemove)) {
        return fail(req, reply, 400, 'note.tagManyTagsInvalid');
      }
      if (rawAdd.length === 0 && rawRemove.length === 0) {
        return fail(req, reply, 400, 'note.tagManyNothingToDo');
      }
      // Validated up front, all of them: a batch that half-applies because the
      // third tag was malformed is worse than one that never started.
      const add: string[] = [];
      const remove: string[] = [];
      for (const [raw, into] of [
        ...rawAdd.map((t) => [t, add] as const),
        ...rawRemove.map((t) => [t, remove] as const),
      ]) {
        const clean = normaliseTag(raw);
        if (!clean) return fail(req, reply, 400, 'note.tagManyTagsInvalid', { tag: raw });
        into.push(clean);
      }

      let updated = 0;
      let unchanged = 0;
      let authorised = 0;
      for (const id of body.ids) {
        const note = await deps.notes.get(id);
        if (!note || !(await hasSpaceAccess(req, note.spaceId, true))) continue;
        authorised++;
        let next = note.contentMd ?? '';
        for (const t of add) next = addTagToMarkdown(next, t);
        for (const t of remove) next = removeTagFromMarkdown(next, t);
        // Unchanged notes are left alone rather than re-saved: a bulk tag runs
        // over notes that already carry it, and rewriting them would mint a
        // version and a re-index for a byte-identical body.
        if (next === (note.contentMd ?? '')) {
          unchanged++;
          continue;
        }
        if (deps.collab) {
          await applyServerEdit(
            {
              auth: deps.auth,
              notes: deps.collab.notesRepo,
              yjs: deps.collab.yjs,
              indexer: deps.collab.indexer,
            },
            note.id,
            (text) => replaceWholeText(text, next),
            deps.collab.hocuspocus as unknown as { documents: Map<string, { name: string }> },
            attributionOf(req, 'rest'),
          );
        } else {
          await deps.notes.update(note.id, { contentMd: next }, attributionOf(req, 'rest'));
        }
        updated++;
      }
      const refused = body.ids.length - authorised;
      if (authorised === 0) return fail(req, reply, 403, 'note.tagManyRefused');
      await auditOrgWrite(req, 'notes.tagged', `notes:${updated}`);
      return { updated, unchanged, refused };
    },
  );

  // --- Access tokens (to connect Claude/Copilot via MCP) ---
  app.post(
    '/api/tokens',
    {
      // Minting a long-lived bearer token is sensitive; 10/min/IP is plenty
      // for a human and caps an automated mint-flood.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
    const { name, expiresInDays } = (req.body ?? {}) as {
      name?: string;
      expiresInDays?: number | null;
    };
    const ttl =
      typeof expiresInDays === 'number' && Number.isFinite(expiresInDays) && expiresInDays > 0
        ? Math.floor(expiresInDays)
        : null;
    const { token, info } = await deps.tokens.create(
      uid(req),
      name?.trim() || 'token',
      ttl,
    );
    await deps.audit?.record({
      actorId: uid(req),
      action: 'admin.token.minted',
      resource: `token:${info.id}`,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
      metadata: { name: info.name, ttlDays: ttl },
    });
    return reply.code(201).send({ token, ...info }); // cleartext token is shown ONLY once
    },
  );

  app.get('/api/tokens', async (req) => deps.tokens.list(uid(req)));

  app.delete('/api/tokens/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deps.tokens.revoke(uid(req), id);
    if (ok) {
      await deps.audit?.record({
        actorId: uid(req),
        action: 'admin.token.revoked',
        resource: `token:${id}`,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] as string | undefined,
      });
    }
    return ok ? { ok: true } : fail(req, reply, 404, 'note.notFound');
  });

  // Panic button — revokes EVERY token of the caller. Used when the user
  // suspects credential leak (laptop stolen, password reuse spotted). Returns
  // the count so the UI can show "5 tokens revoked".
  app.post('/api/tokens/revoke-all', async (req) => {
    const revoked = await deps.tokens.revokeAllForUser(uid(req));
    await deps.audit?.record({
      actorId: uid(req),
      action: 'admin.token.revoked_all',
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
      metadata: { revoked },
    });
    return { revoked };
  });

  // --- Admin: auth_policy read/write (Fase 1.3) ---
  // GET /api/admin/orgs/:orgId/auth-policy   → { policy }
  // PUT /api/admin/orgs/:orgId/auth-policy   { policy } → { policy } on save
  //
  // Only org admin/org_admin can change it (members get 403). Members CAN
  // read it (useful for the UI to grey out the dropdown showing the current
  // value to non-admins).
  app.get('/api/admin/orgs/:orgId/auth-policy', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const role = await deps.organizations.roleOf(orgId, uid(req));
    // Non-members get 404 (not 403) — same as every other org-scoped read
    // (audit, requireOrgRole). Don't disclose the org's existence, and don't
    // let the web confuse "you're not a member" with "OIDC is off".
    if (!role) return fail(req, reply, 404, 'org.notFound');
    if (!deps.oidc) {
      // We could still answer with the DB row — but the policy only
      // matters when an external IdP is in play. Communicate clearly.
      return reply.code(404).send({ error: 'auth policy only applies in server mode' });
    }
    const policy = await deps.oidc.orgSettings.getAuthPolicy(orgId);
    return { policy };
  });

  app.put('/api/admin/orgs/:orgId/auth-policy', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const role = await deps.organizations.roleOf(orgId, uid(req));
    // Non-member → 404 (don't leak existence); member-but-not-admin → 403.
    if (!role) return fail(req, reply, 404, 'org.notFound');
    if (role !== 'org_admin') {
      return reply.code(403).send({ error: 'only org admins can change auth policy' });
    }
    if (!deps.oidc) {
      return reply.code(404).send({ error: 'auth policy only applies in server mode' });
    }
    const { policy } = (req.body ?? {}) as { policy?: string };
    if (
      policy !== 'deny_unknown' &&
      policy !== 'allow_unknown_as_member' &&
      policy !== 'pre_provisioned_only'
    ) {
      return reply.code(400).send({
        error:
          'policy must be one of: deny_unknown, allow_unknown_as_member, pre_provisioned_only',
      });
    }
    const previous = await deps.oidc.orgSettings.getAuthPolicy(orgId);
    await deps.oidc.orgSettings.setAuthPolicy(orgId, policy);
    await deps.audit?.record({
      orgId,
      actorId: uid(req),
      action: 'admin.auth_policy.changed',
      resource: `org:${orgId}`,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
      metadata: { from: previous, to: policy },
    });
    return { policy };
  });

  // --- Admin: CSV bulk import users (Fase 1.2) ---
  // Endpoint POST /api/admin/orgs/:orgId/users/import-csv
  //   body: { csv: string, dryRun?: boolean }
  //   returns: { rows: CsvUserRow[], errors: CsvParseError[],
  //              created?: number, updated?: number, skipped?: number }
  // Only org_admin / admin de la org puede importar.
  app.post(
    '/api/admin/orgs/:orgId/users/import-csv',
    {
      // CSV import is heavy (parse + N upserts). 5/min/IP — a real admin runs
      // it occasionally; this caps abuse without getting in the way.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const role = await deps.organizations.roleOf(orgId, uid(req));
    // Non-member → 404 (don't leak existence); member-but-not-admin → 403.
    if (!role) return fail(req, reply, 404, 'org.notFound');
    if (role !== 'org_admin') {
      return reply.code(403).send({ error: 'only org admins can import users' });
    }
    const { csv, dryRun } = (req.body ?? {}) as { csv?: string; dryRun?: boolean };
    if (typeof csv !== 'string') {
      return reply.code(400).send({ error: 'body.csv (string) required' });
    }
    if (csv.length > 2 * 1024 * 1024) {
      return reply.code(413).send({ error: 'CSV too large (max 2MB)' });
    }
    const { parseUsersCsv } = await import('@diluxite/core');
    const { rows, errors, separator } = parseUsersCsv(csv);

    if (dryRun) {
      return { rows, errors, separator, applied: false };
    }

    // `users` is global — one account can belong to several organisations —
    // so an unrestricted upsert by email let an admin of org B rewrite the
    // name of somebody in org A. Nothing else moved (no credentials, no
    // memberships, no access), but a person's display name is still theirs.
    //
    // The rule: touch people who are in THIS organisation, people who do not
    // exist yet, and people who belong to no organisation at all — an account
    // an earlier import created and nobody has claimed. Refuse only somebody
    // ELSE'S person, which is the actual threat.
    //
    // The "no organisation at all" case is not a loophole, it is the import's
    // own idempotency: this endpoint creates accounts without adding a
    // membership, so a stricter rule made re-running the same CSV a no-op.
    // The test suite caught that within a minute of the stricter version.
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const existing = await deps.users.findByEmail(row.email.toLowerCase());
      if (existing) {
        // Asked through a PRIVILEGED lookup, and that is the whole subtlety.
        // `deps.organizations` runs inside the request scope, where the
        // policies answer about the caller: "which organisations can I see"
        // rather than "which organisations does this person belong to". Under
        // RLS the scoped version returned nothing for somebody else's account,
        // read as "unclaimed", and allowed exactly the write this check
        // exists to refuse. The isolation suite caught it; the reasoning is
        // recorded because the check LOOKED right.
        //
        // An authorisation decision that depends on rows the caller cannot
        // read has to run where they are readable — ADR-004's auth plane.
        const theirOrgs = deps.membershipLookup
          ? await deps.membershipLookup(existing.id)
          : await deps.organizations.listForUser(existing.id);
        const somebodyElses = theirOrgs.length > 0 && !theirOrgs.some((o) => o.id === orgId);
        if (somebodyElses) {
          skipped += 1;
          continue;
        }
      }
      const r = await deps.users.upsertFromCsv({
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
      });
      if (r.outcome === 'created') created++;
      else updated++;
    }
    await deps.audit?.record({
      orgId,
      actorId: uid(req),
      action: 'admin.users.csv_imported',
      resource: `org:${orgId}`,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
      metadata: { created, updated, skipped, errors: errors.length, totalRows: rows.length },
    });
    return { rows, errors, separator, applied: true, created, updated, skipped };
    },
  );

  // --- Admin: read audit log ---
  // GET /api/admin/orgs/:orgId/audit?actorId&action&from&to&beforeId&limit
  // Members read-only (so they can see their own activity), admins see all.
  // We always scope to the org in the URL — caller cannot cross org boundaries.
  app.get('/api/admin/orgs/:orgId/audit', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const role = await deps.organizations.roleOf(orgId, uid(req));
    if (!role) {
      return fail(req, reply, 404, 'org.notFound');
    }
    if (!deps.audit) {
      return reply.code(404).send({ error: 'audit log disabled' });
    }
    const raw = req.query as Record<string, unknown>;
    const q = {
      actorId: firstStr(raw.actorId),
      action: firstStr(raw.action),
      from: firstStr(raw.from),
      to: firstStr(raw.to),
      beforeId: firstStr(raw.beforeId),
      limit: firstStr(raw.limit),
    };
    // Members only see their own events. Admins see everything in the org.
    const restrictToSelf = role !== 'org_admin';
    // Clamp limit to 1..200 (same shape as /search's topK guard) so a caller
    // can't ask for an unbounded scan; a non-numeric value falls back to the
    // repo default (undefined).
    const limitNum = q.limit ? Number(q.limit) : undefined;
    const limit =
      limitNum !== undefined && Number.isFinite(limitNum)
        ? Math.min(Math.max(Math.floor(limitNum), 1), 200)
        : undefined;
    const filters: import('@diluxite/db').ListFilters = {
      orgId,
      actorId: restrictToSelf ? uid(req) : q.actorId,
      actionPrefix: q.action,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      beforeId: q.beforeId ? Number(q.beforeId) : undefined,
      limit,
    };
    // Reject bad date / int parsing rather than silently ignore.
    if (q.from && Number.isNaN(filters.from!.getTime())) {
      return reply.code(400).send({ error: 'invalid `from` date' });
    }
    if (q.to && Number.isNaN(filters.to!.getTime())) {
      return reply.code(400).send({ error: 'invalid `to` date' });
    }
    if (q.beforeId && Number.isNaN(filters.beforeId!)) {
      return reply.code(400).send({ error: 'invalid `beforeId` (must be int)' });
    }
    const [events, total] = await Promise.all([
      deps.audit.list(filters),
      deps.audit.count(filters),
    ]);
    return { events, total };
  });

  // --- Admin: embeddings health ---
  // GET /api/admin/embeddings
  //
  // Answers the two questions an operator cannot answer today: WHICH embedder
  // is running, and whether the vectors already in the database were produced
  // by it. A mismatch makes semantic search fail with a hard pgvector error
  // (`different vector dimensions`) while keyword search keeps working — so
  // the product degrades to keyword-only and says nothing. Until now the only
  // trace was a warning printed once, at boot, into the container log.
  //
  // Admin-only: `model` and `endpoint` are the operator's own configuration,
  // and there is no reason for a member to read them. No secret crosses this
  // boundary — `describe()` has no field for one.
  app.get('/api/admin/embeddings', async (req, reply) => {
    const orgs = await deps.organizations.listForUser(uid(req));
    const targetOrg = ((req.query ?? {}) as { orgId?: string }).orgId ?? orgs[0]?.id;
    if (!targetOrg) return fail(req, reply, 400, 'common.invalidRequest');
    if (!(await requireOrgRole(req, reply, targetOrg, ['org_admin']))) return reply;

    const configured = deps.embedder?.describe?.() ?? null;
    const stats = deps.embeddingStats ? await deps.embeddingStats(targetOrg) : null;
    const live = stats?.stored.find((m) => m.state === 'active') ?? null;

    // A reindex is needed when the live model is missing vectors for chunks
    // that exist — which covers both cases that matter: a newly registered
    // model whose partition is still empty, and chunks a failing provider
    // never reached. Comparing dimensions, as this did before ADR-003, missed
    // a swap between two models that happen to share one.
    const reindexRequired = !!stats && stats.chunksWithoutEmbedding > 0;

    // The configured embedder and the live model disagree while a change is in
    // flight: the environment already names the new one, search still answers
    // from the old. Saying so is the whole point of this endpoint.
    const configuredKey = configured
      ? `${configured.provider}:${configured.model ?? 'default'}@${configured.dimensions}`
      : null;

    return {
      active: configured,
      live,
      configuredKey,
      migrationInFlight: !!live && !!configuredKey && live.key !== configuredKey,
      ...(stats ?? { stored: [], chunks: 0, chunksWithoutEmbedding: 0 }),
      reindexRequired,
    };
  });

  /**
   * Owner of the INSTALLATION — ADR-005.
   *
   * Instance-wide settings belong to whoever runs the installation, not to
   * whoever happens to administer an organisation inside it. Before ADR-005
   * there was no such role, so the bar was "admin of any organisation" — which
   * on a shared installation let one tenant change what every other tenant
   * searched with.
   *
   * A setup_admin is NOT thereby entitled to tenant data: reading an
   * organisation's notes still needs membership in it, and a test says so.
   */
  async function requireSetupAdmin(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> {
    const userId = identityUserId(req.identity!);
    if (userId && (await deps.users.isSetupAdmin(userId))) return true;
    fail(req, reply, 403, 'instance.requiresSetupAdmin');
    return false;
  }

  /** Validate a provider configuration coming off the wire. */
  function parseEmbeddingConfig(body: {
    provider?: string;
    model?: string | null;
    dimensions?: number;
    endpoint?: string | null;
  }):
    | { value: { provider: 'local' | 'ollama' | 'azure' | 'bedrock'; model: string | null; dimensions: number; endpoint: string | null } }
    | { error: string } {
    const provider = body.provider;
    if (provider !== 'local' && provider !== 'ollama' && provider !== 'azure' && provider !== 'bedrock') {
      return { error: 'provider must be one of: local, ollama, azure, bedrock' };
    }
    const dimensions = Number(body.dimensions);
    // Bounded because it becomes a pgvector column dimension and an index:
    // an absurd value is a table nobody can query rather than a slow one.
    if (!Number.isInteger(dimensions) || dimensions < 8 || dimensions > 16000) {
      return { error: 'dimensions must be an integer between 8 and 16000' };
    }
    const model = body.model?.trim() || null;
    if (provider !== 'local' && !model) return { error: `${provider} needs a model` };
    const endpoint = body.endpoint?.trim() || null;
    if (provider === 'azure' && !endpoint) return { error: 'azure needs an endpoint' };
    if (provider === 'bedrock' && !endpoint) return { error: 'bedrock needs a region' };
    return { value: { provider, model, dimensions, endpoint } };
  }

  // --- Admin: the embedding provider, chosen from the console ---
  //
  // ADR-003. Changing the model invalidates every stored vector, so this
  // endpoint deliberately does NOT flip anything: it stores the choice and
  // registers the new vector space as `building`. Search keeps answering from
  // the live model until a reindex fills the new one and it is activated.
  app.get('/api/organizations/:orgId/embeddings/config', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    // An organisation's own choice, so its own admin makes it (ADR-005). It
    // stopped being an instance setting the moment each organisation got its
    // own vector space.
    if (!(await requireOrgRole(req, reply, orgId, ['org_admin']))) return reply;
    if (!deps.embeddingConfig) return fail(req, reply, 404, 'common.invalidRequest');
    return {
      // Never the credential itself — only whether one is stored.
      config: await deps.embeddingConfig.redacted(orgId),
      // Sealing needs a passphrase, and there is deliberately no random
      // fallback: without one, a provider that needs a key cannot be saved.
      // Saying so up front beats a save that fails at the last step.
      canStoreCredentials: secretPassphrase() !== null,
    };
  });

  app.put('/api/organizations/:orgId/embeddings/config', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    if (!(await requireOrgRole(req, reply, orgId, ['org_admin']))) return reply;
    if (!deps.embeddingConfig || !deps.embeddingModels) {
      return fail(req, reply, 404, 'common.invalidRequest');
    }
    const body = (req.body ?? {}) as {
      provider?: string;
      model?: string | null;
      dimensions?: number;
      endpoint?: string | null;
      apiKey?: string | null;
    };

    const parsed = parseEmbeddingConfig(body);
    if ('error' in parsed) return fail(req, reply, 400, 'embeddings.configInvalid', { reason: parsed.error });

    let sealed: string | null | undefined;
    if (body.apiKey === undefined) sealed = undefined; // unchanged
    else if (body.apiKey === null || body.apiKey === '') sealed = null; // removed
    else {
      try {
        sealed = sealSecret(body.apiKey, secretPassphrase());
      } catch {
        return fail(req, reply, 400, 'embeddings.configInvalid', {
          reason: 'no encryption passphrase is configured (DILUXITE_SECRET_KEY)',
        });
      }
    }

    const saved = await deps.embeddingConfig.write({
      orgId,
      ...parsed.value,
      apiKeySealed: sealed,
      updatedBy: identityUserId(req.identity!) ?? undefined,
    });

    // Before anything else reads it. The memoised provider is now stale by
    // definition — including for a change as small as a new endpoint, which
    // is the one an operator expects to take effect immediately.
    deps.forgetOrgEmbedder?.(orgId);

    // Register the vector space so it exists to be filled. `ensureRegistered`
    // keeps the live model live: a new one arrives as `building`.
    const registered = await deps.embeddingModels.ensureRegistered(orgId, {
      provider: saved.provider,
      model: saved.model,
      dimensions: saved.dimensions,
    });

    await deps.audit?.record({
      orgId,
      actorId: identityUserId(req.identity!) ?? undefined,
      action: 'admin.embeddings.configured',
      resource: `model:${registered.slot}`,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
      // The credential is never in the audit metadata either.
      metadata: { provider: saved.provider, model: saved.model, dimensions: saved.dimensions },
    });

    return {
      config: await deps.embeddingConfig.redacted(orgId),
      model: { key: registered.key, state: registered.state },
      // What the operator has to do next, said plainly rather than implied.
      nextStep:
        registered.state === 'active'
          ? 'active'
          : 'reindex-then-activate',
    };
  });

  /**
   * Try the provider before trusting it.
   *
   * Embeds one short string and reports what came back. A wrong key, a
   * mistyped endpoint or a model name that does not exist all fail here, in
   * one click, instead of failing silently on the next note somebody saves.
   */
  app.post('/api/organizations/:orgId/embeddings/test', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    if (!(await requireOrgRole(req, reply, orgId, ['org_admin']))) return reply;
    const body = (req.body ?? {}) as {
      provider?: string;
      model?: string | null;
      dimensions?: number;
      endpoint?: string | null;
      apiKey?: string | null;
    };
    const parsed = parseEmbeddingConfig(body);
    if ('error' in parsed) return fail(req, reply, 400, 'embeddings.configInvalid', { reason: parsed.error });

    // An edit that did not retype the key tests with the stored one.
    let sealed: string | null = null;
    if (body.apiKey) {
      try {
        sealed = sealSecret(body.apiKey, secretPassphrase());
      } catch {
        return fail(req, reply, 400, 'embeddings.configInvalid', {
          reason: 'no encryption passphrase is configured (DILUXITE_SECRET_KEY)',
        });
      }
    } else {
      sealed = (await deps.embeddingConfig?.read(orgId))?.apiKeySealed ?? null;
    }

    const started = Date.now();
    try {
      const built = embedderFromConfig(
        { orgId, ...parsed.value, apiKeySealed: sealed, updatedAt: new Date(), updatedBy: null },
        secretPassphrase(),
      );
      if (!built) return fail(req, reply, 400, 'common.invalidRequest');
      const [vector] = await built.embedder.embed(['prueba de conexión']);
      const actual = vector?.length ?? 0;
      return {
        ok: actual === parsed.value.dimensions,
        dimensions: actual,
        expected: parsed.value.dimensions,
        elapsedMs: Date.now() - started,
        // The mismatch worth naming: a model that answers but with a different
        // shape would index fine and then break every search.
        error:
          actual === parsed.value.dimensions
            ? null
            : `the provider returned ${actual} dimensions, not ${parsed.value.dimensions}`,
      };
    } catch (e) {
      return { ok: false, dimensions: 0, expected: parsed.value.dimensions, elapsedMs: Date.now() - started, error: (e as Error).message };
    }
  });

  // --- Admin: reindex (re-embed all notes) ---
  // POST /api/admin/reindex { orgId? , spaceId? }
  //
  // Re-runs the indexer (chunk + embed + persist) over every live note in the
  // target scope. This is how you recover after switching embedder/dimension:
  // before, the app only warned that existing chunks were stale; now an admin
  // can rebuild them on demand. Idempotent — re-indexing the same notes is
  // safe (indexChunks replaces a note's chunks).
  //
  // Authorisation:
  //   - spaceId given → the caller must be a workspace admin (org admins
  //     escalate, mirroring other space-admin actions).
  //   - orgId given (no spaceId) → caller must be org org_admin/admin.
  //   - neither, single-org / local install → fall back to the caller's only
  //     org, still gated on org_admin/admin there.
  //
  // Synchronous: returns the count once done. Fine for the install sizes Core
  // targets; a huge corpus would want a job queue (future work, documented).
  app.post('/api/admin/reindex', async (req, reply) => {
    const { orgId, spaceId } = (req.body ?? {}) as { orgId?: string; spaceId?: string };

    // Resolve the set of spaces to reindex + authorise.
    let targetSpaces: { id: string }[];
    if (spaceId) {
      if (!(await requireWorkspaceRole(req, reply, spaceId, ['admin']))) return reply;
      targetSpaces = [{ id: spaceId }];
    } else {
      let targetOrg = orgId;
      if (!targetOrg) {
        const orgs = await deps.organizations.listForUser(uid(req));
        if (orgs.length === 0) {
          return reply.code(400).send({ error: 'no organization — nothing to reindex' });
        }
        targetOrg = orgs[0].id;
      }
      if (!(await requireOrgRole(req, reply, targetOrg, ['org_admin']))) return reply;
      targetSpaces = await deps.spaces.listForOrg(targetOrg);
    }

    let reindexed = 0;
    for (const space of targetSpaces) {
      const notes = await deps.notes.list(space.id);
      for (const note of notes) {
        await deps.search.index(note);
        reindexed += 1;
      }
    }
    await deps.audit?.record({
      orgId,
      actorId: identityUserId(req.identity!) ?? undefined,
      action: 'admin.reindex',
      resource: spaceId ? `space:${spaceId}` : orgId ? `org:${orgId}` : undefined,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
      metadata: { reindexed, spaces: targetSpaces.length },
    });
    return { ok: true, reindexed, spaces: targetSpaces.length };
  });

  // --- Org-scoped tokens (with granular scopes) ---
  // Differ from user tokens in two ways:
  //   1. They belong to the org (no userId; survive when the creator leaves).
  //   2. They carry data-plane scopes (read|write) that gate what the
  //      unattended client may do across the org's spaces.
  // Only org admins / org_admins can manage them.
  const VALID_SCOPES = new Set<string>([TOKEN_SCOPE_READ, TOKEN_SCOPE_WRITE]);
  /**
   * Normalises the requested scopes.
   *   - `undefined` → `['read']`: read-only is the safe default for a token
   *     dropped into a GitHub Action / cron that only consults the brain.
   *   - an array → must be a non-empty subset of {read, write}; anything else
   *     (unknown scope, non-string, empty array) is rejected.
   * Returns the deduped scopes, or null on invalid input.
   */
  function validateScopes(scopes: unknown): string[] | null {
    if (scopes === undefined) return [TOKEN_SCOPE_READ];
    if (!Array.isArray(scopes) || scopes.length === 0) return null;
    const out = new Set<string>();
    for (const s of scopes) {
      if (typeof s !== 'string' || !VALID_SCOPES.has(s)) return null;
      out.add(s);
    }
    return [...out];
  }

  app.post(
    '/api/organizations/:orgId/tokens',
    {
      // Same budget as personal token minting (/api/tokens): 10/min/IP.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
    // Org-scoped tokens are a multi-tenant concept. In local mode a single
    // user already has personal API keys (/api/api-keys), so org tokens are
    // both redundant and confusing — refuse to mint them.
    if (deps.info?.authMode !== 'server') {
      return reply.code(403).send({ error: 'org tokens require server mode' });
    }
    const { orgId } = req.params as { orgId: string };
    if (!(await requireOrgRole(req, reply, orgId, ['org_admin']))) return reply;
    const { name, scopes } = (req.body ?? {}) as { name?: string; scopes?: unknown };
    const cleanScopes = validateScopes(scopes);
    if (!cleanScopes) {
      return reply.code(400).send({
        error: 'scopes must be a non-empty subset of: read, write',
      });
    }
    const { token, info } = await deps.tokens.createOrgToken(
      orgId,
      name?.trim() || 'org-token',
      cleanScopes as Parameters<typeof deps.tokens.createOrgToken>[2],
    );
    await deps.audit?.record({
      orgId,
      actorId: uid(req),
      action: 'admin.org_token.minted',
      resource: `org_token:${info.id}`,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string | undefined,
      metadata: { name: info.name, scopes: cleanScopes },
    });
    return reply.code(201).send({ token, ...info });
    },
  );

  app.get('/api/organizations/:orgId/tokens', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    if (!(await requireOrgRole(req, reply, orgId, ['org_admin']))) return reply;
    return deps.tokens.listForOrg(orgId);
  });

  app.delete('/api/organizations/:orgId/tokens/:id', async (req, reply) => {
    // Symmetric with POST above: even revoking an org token only makes sense
    // when org tokens exist at all (server mode).
    if (deps.info?.authMode !== 'server') {
      return reply.code(403).send({ error: 'org tokens require server mode' });
    }
    const { orgId, id } = req.params as { orgId: string; id: string };
    if (!(await requireOrgRole(req, reply, orgId, ['org_admin']))) return reply;
    const ok = await deps.tokens.revokeOrgToken(orgId, id);
    if (ok) {
      await deps.audit?.record({
        orgId,
        actorId: uid(req),
        action: 'admin.org_token.revoked',
        resource: `org_token:${id}`,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] as string | undefined,
      });
    }
    return ok ? { ok: true } : fail(req, reply, 404, 'note.notFound');
  });

  registerMcp(app, deps);
  registerPasskeyRoutes(app, deps);
  return app;
}
