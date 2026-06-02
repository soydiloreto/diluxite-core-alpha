import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AuthProvider, Identity, NotesService, SearchService } from '@diluxite/core';
import type {
  DrizzleFoldersRepository,
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
import { applyServerEdit } from './collab';

const ORG_ROLES: readonly OrgRole[] = ['super_admin', 'admin', 'member'];
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

export interface AppDeps {
  notes: NotesService;
  search: SearchService;
  spaces: DrizzleSpacesRepository;
  organizations: DrizzleOrganizationsRepository;
  users: DrizzleUsersRepository;
  tokens: DrizzleTokensRepository;
  sessions?: import('@diluxite/db').DrizzleSessionsRepository;
  passkeys?: import('@diluxite/db').DrizzlePasskeysRepository;
  tags: DrizzleTagsRepository;
  links: DrizzleLinksRepository;
  folders: DrizzleFoldersRepository;
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
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

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
      // Identifier: IP if behind a real proxy (X-Forwarded-For honoured by
      // Fastify's `trustProxy` once we set it), falls back to socket remote.
      keyGenerator: (req) =>
        (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
        req.ip,
    });
  }

  app.get('/health', async () => ({ status: 'ok', service: 'diluxite-core' }));

  // ── Auth endpoints (server mode) ────────────────────────────────────────
  // These are deliberately ABOVE the /api preHandler so login itself doesn't
  // require an existing session. They no-op gracefully in local mode (the
  // login UI never reaches them; the server-side guard returns 404).
  const SESSION_COOKIE = 'diluxite_session';
  const sessionCookie = (token: string, maxAgeSeconds: number) =>
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  const clearCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

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
      return reply.code(400).send({ error: 'email and password required' });
    }
    const user = await deps.users.findWithPasswordByEmail(email.trim().toLowerCase());
    const { verifyPassword } = await import('@diluxite/core');
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    const { token, expiresAt } = await deps.sessions.createSession(user.id);
    const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    reply.header('Set-Cookie', sessionCookie(token, maxAge));
    return { ok: true, user: { id: user.id, email: user.email }, expiresAt };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (deps.info?.authMode !== 'server' || !deps.sessions) {
      return reply.code(404).send({ error: 'logout only available in server mode' });
    }
    const cookieHeader = (req.headers['cookie'] ?? req.headers['Cookie']) as string | undefined;
    if (cookieHeader) {
      for (const pair of cookieHeader.split(/;\s*/)) {
        const [k, v] = pair.split('=');
        if (k === SESSION_COOKIE && v) {
          await deps.sessions.deleteSession(v);
          break;
        }
      }
    }
    reply.header('Set-Cookie', clearCookie);
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
          return reply
            .code(400)
            .send({ error: `OIDC validation failed: ${(e as Error).message}` });
        }

        // JIT with policy enforcement.
        const existing = await deps.users.findByEmail(claims.email);
        const policy = await oidcDeps.orgSettings.getAuthPolicy(oidcDeps.orgId);

        if (!existing) {
          if (policy === 'deny_unknown') {
            return reply.code(403).send({ error: 'unknown user (deny_unknown policy)' });
          }
          if (policy === 'pre_provisioned_only') {
            return reply.code(403).send({
              error:
                'your account is not provisioned in Diluxite yet — ask an admin to import your email',
            });
          }
          // allow_unknown_as_member → JIT
          await deps.users.createFromExternal({
            email: claims.email,
            firstName: claims.firstName,
            lastName: claims.lastName,
            provider: 'oidc',
          });
        }
        const user = (await deps.users.findByEmail(claims.email))!;
        if (!user.active) {
          return reply.code(403).send({ error: 'your admin disabled this account' });
        }

        await deps.users.touchLastLogin(user.id);

        // Mint local session cookie (same path as password login).
        if (!deps.sessions) {
          return reply.code(500).send({ error: 'sessions backend not configured' });
        }
        const { token, expiresAt } = await deps.sessions.createSession(user.id);
        const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
        reply.header('Set-Cookie', sessionCookie(token, maxAge));
        return reply.redirect('/');
      },
    );
  }

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
  });

  const uid = (req: FastifyRequest) => req.identity!.userId;

  // RS-2: per-space authorisation on every operation.
  async function requireMember(
    req: FastifyRequest,
    reply: FastifyReply,
    spaceId: string,
  ): Promise<boolean> {
    if (await deps.spaces.isMember(spaceId, uid(req))) return true;
    reply.code(403).send({ error: 'no access to this space' });
    return false;
  }

  // Load the note only if the user belongs to its space (404 if not, to avoid leaking existence).
  async function loadAuthorizedNote(req: FastifyRequest) {
    const { id } = req.params as { id: string };
    const note = await deps.notes.get(id);
    if (!note) return null;
    if (!(await deps.spaces.isMember(note.spaceId, uid(req)))) return null;
    return note;
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
      reply.code(404).send({ error: 'organization not found' });
      return null;
    }
    if (!allowed.includes(role)) {
      reply.code(403).send({ error: `requires one of: ${allowed.join(', ')}` });
      return null;
    }
    return role;
  }

  /**
   * Returns the caller's effective role for a workspace, or null + a 403
   * reply if they can't do the operation.
   *
   * Effective role escalation: an org admin / super_admin is implicitly
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
        if (orgRole === 'super_admin' || orgRole === 'admin') effective = 'admin';
      }
    }
    if (!effective) {
      reply.code(403).send({ error: 'no access to this workspace' });
      return null;
    }
    if (!allowed.includes(effective)) {
      reply.code(403).send({ error: `requires one of: ${allowed.join(', ')}` });
      return null;
    }
    return effective;
  }

  // ── Organizations ───────────────────────────────────────────────────────
  app.get('/api/organizations', async (req) => deps.organizations.listForUser(uid(req)));

  app.post('/api/organizations', async (req, reply) => {
    // Local mode is single-tenant by design: one org, no add. Creating new
    // organizations only makes sense in server mode (multi-user / multi-tenant).
    if (deps.info?.authMode !== 'server') {
      return reply.code(403).send({ error: 'organization creation requires server mode' });
    }
    const { name, slug } = (req.body ?? {}) as { name?: string; slug?: string };
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
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
    if (!(await requireOrgRole(req, reply, orgId, ['super_admin']))) return reply;
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
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
    if (!(await requireOrgRole(req, reply, orgId, ['super_admin']))) return reply;
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
    if (!(await requireOrgRole(req, reply, orgId, ['super_admin', 'admin']))) return reply;
    const { email, role } = (req.body ?? {}) as { email?: string; role?: string };
    if (!email?.trim()) return reply.code(400).send({ error: 'email required' });
    const r = role ?? 'member';
    if (!isOrgRole(r)) return reply.code(400).send({ error: `invalid role: ${r}` });
    // Only super_admins can mint new super_admins.
    if (r === 'super_admin') {
      const ok = await requireOrgRole(req, reply, orgId, ['super_admin']);
      if (!ok) return reply;
    }
    const invitee = await deps.users.ensureByEmail(email.trim().toLowerCase());
    await deps.organizations.addOrUpdateMember(orgId, invitee.id, r);
    return reply.code(201).send({ ok: true, userId: invitee.id, role: r });
  });

  app.put('/api/organizations/:orgId/members/:userId', async (req, reply) => {
    const { orgId, userId } = req.params as { orgId: string; userId: string };
    if (!(await requireOrgRole(req, reply, orgId, ['super_admin', 'admin']))) return reply;
    const { role } = (req.body ?? {}) as { role?: string };
    if (!role || !isOrgRole(role)) return reply.code(400).send({ error: 'invalid role' });
    if (role === 'super_admin') {
      if (!(await requireOrgRole(req, reply, orgId, ['super_admin']))) return reply;
    }
    // Block self-demotion that would orphan the org.
    if (role !== 'super_admin' && (await deps.organizations.wouldOrphanSuperAdmin(orgId, userId))) {
      return reply.code(409).send({ error: 'cannot demote the last super_admin' });
    }
    await deps.organizations.addOrUpdateMember(orgId, userId, role);
    return { ok: true };
  });

  app.delete('/api/organizations/:orgId/members/:userId', async (req, reply) => {
    const { orgId, userId } = req.params as { orgId: string; userId: string };
    if (!(await requireOrgRole(req, reply, orgId, ['super_admin', 'admin']))) return reply;
    if (await deps.organizations.wouldOrphanSuperAdmin(orgId, userId)) {
      return reply.code(409).send({ error: 'cannot remove the last super_admin' });
    }
    await deps.organizations.removeMember(orgId, userId);
    return { ok: true };
  });

  // ── Spaces (workspaces) ─────────────────────────────────────────────────
  app.get('/api/spaces', async (req) => deps.spaces.listForUser(uid(req)));

  app.get('/api/organizations/:orgId/workspaces', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const role = await requireOrgRole(req, reply, orgId, ORG_ROLES);
    if (!role) return reply;
    // Members see only the workspaces they have access to; admins see all.
    return role === 'member'
      ? deps.spaces.listForUserInOrg(uid(req), orgId)
      : deps.spaces.listForOrg(orgId);
  });

  app.post('/api/spaces', async (req, reply) => {
    const { name, orgId } = (req.body ?? {}) as { name?: string; orgId?: string };
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
    // If orgId is omitted, fall back to the user's first org (typical for
    // single-org installs and the legacy single-user core).
    let targetOrg = orgId;
    if (!targetOrg) {
      const orgs = await deps.organizations.listForUser(uid(req));
      if (orgs.length === 0)
        return reply.code(400).send({ error: 'no organization — create one first' });
      targetOrg = orgs[0].id;
    } else {
      if (!(await requireOrgRole(req, reply, targetOrg, ['super_admin', 'admin']))) return reply;
    }
    return reply.code(201).send(await deps.spaces.create(targetOrg, name.trim(), uid(req)));
  });

  app.put('/api/spaces/:spaceId', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireWorkspaceRole(req, reply, spaceId, ['admin']))) return reply;
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
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
    if (!email?.trim()) return reply.code(400).send({ error: 'email required' });
    const r = role ?? 'editor';
    if (!isWorkspaceRole(r)) return reply.code(400).send({ error: `invalid role: ${r}` });
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
    const { tag, folder } = req.query as { tag?: string; folder?: string };
    let notes = await deps.notes.list(spaceId);
    if (tag) {
      const ids = new Set(await deps.tags.noteIdsByTag(spaceId, tag));
      notes = notes.filter((n) => ids.has(n.id));
    }
    if (folder !== undefined) {
      const target = folder === 'root' ? null : folder;
      notes = notes.filter((n) => n.folderId === target);
    }
    return notes;
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

  app.post('/api/spaces/:spaceId/notes', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const { title, contentMd, folderId } = (req.body ?? {}) as {
      title?: string;
      contentMd?: string;
      folderId?: string | null;
    };
    if (!title?.trim()) return reply.code(400).send({ error: 'title required' });
    return reply
      .code(201)
      .send(await deps.notes.create({ spaceId, title, contentMd, folderId }));
  });

  app.get('/api/notes/:id', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    return note ?? reply.code(404).send({ error: 'not found' });
  });

  app.put('/api/notes/:id', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'not found' });
    return deps.notes.update(
      note.id,
      (req.body ?? {}) as { title?: string; contentMd?: string; folderId?: string | null },
    );
  });

  app.delete('/api/notes/:id', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'not found' });
    await deps.notes.delete(note.id);
    return { ok: true };
  });

  // Backlinks: notes that link to this one
  app.get('/api/notes/:id/backlinks', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'not found' });
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
  app.get('/api/notes/:id/related', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'not found' });
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
  app.post('/api/notes/:id/append', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'not found' });
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content?.trim()) return reply.code(400).send({ error: 'content required' });
    if (deps.collab) {
      await applyServerEdit(
        {
          auth: deps.auth,
          notes: deps.collab.notesRepo,
          yjs: deps.collab.yjs,
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
    return deps.notes.update(note.id, { contentMd: next });
  });

  // --- Search ---
  app.post('/api/search', async (req, reply) => {
    const { query, spaceId, topK } = (req.body ?? {}) as {
      query?: string;
      spaceId?: string;
      topK?: number;
    };
    let space = spaceId;
    if (!space) space = (await deps.spaces.listForUser(uid(req)))[0]?.id;
    if (!space) return [];
    if (!(await requireMember(req, reply, space))) return reply;
    const mode = (req.body as { mode?: 'hybrid' | 'keyword' | 'semantic' })?.mode ?? 'hybrid';
    return deps.search.search(space, query ?? '', topK ?? 5, mode);
  });

  // Instance info (embeddings provider + version + authenticated user)
  app.get('/api/info', async (req) => {
    const base = deps.info ?? { embedder: 'local', version: '0.1.0' };
    const user = await deps.users.findById(uid(req));
    return { ...base, user: user ? { email: user.email } : null };
  });

  app.get('/api/update/check', async () => {
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
      return { current, latest: null, hasUpdate: false, error: (e as Error).message };
    }
  });

  // Space stats (for the home + settings)
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
  ): Promise<string | null> {
    const space = await deps.folders.spaceOf(id);
    if (!space || !(await deps.spaces.isMember(space, uid(req)))) {
      reply.code(404).send({ error: 'not found' });
      return null;
    }
    return space;
  }

  app.get('/api/spaces/:spaceId/folders', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    return deps.folders.list(spaceId);
  });

  app.post('/api/spaces/:spaceId/folders', async (req, reply) => {
    const { spaceId } = req.params as { spaceId: string };
    if (!(await requireMember(req, reply, spaceId))) return reply;
    const { name, parentId } = (req.body ?? {}) as { name?: string; parentId?: string | null };
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
    return reply.code(201).send(await deps.folders.create(spaceId, name.trim(), parentId ?? null));
  });

  app.put('/api/folders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await authorizeFolder(req, reply, id))) return reply;
    const { name, parentId } = (req.body ?? {}) as { name?: string; parentId?: string | null };
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

  // --- Favourite toggle ---
  app.put('/api/notes/:id/favorite', async (req, reply) => {
    const note = await loadAuthorizedNote(req);
    if (!note) return reply.code(404).send({ error: 'not found' });
    const { favorite } = (req.body ?? {}) as { favorite?: boolean };
    if (typeof favorite !== 'boolean')
      return reply.code(400).send({ error: 'favorite boolean required' });
    return deps.notes.setFavorite(note.id, favorite);
  });

  // --- Bulk delete (per-note authorisation) ---
  app.post('/api/notes/delete-many', async (req, reply) => {
    const { ids } = (req.body ?? {}) as { ids?: string[] };
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids required' });
    const authorized: string[] = [];
    for (const id of ids) {
      const note = await deps.notes.get(id);
      if (note && (await deps.spaces.isMember(note.spaceId, uid(req)))) authorized.push(id);
    }
    const deleted = await deps.notes.deleteManyIds(authorized);
    return { deleted };
  });

  // --- Access tokens (to connect Claude/Copilot via MCP) ---
  app.post('/api/tokens', async (req, reply) => {
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
    return reply.code(201).send({ token, ...info }); // cleartext token is shown ONLY once
  });

  app.get('/api/tokens', async (req) => deps.tokens.list(uid(req)));

  app.delete('/api/tokens/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deps.tokens.revoke(uid(req), id);
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  // Panic button — revokes EVERY token of the caller. Used when the user
  // suspects credential leak (laptop stolen, password reuse spotted). Returns
  // the count so the UI can show "5 tokens revoked".
  app.post('/api/tokens/revoke-all', async (req) => {
    const revoked = await deps.tokens.revokeAllForUser(uid(req));
    return { revoked };
  });

  // --- Admin: CSV bulk import users (Fase 1.2) ---
  // Endpoint POST /api/admin/orgs/:orgId/users/import-csv
  //   body: { csv: string, dryRun?: boolean }
  //   returns: { rows: CsvUserRow[], errors: CsvParseError[],
  //              created?: number, updated?: number, skipped?: number }
  // Only super_admin / admin de la org puede importar.
  app.post('/api/admin/orgs/:orgId/users/import-csv', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const role = await deps.organizations.roleOf(orgId, uid(req));
    if (role !== 'super_admin' && role !== 'admin') {
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

    let created = 0;
    let updated = 0;
    for (const row of rows) {
      const r = await deps.users.upsertFromCsv({
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
      });
      if (r.outcome === 'created') created++;
      else updated++;
    }
    return { rows, errors, separator, applied: true, created, updated };
  });

  // --- Org-scoped tokens (with granular scopes) ---
  // Differ from user tokens in two ways:
  //   1. They belong to the org (no userId; survive when the creator leaves).
  //   2. They MUST declare scopes; an empty scopes array would be a footgun
  //      (acts as the org's full identity). The repository enforces this.
  // Only org admins / super_admins can manage them.
  const VALID_SCOPES = new Set(['read', 'write', 'admin']);
  function validateScopes(scopes: unknown): string[] | null {
    if (!Array.isArray(scopes) || scopes.length === 0) return null;
    const out: string[] = [];
    for (const s of scopes) {
      if (typeof s !== 'string') return null;
      // Plain scopes or namespaced `space:<id>` / `org:<id>`.
      if (VALID_SCOPES.has(s) || /^(space|org):[A-Za-z0-9_-]+$/.test(s)) {
        out.push(s);
      } else {
        return null;
      }
    }
    return out;
  }

  app.post('/api/organizations/:orgId/tokens', async (req, reply) => {
    // Org-scoped tokens are a multi-tenant concept. In local mode a single
    // user already has personal API keys (/api/api-keys), so org tokens are
    // both redundant and confusing — refuse to mint them.
    if (deps.info?.authMode !== 'server') {
      return reply.code(403).send({ error: 'org tokens require server mode' });
    }
    const { orgId } = req.params as { orgId: string };
    if (!(await requireOrgRole(req, reply, orgId, ['super_admin', 'admin']))) return reply;
    const { name, scopes } = (req.body ?? {}) as { name?: string; scopes?: unknown };
    const cleanScopes = validateScopes(scopes);
    if (!cleanScopes) {
      return reply.code(400).send({
        error:
          'scopes required: non-empty array of read|write|admin|space:<id>|org:<id>',
      });
    }
    const { token, info } = await deps.tokens.createOrgToken(
      orgId,
      name?.trim() || 'org-token',
      cleanScopes as Parameters<typeof deps.tokens.createOrgToken>[2],
    );
    return reply.code(201).send({ token, ...info });
  });

  app.get('/api/organizations/:orgId/tokens', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    if (!(await requireOrgRole(req, reply, orgId, ['super_admin', 'admin']))) return reply;
    return deps.tokens.listForOrg(orgId);
  });

  app.delete('/api/organizations/:orgId/tokens/:id', async (req, reply) => {
    // Symmetric with POST above: even revoking an org token only makes sense
    // when org tokens exist at all (server mode).
    if (deps.info?.authMode !== 'server') {
      return reply.code(403).send({ error: 'org tokens require server mode' });
    }
    const { orgId, id } = req.params as { orgId: string; id: string };
    if (!(await requireOrgRole(req, reply, orgId, ['super_admin', 'admin']))) return reply;
    const ok = await deps.tokens.revokeOrgToken(orgId, id);
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  registerMcp(app, deps);
  registerPasskeyRoutes(app, deps);
  return app;
}
