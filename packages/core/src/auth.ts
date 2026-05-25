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

/** Multiusuario por token Bearer (mapa token→userId). Cloud lo reemplaza por Entra. */
export class TokenAuthProvider implements AuthProvider {
  constructor(private readonly tokens: Map<string, string>) {}
  async resolve(headers: AuthHeaders): Promise<Identity | null> {
    const raw = headers['authorization'] ?? headers['Authorization'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const token = value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
    const userId = token ? this.tokens.get(token) : undefined;
    return userId ? { userId } : null;
  }
}
