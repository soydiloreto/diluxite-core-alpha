export interface Identity {
  userId: string;
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
}

/** Edición Core: siempre el mismo usuario, sin login. */
export class SingleUserAuthProvider implements AuthProvider {
  constructor(private readonly userId: string) {}
  async resolve(_headers?: AuthHeaders): Promise<Identity> {
    return { userId: this.userId };
  }
}

/** Extrae el token de un header `Authorization: Bearer <token>`. */
export function bearerToken(headers: AuthHeaders): string | undefined {
  const raw = headers['authorization'] ?? headers['Authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
}

/** Multiusuario por token Bearer (mapa token→userId, en memoria). Útil para tests. */
export class TokenAuthProvider implements AuthProvider {
  constructor(private readonly tokens: Map<string, string>) {}
  async resolve(headers: AuthHeaders): Promise<Identity | null> {
    const token = bearerToken(headers);
    const userId = token ? this.tokens.get(token) : undefined;
    return userId ? { userId } : null;
  }
}

/** Verifica un token contra un almacén (implementado en @diluxite/db con hashing). */
export interface TokenStore {
  findUserIdByToken(token: string): Promise<string | null>;
}

/** Multiusuario por token Bearer persistido. Es lo que usa Claude/Copilot por usuario. */
export class StoredTokenAuthProvider implements AuthProvider {
  constructor(private readonly store: TokenStore) {}
  async resolve(headers: AuthHeaders): Promise<Identity | null> {
    const token = bearerToken(headers);
    if (!token) return null;
    const userId = await this.store.findUserIdByToken(token);
    return userId ? { userId } : null;
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
      const userId = await this.sessions.findUserIdBySession(sessionToken);
      if (userId) return { userId };
    }
    if (this.tokens) {
      const bearer = bearerToken(headers);
      if (bearer) {
        const userId = await this.tokens.findUserIdByToken(bearer);
        if (userId) return { userId };
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
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_RE_TH.test(normalized)) return null;

    const existing = await this.users.findByEmail(normalized);
    if (existing) {
      // active === false is treated as "no identity" — the upper API layer
      // returns 401. The cleaner UX (clear 403 with "your admin disabled")
      // is reserved for OIDC's explicit callback handler; the
      // TrustedHeader path runs on EVERY API request, so we'd be paging
      // the user on every request — null is friendlier.
      if (existing.active === false) return null;
      await this.users.touchLastLogin(existing.id);
      return { userId: existing.id };
    }

    const policy = await this.options.getAuthPolicy();
    if (policy === 'deny_unknown' || policy === 'pre_provisioned_only') {
      return null;
    }
    const created = await this.users.createFromExternal({
      email: normalized,
      provider: 'trusted_header',
    });
    await this.users.touchLastLogin(created.id);
    return { userId: created.id };
  }
}
