/**
 * Mock OIDC Issuer — un Fastify in-process que firma id_tokens con jose,
 * sirve discovery + JWKS, y acepta authorize + token exchanges. Lo usan
 * los tests E2E de OIDC en `oidc-e2e.integration.test.ts`.
 *
 * Filosofía: NO mockear `openid-client`. Levantar un IdP de verdad
 * (chiquito) y dejarlo correr en localhost:<port-libre>. De esa forma el
 * test ejerce todo el camino real: discovery, validación de JWT contra
 * JWKS, PKCE, nonce. Si la lib upstream cambia algo, el test rompe.
 *
 * El issuer es CONFIGURABLE per-test:
 *   - Qué claims poner en el id_token (email, given_name, family_name).
 *   - Si firmar con la clave correcta o una "mala" (para probar JWKS
 *     rejection).
 *   - Si responder al /authorize con el redirect o con un error.
 *   - Si exigir o no PKCE.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
} from 'jose';

export interface MockIssuerOptions {
  /** Claims to include in the next id_token issued by /token. Default email = test@example.com. */
  claims?: Record<string, unknown>;
  /** If true, /token answers with error. */
  tokenError?: 'invalid_grant' | 'invalid_client' | null;
  /** If true, the id_token will be signed with a DIFFERENT key than the one in JWKS (forgery). */
  signWithBadKey?: boolean;
  /** If set, the id_token's `iss` claim is this value (instead of the real issuer URL). */
  forgedIssuer?: string;
  /** If true, /authorize answers with error=access_denied instead of redirecting with code. */
  authorizeError?: 'access_denied' | null;
}

export interface MockIssuer {
  /** Full URL of the issuer — pass to DILUXITE_OIDC_ISSUER. */
  url: string;
  /** Client ID it accepts. */
  clientId: string;
  /** Client secret it accepts (it doesn't really check it but tests can use this constant). */
  clientSecret: string;
  /** Mutate the options before each test (claims / errors / bad-key). */
  config: MockIssuerOptions;
  /** Close the server cleanly. */
  destroy: () => Promise<void>;
}

const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-secret';

export async function startMockIssuer(): Promise<MockIssuer> {
  // Generate an RS256 keypair for signing and the optional bad-key.
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    modulusLength: 2048,
  });
  const goodJwk = await exportJWK(publicKey);
  goodJwk.kid = 'good-key';
  goodJwk.use = 'sig';
  goodJwk.alg = 'RS256';

  const badKp = await generateKeyPair('RS256', { modulusLength: 2048 });

  const cfg: MockIssuerOptions = {};
  const issuer: MockIssuer = {
    url: '', // set after listen
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    config: cfg,
    destroy: async () => undefined,
  };

  // Track the code → PKCE codeChallenge issued at /authorize, validated at /token.
  const pendingCodes = new Map<string, {
    codeChallenge: string;
    nonce: string;
    redirectUri: string;
    state: string;
  }>();

  const app: FastifyInstance = Fastify({ logger: false });

  app.get('/.well-known/openid-configuration', async () => ({
    issuer: issuer.url,
    authorization_endpoint: `${issuer.url}/authorize`,
    token_endpoint: `${issuer.url}/token`,
    jwks_uri: `${issuer.url}/jwks.json`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'email', 'profile'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
  }));

  app.get('/jwks.json', async () => ({ keys: [goodJwk] }));

  app.get('/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (cfg.authorizeError) {
      const url = new URL(q.redirect_uri);
      url.searchParams.set('error', cfg.authorizeError);
      url.searchParams.set('state', q.state ?? '');
      return reply.redirect(url.href);
    }
    const code = `code_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    pendingCodes.set(code, {
      codeChallenge: q.code_challenge ?? '',
      nonce: q.nonce ?? '',
      redirectUri: q.redirect_uri ?? '',
      state: q.state ?? '',
    });
    const redirect = new URL(q.redirect_uri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', q.state ?? '');
    return reply.redirect(redirect.href);
  });

  // Accept form-urlencoded (standard for /token).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      const params = new URLSearchParams(body as string);
      const out: Record<string, string> = {};
      params.forEach((v, k) => {
        out[k] = v;
      });
      done(null, out);
    },
  );

  app.post('/token', async (req, reply) => {
    if (cfg.tokenError) {
      return reply.code(400).send({ error: cfg.tokenError });
    }
    const body = req.body as Record<string, string>;
    const pending = pendingCodes.get(body.code ?? '');
    if (!pending) return reply.code(400).send({ error: 'invalid_grant' });
    pendingCodes.delete(body.code);

    // PKCE check: openid-client sends `code_verifier` whose S256 hash must
    // match the original code_challenge.
    if (pending.codeChallenge) {
      const verifier = body.code_verifier ?? '';
      const { createHash } = await import('node:crypto');
      const hash = createHash('sha256')
        .update(verifier)
        .digest('base64url');
      if (hash !== pending.codeChallenge) {
        return reply.code(400).send({ error: 'invalid_grant' });
      }
    }

    const claims = cfg.claims ?? { email: 'test@example.com' };
    const signKey: CryptoKey = cfg.signWithBadKey ? badKp.privateKey : privateKey;
    const idToken = await new SignJWT({
      ...claims,
      nonce: pending.nonce,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'good-key' })
      .setIssuer(cfg.forgedIssuer ?? issuer.url)
      .setSubject(String(claims.sub ?? claims.email ?? 'subj-1'))
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('5 minutes from now')
      .sign(signKey);

    return reply.send({
      access_token: 'fake-access',
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: 300,
    });
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('Mock issuer never bound');
  issuer.url = `http://127.0.0.1:${addr.port}`;
  issuer.destroy = async () => {
    await app.close();
  };
  return issuer;
}
