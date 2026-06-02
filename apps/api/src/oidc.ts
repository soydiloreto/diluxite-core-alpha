/**
 * OIDC AuthProvider — enterprise-grade single-sign-on.
 *
 * Flow
 * ────
 *  1. User clicks "Sign in with SSO" on Diluxite.
 *  2. /api/auth/oidc/login redirects to the IdP's authorize endpoint with
 *     state + nonce + PKCE.
 *  3. IdP authenticates (with MFA if configured upstream) and redirects
 *     back to /api/auth/oidc/callback?code=...&state=...
 *  4. The callback exchanges code for an id_token, validates signature
 *     against the IdP JWKS, checks nonce + state.
 *  5. JIT or pre-provisioned-only lookup of the user by email claim. The
 *     org_settings.auth_policy decides what happens for unknown emails.
 *  6. On success we mint a local session cookie just like password login —
 *     the rest of the app (RLS, ACL guards) keeps treating the request the
 *     same way.
 *
 * Why not JWT directly
 * ─────────────────────
 * We translate the IdP's JWT into our own opaque session token because:
 *  - Revocation: we can kill a session (`delete from sessions`) without the
 *    IdP. Useful for "admin disabled this user" path.
 *  - Cookie path: our session cookie is HttpOnly + SameSite=Lax which is
 *    XSS-resistant; passing the JWT to the browser would be a foot-gun.
 *  - Decoupling: rotating the OIDC provider doesn't invalidate active
 *    sessions in the middle of work.
 *
 * Config (env)
 * ─────────────
 *   DILUXITE_OIDC_ISSUER         e.g. https://login.microsoftonline.com/{tenant}/v2.0
 *   DILUXITE_OIDC_CLIENT_ID
 *   DILUXITE_OIDC_CLIENT_SECRET
 *   DILUXITE_OIDC_REDIRECT_URI   e.g. https://diluxite.acme.com/api/auth/oidc/callback
 *   DILUXITE_OIDC_SCOPES         space-separated, default 'openid email profile'
 */
import * as oauth from 'openid-client';

/** Strongly-typed claims we read from the id_token. */
export interface OidcClaims {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string;
}

/** Read the config from env. Returns null if any required field is missing. */
export function readOidcConfig(): OidcConfig | null {
  const issuerUrl = process.env.DILUXITE_OIDC_ISSUER?.trim();
  const clientId = process.env.DILUXITE_OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.DILUXITE_OIDC_CLIENT_SECRET?.trim();
  const redirectUri = process.env.DILUXITE_OIDC_REDIRECT_URI?.trim();
  if (!issuerUrl || !clientId || !clientSecret || !redirectUri) return null;
  return {
    issuerUrl,
    clientId,
    clientSecret,
    redirectUri,
    scopes: process.env.DILUXITE_OIDC_SCOPES?.trim() || 'openid email profile',
  };
}

/**
 * Discovers the IdP metadata + builds an `openid-client` Configuration that
 * we keep memoized for the process lifetime (issuer metadata is stable).
 *
 * We allow insecure (http://) discovery URLs ONLY when the env var
 * `DILUXITE_OIDC_ALLOW_INSECURE=1` is set. Two valid uses:
 *   - Test suites with a mock issuer on 127.0.0.1.
 *   - Initial dev against a self-hosted IdP that hasn't finished TLS setup.
 * In production, leave it unset → openid-client rejects http:// at boot.
 */
export async function buildOidcClient(cfg: OidcConfig): Promise<oauth.Configuration> {
  const insecure = process.env.DILUXITE_OIDC_ALLOW_INSECURE === '1';
  return oauth.discovery(
    new URL(cfg.issuerUrl),
    cfg.clientId,
    cfg.clientSecret,
    undefined,
    insecure ? { execute: [oauth.allowInsecureRequests] } : undefined,
  );
}

/**
 * Builds the IdP authorize URL the user should be redirected to. Returns the
 * URL itself plus the state/nonce/code_verifier we need to remember to
 * validate the callback. The caller is responsible for stashing them in a
 * short-lived cookie or session-store keyed by state.
 */
export async function buildAuthorizeUrl(
  client: oauth.Configuration,
  cfg: OidcConfig,
): Promise<{
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}> {
  const state = oauth.randomState();
  const nonce = oauth.randomNonce();
  const codeVerifier = oauth.randomPKCECodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const url = oauth.buildAuthorizationUrl(client, {
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes ?? 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return { url: url.href, state, nonce, codeVerifier };
}

/**
 * Validates the callback: exchanges code for tokens, verifies the id_token,
 * extracts and normalizes claims. Throws on any failure (signature mismatch,
 * state mismatch, expired token, missing email).
 */
export async function handleCallback(
  client: oauth.Configuration,
  callbackUrl: URL,
  expected: { state: string; nonce: string; codeVerifier: string },
): Promise<OidcClaims> {
  const tokens = await oauth.authorizationCodeGrant(client, callbackUrl, {
    expectedState: expected.state,
    expectedNonce: expected.nonce,
    pkceCodeVerifier: expected.codeVerifier,
    idTokenExpected: true,
  });
  const idClaims = tokens.claims();
  if (!idClaims) throw new Error('id_token missing claims');
  const emailRaw = idClaims.email;
  if (typeof emailRaw !== 'string' || !emailRaw.includes('@')) {
    throw new Error('id_token missing or invalid email claim');
  }
  return {
    email: emailRaw.toLowerCase(),
    firstName:
      typeof idClaims.given_name === 'string' ? idClaims.given_name : null,
    lastName:
      typeof idClaims.family_name === 'string' ? idClaims.family_name : null,
  };
}
