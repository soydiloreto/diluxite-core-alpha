/**
 * Cloudflare Access — cryptographically-verified identity provider.
 *
 * Unlike the plaintext TrustedHeader provider (which trusts whatever email a
 * header carries and is therefore only safe behind a locked-down network),
 * this provider VERIFIES the signed JWT Cloudflare Access puts on every request
 * (`Cf-Access-Jwt-Assertion`):
 *
 *   1. RS256 signature against the team's public certs
 *      (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached by
 *      jose's remote JWKS with its own TTL).
 *   2. `iss` === the team domain.
 *   3. `aud` === the Access application's AUD tag (stricter than just trusting
 *      any token from the team — a JWT minted for a DIFFERENT Access app in the
 *      same team is rejected).
 *   4. `exp` not expired.
 *
 * Because trust is cryptographic, this does NOT require forcing all traffic
 * through a tunnel: a spoofed request that reaches the API port directly has no
 * valid signature and is rejected. The email is only trusted AFTER (1)-(4).
 */
import {
  jwtVerify,
  createRemoteJWKSet,
  type JWTVerifyGetKey,
} from 'jose';
import {
  resolveIdentityByEmail,
  type AuthProvider,
  type AuthHeaders,
  type Identity,
  type AuthPolicy,
  type UsersRepoForTrustedHeader,
} from '@diluxite/core';

export interface CfAccessConfig {
  /** Team domain, e.g. `myteam.cloudflareaccess.com` (protocol optional). */
  teamDomain: string;
  /** Access application AUD tag (the long hex string from the Access app). */
  aud: string;
  /** Header carrying the signed JWT. Default Cloudflare's. */
  headerName?: string;
}

/** Normalises the team domain into the canonical issuer URL. */
export function cfAccessIssuer(teamDomain: string): string {
  // `replace(/\/+$/, '')` is quadratic on a string of trailing slashes: the
  // engine retries the anchored match from every position. This value comes
  // from configuration rather than a request, so it was never reachable by an
  // attacker — but a loop is both linear and clearer about the intent.
  let host = teamDomain.trim().replace(/^https?:\/\//, '');
  while (host.endsWith('/')) host = host.slice(0, -1);
  return `https://${host}`;
}

/** JWKS endpoint URL for a team domain. */
export function cfAccessJwksUrl(teamDomain: string): URL {
  return new URL(`${cfAccessIssuer(teamDomain)}/cdn-cgi/access/certs`);
}

/**
 * Verify a Cloudflare Access JWT and return the verified email, or null if the
 * token is missing/invalid/expired/wrong-aud/wrong-iss. `getKey` is injectable
 * so tests can sign with a local keypair instead of hitting the network.
 */
export async function verifyCfAccessEmail(
  token: string,
  cfg: CfAccessConfig,
  getKey: JWTVerifyGetKey,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: cfAccessIssuer(cfg.teamDomain),
      audience: cfg.aud,
      algorithms: ['RS256'],
    });
    return typeof payload.email === 'string' && payload.email ? payload.email : null;
  } catch {
    return null;
  }
}

export class CfAccessJwtAuthProvider implements AuthProvider {
  private readonly headerName: string;
  private readonly getKey: JWTVerifyGetKey;

  constructor(
    private readonly users: UsersRepoForTrustedHeader,
    private readonly cfg: CfAccessConfig,
    private readonly getAuthPolicy: () => Promise<AuthPolicy>,
    /** Injectable JWKS resolver (default: remote certs). Tests pass a local one. */
    getKey?: JWTVerifyGetKey,
  ) {
    this.headerName = (cfg.headerName ?? 'cf-access-jwt-assertion').toLowerCase();
    this.getKey = getKey ?? createRemoteJWKSet(cfAccessJwksUrl(cfg.teamDomain));
  }

  async resolve(headers: AuthHeaders): Promise<Identity | null> {
    const raw = headers[this.headerName];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token || typeof token !== 'string') return null;
    const email = await verifyCfAccessEmail(token, this.cfg, this.getKey);
    if (!email) return null;
    return resolveIdentityByEmail(this.users, email, this.getAuthPolicy, 'cf_access');
  }
}
