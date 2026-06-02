import type { FastifyInstance } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AppDeps } from './app';
import { mintCsrfToken, csrfCookieHeader } from './csrf';

/**
 * WebAuthn / passkey routes.
 *
 * Two ceremonies, each split in two HTTP calls:
 *   - registration:  /api/auth/passkey/register-options   → /register-verify
 *   - authentication: /api/auth/passkey/authenticate-options → /authenticate-verify
 *
 * RP (Relying Party) identity comes from env vars so production deploys
 * behind `https://diluxite.example.com` can set `DILUXITE_RP_ID` +
 * `DILUXITE_RP_ORIGIN`. Local dev defaults work at http://localhost:5173.
 *
 * Only mounted in server mode; in local mode every endpoint returns 404.
 */
export function registerPasskeyRoutes(app: FastifyInstance, deps: AppDeps): void {
  const RP_NAME = process.env.DILUXITE_RP_NAME ?? 'Diluxite';
  const RP_ID = process.env.DILUXITE_RP_ID ?? 'localhost';
  const RP_ORIGIN = process.env.DILUXITE_RP_ORIGIN ?? 'http://localhost:5173';

  const SESSION_COOKIE = 'diluxite_session';
  const sessionCookie = (token: string, maxAgeSeconds: number) =>
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;

  const serverModeEnabled = (): boolean =>
    deps.info?.authMode === 'server' && Boolean(deps.passkeys) && Boolean(deps.sessions);

  app.post('/api/auth/passkey/register-options', async (req, reply) => {
    if (!serverModeEnabled()) {
      return reply.code(404).send({ error: 'passkeys only available in server mode' });
    }
    const id = await deps.auth.resolve(req.headers);
    if (!id) return reply.code(401).send({ error: 'sign in first' });

    const user = await deps.users.findById(id.userId);
    if (!user) return reply.code(404).send({ error: 'user not found' });

    const existing = await deps.passkeys!.listForUser(user.id);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: user.email,
      userDisplayName: user.email,
      excludeCredentials: existing.map((p) => ({
        id: p.credentialId,
        transports: p.transports as never,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    await deps.passkeys!.saveChallenge(options.challenge, 'registration', user.id);
    return options;
  });

  app.post('/api/auth/passkey/register-verify', async (req, reply) => {
    if (!serverModeEnabled()) {
      return reply.code(404).send({ error: 'passkeys only available in server mode' });
    }
    const id = await deps.auth.resolve(req.headers);
    if (!id) return reply.code(401).send({ error: 'sign in first' });

    const body = req.body as {
      response?: Parameters<typeof verifyRegistrationResponse>[0]['response'];
      label?: string;
    };
    const response = body?.response;
    if (!response) return reply.code(400).send({ error: 'response required' });

    const clientData = JSON.parse(
      Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'),
    );
    const challenge: string = clientData.challenge;
    const taken = await deps.passkeys!.takeChallenge(challenge, 'registration');
    if (!taken || taken.userId !== id.userId) {
      return reply.code(400).send({ error: 'invalid or expired challenge' });
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return reply.code(400).send({ error: 'verification failed' });
    }

    const info = verification.registrationInfo;
    await deps.passkeys!.register({
      userId: id.userId,
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
      counter: info.credential.counter,
      deviceType: info.credentialDeviceType,
      label: body.label?.trim() || 'passkey',
      transports: info.credential.transports ?? [],
      backedUp: info.credentialBackedUp,
    });
    return reply.code(201).send({ ok: true });
  });

  app.post(
    '/api/auth/passkey/authenticate-options',
    {
      // Rate-limit passkey ceremony entry-points (10/min/IP). Higher than
      // login because each WebAuthn flow needs both options + verify in
      // quick succession; tighter than that and legitimate retries fail.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (_req, reply) => {
    if (!serverModeEnabled()) {
      return reply.code(404).send({ error: 'passkeys only available in server mode' });
    }
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred',
    });
    await deps.passkeys!.saveChallenge(options.challenge, 'authentication', null);
    return options;
  });

  app.post(
    '/api/auth/passkey/authenticate-verify',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
    if (!serverModeEnabled()) {
      return reply.code(404).send({ error: 'passkeys only available in server mode' });
    }
    const body = req.body as {
      response?: Parameters<typeof verifyAuthenticationResponse>[0]['response'];
    };
    const response = body?.response;
    if (!response) return reply.code(400).send({ error: 'response required' });

    const clientData = JSON.parse(
      Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'),
    );
    const challenge: string = clientData.challenge;
    const taken = await deps.passkeys!.takeChallenge(challenge, 'authentication');
    if (!taken) {
      return reply.code(400).send({ error: 'invalid or expired challenge' });
    }

    const credentialId = response.id;
    const passkey = await deps.passkeys!.findByCredentialId(credentialId);
    if (!passkey) return reply.code(404).send({ error: 'credential not registered' });

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: passkey.credentialId,
        publicKey: Buffer.from(passkey.publicKey, 'base64url'),
        counter: passkey.counter,
        transports: passkey.transports as never,
      },
    });
    if (!verification.verified) {
      return reply.code(400).send({ error: 'verification failed' });
    }

    await deps.passkeys!.updateCounter(credentialId, verification.authenticationInfo.newCounter);
    const xff = req.headers['x-forwarded-for'];
    const clientIpVal =
      (typeof xff === 'string' ? xff.split(',')[0]?.trim() : undefined) ?? req.ip;
    const { token, expiresAt } = await deps.sessions!.createSession(passkey.userId, undefined, {
      ip: clientIpVal,
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    const csrf = mintCsrfToken();
    reply.header('Set-Cookie', [sessionCookie(token, maxAge), csrfCookieHeader(csrf, maxAge)]);
    return { ok: true, expiresAt, csrf };
  });

  // ── List + revoke (used by Settings → Passkeys UI in Fase 10) ──────────
  app.get('/api/passkeys', async (req, reply) => {
    if (!deps.passkeys) {
      return reply.code(404).send({ error: 'passkeys disabled in this build' });
    }
    const list = await deps.passkeys.listForUser(req.identity!.userId);
    return list.map((p) => ({
      id: p.id,
      label: p.label,
      deviceType: p.deviceType,
      createdAt: p.createdAt,
      lastUsedAt: p.lastUsedAt,
    }));
  });

  app.delete('/api/passkeys/:id', async (req, reply) => {
    if (!deps.passkeys) {
      return reply.code(404).send({ error: 'passkeys disabled in this build' });
    }
    const { id } = req.params as { id: string };
    const ok = await deps.passkeys.revoke(req.identity!.userId, id);
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });
}
