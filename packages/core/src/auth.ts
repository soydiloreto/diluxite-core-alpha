/**
 * Who a request is acting as. Discriminated by `kind`:
 *   - `user`: a human (cookie session, personal Bearer token, or external IdP).
 *   - `org`: an unattended ORG token (GitHub Action / cron hitting MCP). It
 *     belongs to the organization, NOT to any user, so it survives the creator
 *     being disabled or leaving. Carries the row id (for audit) and the granted
 *     scopes (read|write) that gate what it can do.
 *
 * Making this a union (rather than `userId: string | null`) forces every call
 * site that assumed a user to decide explicitly what an org token may do — the
 * compiler flags each `identity.userId` access until it's been considered.
 */
export type Identity =
  | { kind: 'user'; userId: string }
  | { kind: 'org'; orgId: string; tokenId: string; scopes: string[] };

/** Narrow an identity to its userId, or null when it's an org token. */
export function identityUserId(identity: Identity): string | null {
  return identity.kind === 'user' ? identity.userId : null;
}

export type AuthHeaders = Record<string, string | string[] | undefined>;

/** Resuelve la identidad del request. Core: single-user. Cloud: Entra/token. */
export interface AuthProvider {
  resolve(headers: AuthHeaders): Promise<Identity | null>;
}

/** Autorización por espacio (membresía). Implementado en @diluxite/db. */
export interface SpaceAccess {
  isMember(spaceId: string, userId: string): Promise<boolean>;
  role(spaceId: string, userId: string): Promise<string | null>;
  /**
   * True if the space belongs to the given org. Used to authorise ORG tokens,
   * which have no per-space membership — their reach is "every space of their
   * org". Implemented in @diluxite/db (`SELECT 1 FROM spaces WHERE id=$1 AND
   * org_id=$2`).
   */
  isSpaceInOrg(spaceId: string, orgId: string): Promise<boolean>;
}

/**
 * Scopes an ORG token may carry. `read` lets it call the read tools/endpoints;
 * `write` additionally lets it create/append/edit. A GitHub Action querying the
 * second brain wants `['read']` (the safe default); a cron that jots memories
 * needs `['write']`.
 */
export const TOKEN_SCOPE_READ = 'read';
export const TOKEN_SCOPE_WRITE = 'write';
/** The scopes the data-plane recognises for org tokens. */
export const ORG_TOKEN_SCOPES = [TOKEN_SCOPE_READ, TOKEN_SCOPE_WRITE] as const;

/** Edición Core: siempre el mismo usuario, sin login. */
export class SingleUserAuthProvider implements AuthProvider {
  constructor(private readonly userId: string) {}
  async resolve(_headers?: AuthHeaders): Promise<Identity> {
    return { kind: 'user', userId: this.userId };
  }
}

