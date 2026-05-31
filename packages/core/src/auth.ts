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