/** Extrae el token de un header `Authorization: Bearer <token>`. */
export function bearerToken(headers: AuthHeaders): string | undefined {
  const raw = headers['authorization'] ?? headers['Authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  // RFC 6750: the auth scheme is case-insensitive ("bearer" == "Bearer").
  const m = value?.match(/^bearer\s+(.+)$/i);
  return m ? m[1].trim() : undefined;
}

/** Multiusuario por token Bearer (mapa token→userId, en memoria). Útil para tests. */
export class TokenAuthProvider implements AuthProvider {
  constructor(private readonly tokens: Map<string, string>) {}
  async resolve(headers: AuthHeaders): Promise<Identity | null> {
    const token = bearerToken(headers);
    const userId = token ? this.tokens.get(token) : undefined;
    return userId ? { kind: 'user', userId } : null;
  }
}

/**
 * A Bearer token resolved against the store. EXACTLY one of `userId` / `orgId`
 * is set (the DB `tokens_owner_xor` constraint guarantees it):
 *   - `userId` set  → a personal token (its scopes are ignored by the API).
 *   - `orgId`  set  → an unattended org token; `scopes` gate read/write.
 * `tokenId` is the row id, surfaced so audit can attribute org-token actions.
 */
export interface ResolvedTokenIdentity {
  tokenId: string;
  userId: string | null;
  orgId: string | null;
  scopes: string[];
}

/** Verifica un token contra un almacén (implementado en @diluxite/db con hashing). */
export interface TokenStore {
  findUserIdByToken(token: string): Promise<string | null>;
  /**
   * Full resolution for the Bearer path: maps a token to a user OR org
   * identity (with scopes), honouring expiration. Returns null for an
   * unknown / expired token. Optional so in-memory test doubles needn't
   * implement it; `SessionAuthProvider` falls back to `findUserIdByToken`.
   */
  resolveToken?(token: string): Promise<ResolvedTokenIdentity | null>;
}

/** Multiusuario por token Bearer persistido. Es lo que usa Claude/Copilot por usuario. */
export class StoredTokenAuthProvider implements AuthProvider {
  constructor(private readonly store: TokenStore) {}
  async resolve(headers: AuthHeaders): Promise<Identity | null> {
    const token = bearerToken(headers);
    if (!token) return null;
    const userId = await this.store.findUserIdByToken(token);
    return userId ? { kind: 'user', userId } : null;
  }
}

/**
 * Server-mode auth: cookie-based session OR Bearer token (for MCP/API
 * clients). Cookies are HttpOnly+Secure; the API mints sessions on
 * POST /api/auth/login.
 */
export interface PasswordStore {
  verifyPassword(email: string, password: string): Promise<string | null>;
}

export interface SessionStore {
  findUserIdBySession(token: string): Promise<string | null>;
  createSession(userId: string, ttlSeconds?: number): Promise<{ token: string; expiresAt: Date }>;
  deleteSession(token: string): Promise<void>;
}

/** Extracts a named cookie from a Cookie header value (`a=1; b=2`). */
export function readCookie(headers: AuthHeaders, name: string): string | undefined {
  const raw = headers['cookie'] ?? headers['Cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  for (const pair of value.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return undefined;
}

export class SessionAuthProvider implements AuthProvider {
  constructor(
    private readonly sessions: SessionStore,
    private readonly tokens?: TokenStore,
    private readonly cookieName = 'diluxite_session',
  ) {}
  async resolve(headers: AuthHeaders): Promise<Identity | null> {
    const sessionToken = readCookie(headers, this.cookieName);
    if (sessionToken) {
      // active=false enforcement lives in the SessionStore implementation:
      // DrizzleSessionsRepository.findUserIdBySession joins `users` and only
      // returns the id for an active account, so a soft-disabled user's
      // existing sessions stop resolving on the next request.
      const userId = await this.sessions.findUserIdBySession(sessionToken);
      if (userId) return { kind: 'user', userId };
    }
    if (this.tokens) {
      const bearer = bearerToken(headers);
      if (bearer) {
        // Prefer the full resolution: it tells user tokens apart from ORG
        // tokens (user_id NULL, org_id set). A user token → user identity;
        // an org token → org identity carrying its scopes, so the API can
        // gate read vs write. We fall back to the legacy user-only lookup
        // when the store doesn't implement resolveToken (in-memory doubles).
        if (this.tokens.resolveToken) {
          const resolved = await this.tokens.resolveToken(bearer);
          if (resolved) {
            if (resolved.userId) return { kind: 'user', userId: resolved.userId };
            if (resolved.orgId) {
              return {
                kind: 'org',
                orgId: resolved.orgId,
                tokenId: resolved.tokenId,
                scopes: resolved.scopes,
              };
            }
          }
        } else {
          const userId = await this.tokens.findUserIdByToken(bearer);
          if (userId) return { kind: 'user', userId };
        }
      }
    }
    return null;
  }
}

/**
 * Auth Policy — used by TrustedHeader and OIDC providers when an external
 * IdP authenticates someone the Diluxite users table doesn't know yet.
 */
export type AuthPolicy =
  | 'deny_unknown'
  | 'allow_unknown_as_member'
  | 'pre_provisioned_only';

/**
 * Minimal shape the TrustedHeader provider needs from the users repo. We
 * declare the interface inline rather than importing the Drizzle repo to
 * keep `@diluxite/core` decoupled from `@diluxite/db`.
 */
export interface UsersRepoForTrustedHeader {
  findByEmail(email: string): Promise<{ id: string; active?: boolean } | null>;
  createFromExternal(input: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    provider: string;
  }): Promise<{ id: string }>;
  touchLastLogin(userId: string): Promise<void>;
}

const EMAIL_RE_TH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Identity-Aware Proxy bridge. Trusts a request header set by an upstream
 * proxy (Cloudflare Access, Authelia, Pomerium, oauth2-proxy, etc.) that
 * already authenticated the user. The header carries the verified email;
 * the proxy is responsible for signing / verifying the upstream identity.
 *
 * Trust model
 * ───────────
 * This provider only kicks in when the operator EXPLICITLY sets
 * `DILUXITE_TRUSTED_IDENTITY_HEADER`. We do NOT default it. Reason:
 *
 *   Anyone who can reach the Diluxite API port WITHOUT going through the
 *   proxy can spoof the header and impersonate any user. The operator must
 *   guarantee the network path forces all traffic through the proxy
 *   (private listener, firewall, etc). The README documents this.
 *
 * Behaviour
 * ─────────
 *  1. Read header value.
 *  2. If missing or empty → return null (delegate to next provider in chain).
 *  3. If malformed email → return null.
 *  4. Lookup by email. If exists → check active, then `touchLastLogin`,
 *     return identity.
 *  5. If not exists → apply `authPolicy`:
 *     - `deny_unknown` / `pre_provisioned_only` → null (effectively 401
 *       at the API gate, which is the safest failure mode).
 *     - `allow_unknown_as_member` → JIT-create with provider='trusted_header',
 *       then return identity.
 */
/**
 * Shared "verified email → identity" resolution, used by BOTH the
 * TrustedHeader provider and the Cloudflare-Access-JWT provider. The caller is
 * responsible for ESTABLISHING TRUST in the email (a plaintext header for
 * TrustedHeader, a cryptographically-verified JWT for Cf-Access); this helper
 * only does the lookup → active check → auth policy → JIT create dance.
 *
 *  1. Malformed email → null.
 *  2. Existing user, active → touchLastLogin, identity.
 *  3. Existing user, active=false → null (gate closes the API).
 *  4. Unknown email + `deny_unknown` / `pre_provisioned_only` → null.
 *  5. Unknown email + `allow_unknown_as_member` → JIT-create + identity.
 */
export async function resolveIdentityByEmail(
  users: UsersRepoForTrustedHeader,
  rawEmail: string,
  getAuthPolicy: () => Promise<AuthPolicy>,
  provider: string,
): Promise<Identity | null> {
  const normalized = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE_TH.test(normalized)) return null;

  const existing = await users.findByEmail(normalized);
  if (existing) {
    // active === false is treated as "no identity" — the upper API layer
    // returns 401. The cleaner UX (clear 403 with "your admin disabled")
    // is reserved for OIDC's explicit callback handler; these providers run
    // on EVERY API request, so we'd be paging the user every time — null is
    // friendlier.
    if (existing.active === false) return null;
    await users.touchLastLogin(existing.id);
    return { kind: 'user', userId: existing.id };
  }

  const policy = await getAuthPolicy();
  if (policy === 'deny_unknown' || policy === 'pre_provisioned_only') {
    return null;
  }
  const created = await users.createFromExternal({ email: normalized, provider });
  await users.touchLastLogin(created.id);
  return { kind: 'user', userId: created.id };
}

export class TrustedHeaderAuthProvider implements AuthProvider {
  constructor(
    private readonly users: UsersRepoForTrustedHeader,
    private readonly options: {
      headerName: string;
      getAuthPolicy: () => Promise<AuthPolicy>;
    },
  ) {}

  async resolve(headers: AuthHeaders): Promise<Identity | null> {
    const headerName = this.options.headerName.toLowerCase();
    const raw = headers[headerName];
    const email = Array.isArray(raw) ? raw[0] : raw;
    if (!email || typeof email !== 'string') return null;
    return resolveIdentityByEmail(
      this.users,
      email,
      this.options.getAuthPolicy,
      'trusted_header',
    );
  }
}
