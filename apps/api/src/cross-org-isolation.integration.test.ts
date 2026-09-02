import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { TokenAuthProvider } from '@diluxite/core';
import { createDb } from '@diluxite/db';
import { buildApp } from './app';
import { buildCoreDeps } from './services';

/**
 * One installation, two organisations, and nothing crosses.
 *
 * The threat model is deliberately the worst one INSIDE the product: the
 * attacker is not a stranger, it is a **org_admin of another organisation**
 * — the most privileged account a tenant can hold. Anything they can reach is
 * something every customer of a shared installation can reach about every
 * other one.
 *
 * The table below is the whole tenant-scoped surface, and the last test
 * compares it against the app's actual route table: a route added later
 * without an entry here FAILS the suite rather than quietly shipping
 * unaudited. That is the property that matters — an isolation suite that
 * only covers the routes someone remembered is an isolation suite that
 * decays.
 *
 * NOTE ON DEPTH: this exercises the APPLICATION layer, which is what enforces
 * isolation at runtime today. Row-Level Security exists in migration 0003 and
 * is proven correct in `packages/db/src/rls.integration.test.ts`, but the
 * shipped API connects as a role with BYPASSRLS and never publishes
 * `app.current_user_id`, so those policies are not a second layer in
 * production yet. See docs/MULTI-TENANT.md.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

const OWNER = { authorization: 'Bearer owner' };
const INTRUDER = { authorization: 'Bearer intruder' };

/** A request aimed at org A's data, made by org B's org_admin. */
interface Probe {
  /** The Fastify route it exercises, exactly as the route table prints it. */
  route: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: (ctx: Ctx) => string;
  payload?: (ctx: Ctx) => unknown;
  /** Refusal codes that count as isolation holding for this route. */
  refuses?: number[];
}

interface Ctx {
  orgA: string;
  spaceA: string;
  noteA: string;
  versionA: string;
  folderA: string;
  userA: string;
  tokenA: string;
}

const REFUSED = [401, 403, 404];

const PROBES: Probe[] = [
  // ── The workspace and everything under it ────────────────────────────
  { route: '/api/spaces/:spaceId|:id (PUT)', method: 'PUT', url: (c) => `/api/spaces/${c.spaceA}`, payload: () => ({ name: 'robada' }) },
  { route: '/api/spaces/:spaceId|:id (DELETE)', method: 'DELETE', url: (c) => `/api/spaces/${c.spaceA}` },
  { route: '/api/spaces/:spaceId|:id/notes (GET)', method: 'GET', url: (c) => `/api/spaces/${c.spaceA}/notes` },
  { route: '/api/spaces/:spaceId|:id/notes (POST)', method: 'POST', url: (c) => `/api/spaces/${c.spaceA}/notes`, payload: () => ({ title: 'intrusa', contentMd: 'x' }) },
  { route: '/api/spaces/:spaceId|:id/tags (GET)', method: 'GET', url: (c) => `/api/spaces/${c.spaceA}/tags` },
  { route: '/api/spaces/:spaceId|:id/trash (GET)', method: 'GET', url: (c) => `/api/spaces/${c.spaceA}/trash` },
  { route: '/api/spaces/:spaceId|:id/trash (DELETE)', method: 'DELETE', url: (c) => `/api/spaces/${c.spaceA}/trash` },
  { route: '/api/spaces/:spaceId|:id/graph (GET)', method: 'GET', url: (c) => `/api/spaces/${c.spaceA}/graph` },
  { route: '/api/spaces/:spaceId|:id/stats (GET)', method: 'GET', url: (c) => `/api/spaces/${c.spaceA}/stats` },
  { route: '/api/spaces/:spaceId|:id/export.zip (GET)', method: 'GET', url: (c) => `/api/spaces/${c.spaceA}/export.zip` },
  { route: '/api/spaces/:spaceId|:id/folders (GET)', method: 'GET', url: (c) => `/api/spaces/${c.spaceA}/folders` },
  { route: '/api/spaces/:spaceId|:id/folders (POST)', method: 'POST', url: (c) => `/api/spaces/${c.spaceA}/folders`, payload: () => ({ name: 'intrusa' }) },
  { route: '/api/spaces/:spaceId|:id/members (GET)', method: 'GET', url: (c) => `/api/spaces/${c.spaceA}/members` },
  { route: '/api/spaces/:spaceId|:id/members (POST)', method: 'POST', url: (c) => `/api/spaces/${c.spaceA}/members`, payload: (c) => ({ userId: c.userA, role: 'admin' }) },
  { route: '/api/spaces/:spaceId|:id/members/:userId (PUT)', method: 'PUT', url: (c) => `/api/spaces/${c.spaceA}/members/${c.userA}`, payload: () => ({ role: 'viewer' }) },
  { route: '/api/spaces/:spaceId|:id/members/:userId (DELETE)', method: 'DELETE', url: (c) => `/api/spaces/${c.spaceA}/members/${c.userA}` },
  { route: '/api/spaces/:spaceId|:id/move (POST)', method: 'POST', url: (c) => `/api/spaces/${c.spaceA}/move`, payload: (c) => ({ noteIds: [c.noteA], folderId: null }) },
  // An import into somebody else's workspace would be the loudest possible
  // write: notes and folders, created wholesale.
  { route: '/api/spaces/:spaceId|:id/import (POST)', method: 'POST', url: (c) => `/api/spaces/${c.spaceA}/import`, payload: () => ({ zipBase64: '', dryRun: true }) },
  // Flipping another organisation's vector space would swap the model every
  // one of its searches is answered from.
  { route: '/api/organizations/:orgId/embeddings/activate (POST)', method: 'POST', url: (c) => `/api/organizations/${c.orgA}/embeddings/activate`, payload: () => ({}) },

  // ── The notes themselves ─────────────────────────────────────────────
  { route: '/api/notes/:id (GET)', method: 'GET', url: (c) => `/api/notes/${c.noteA}` },
  { route: '/api/notes/:id (PUT)', method: 'PUT', url: (c) => `/api/notes/${c.noteA}`, payload: () => ({ contentMd: 'pisada' }) },
  { route: '/api/notes/:id (DELETE)', method: 'DELETE', url: (c) => `/api/notes/${c.noteA}` },
  { route: '/api/notes/:id/versions (GET)', method: 'GET', url: (c) => `/api/notes/${c.noteA}/versions` },
  { route: '/api/notes/:id/versions/:versionId (GET)', method: 'GET', url: (c) => `/api/notes/${c.noteA}/versions/${c.versionA}` },
  { route: '/api/notes/:id/versions/:versionId/restore (POST)', method: 'POST', url: (c) => `/api/notes/${c.noteA}/versions/${c.versionA}/restore`, payload: () => ({}) },
  { route: '/api/notes/:id/restore (POST)', method: 'POST', url: (c) => `/api/notes/${c.noteA}/restore`, payload: () => ({}) },
  { route: '/api/notes/:id/related (GET)', method: 'GET', url: (c) => `/api/notes/${c.noteA}/related` },
  { route: '/api/notes/:id/purge (DELETE)', method: 'DELETE', url: (c) => `/api/notes/${c.noteA}/purge` },
  { route: '/api/notes/:id/backlinks (GET)', method: 'GET', url: (c) => `/api/notes/${c.noteA}/backlinks` },
  { route: '/api/notes/:id/append (POST)', method: 'POST', url: (c) => `/api/notes/${c.noteA}/append`, payload: () => ({ contentMd: 'anexo' }) },
  { route: '/api/notes/:id/favorite (PUT)', method: 'PUT', url: (c) => `/api/notes/${c.noteA}/favorite`, payload: () => ({ favorite: true }) },
  { route: '/api/notes/:id/archive (PUT)', method: 'PUT', url: (c) => `/api/notes/${c.noteA}/archive`, payload: () => ({ archived: true }) },
  { route: '/api/folders/:id (PUT)', method: 'PUT', url: (c) => `/api/folders/${c.folderA}`, payload: () => ({ name: 'robada' }) },
  { route: '/api/folders/:id (DELETE)', method: 'DELETE', url: (c) => `/api/folders/${c.folderA}` },

  // ── Search: the one that reads across everything by design ───────────
  { route: '/api/search (POST)', method: 'POST', url: () => '/api/search', payload: (c) => ({ query: 'confidencial', spaceId: c.spaceA }) },

  // ── The organisation itself ──────────────────────────────────────────
  { route: '/api/organizations/:orgId (GET)', method: 'GET', url: (c) => `/api/organizations/${c.orgA}` },
  { route: '/api/organizations/:orgId (PUT)', method: 'PUT', url: (c) => `/api/organizations/${c.orgA}`, payload: () => ({ name: 'robada' }) },
  { route: '/api/organizations/:orgId (DELETE)', method: 'DELETE', url: (c) => `/api/organizations/${c.orgA}` },
  { route: '/api/organizations/:orgId/search-config (GET)', method: 'GET', url: (c) => `/api/organizations/${c.orgA}/search-config` },
  { route: '/api/organizations/:orgId/search-config (PUT)', method: 'PUT', url: (c) => `/api/organizations/${c.orgA}/search-config`, payload: () => ({ mode: 'keyword', topK: 3 }) },
  { route: '/api/organizations/:orgId/members (GET)', method: 'GET', url: (c) => `/api/organizations/${c.orgA}/members` },
  { route: '/api/organizations/:orgId/members (POST)', method: 'POST', url: (c) => `/api/organizations/${c.orgA}/members`, payload: () => ({ email: 'intruso@x', role: 'admin' }) },
  { route: '/api/organizations/:orgId/members/:userId (PUT)', method: 'PUT', url: (c) => `/api/organizations/${c.orgA}/members/${c.userA}`, payload: () => ({ role: 'org_member' }) },
  { route: '/api/organizations/:orgId/members/:userId (DELETE)', method: 'DELETE', url: (c) => `/api/organizations/${c.orgA}/members/${c.userA}` },
  { route: '/api/organizations/:orgId/workspaces (GET)', method: 'GET', url: (c) => `/api/organizations/${c.orgA}/workspaces` },
  { route: '/api/organizations/:orgId/tokens (GET)', method: 'GET', url: (c) => `/api/organizations/${c.orgA}/tokens` },
  { route: '/api/organizations/:orgId/tokens (POST)', method: 'POST', url: (c) => `/api/organizations/${c.orgA}/tokens`, payload: () => ({ label: 'intruso' }) },
  { route: '/api/organizations/:orgId/tokens/:id (DELETE)', method: 'DELETE', url: (c) => `/api/organizations/${c.orgA}/tokens/${c.tokenA}` },

  // ── Admin surfaces ───────────────────────────────────────────────────
  { route: '/api/admin/orgs/:orgId/auth-policy (GET)', method: 'GET', url: (c) => `/api/admin/orgs/${c.orgA}/auth-policy` },
  { route: '/api/admin/orgs/:orgId/auth-policy (PUT)', method: 'PUT', url: (c) => `/api/admin/orgs/${c.orgA}/auth-policy`, payload: () => ({ passwordEnabled: false }) },
  { route: '/api/admin/orgs/:orgId/audit (GET)', method: 'GET', url: (c) => `/api/admin/orgs/${c.orgA}/audit` },
  { route: '/api/admin/orgs/:orgId/users/import-csv (POST)', method: 'POST', url: (c) => `/api/admin/orgs/${c.orgA}/users/import-csv`, payload: () => ({ csv: 'email,role\nx@y,member' }) },
  { route: '/api/admin/embeddings (GET)', method: 'GET', url: (c) => `/api/admin/embeddings?orgId=${c.orgA}` },
  // ADR-005: an organisation's embedding provider is its own choice, so these
  // are ordinary tenant-scoped routes. Before it they were instance-wide with
  // no organisation to scope by, and the bar was "admin of any organisation" —
  // one tenant changing what every other tenant searched with.
  { route: '/api/organizations/:orgId/embeddings/config (GET)', method: 'GET', url: (c) => `/api/organizations/${c.orgA}/embeddings/config` },
  { route: '/api/organizations/:orgId/embeddings/config (PUT)', method: 'PUT', url: (c) => `/api/organizations/${c.orgA}/embeddings/config`, payload: () => ({ provider: 'local', model: null, dimensions: 512, endpoint: null }) },
  { route: '/api/organizations/:orgId/embeddings/test (POST)', method: 'POST', url: (c) => `/api/organizations/${c.orgA}/embeddings/test`, payload: () => ({ provider: 'local', model: null, dimensions: 512, endpoint: null }) },
  { route: '/api/admin/reindex (POST)', method: 'POST', url: () => '/api/admin/reindex', payload: (c) => ({ orgId: c.orgA }) },
];

describe('one installation, two organisations', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let ctx: Ctx;
  let mcpPort: number;
  let ctxOrgB: string;
  let core: Awaited<ReturnType<typeof buildCoreDeps>>;

  beforeAll(async () => {
    const clean = createDb(TEST_DATABASE_URL);
    await clean.sql`TRUNCATE chunks, notes, memberships, spaces, users RESTART IDENTITY CASCADE`;
    await clean.sql.end();

    core = await buildCoreDeps(TEST_DATABASE_URL);
    sql = core.sql;

    const owner = await core.deps.users.create('owner@a.test');
    const intruder = await core.deps.users.create('intruder@b.test');

    // Two organisations, each with ITS OWN org_admin. `create` makes the
    // creator org_admin of the org it creates — the strongest role a tenant
    // has, and therefore the right attacker.
    const orgA = await core.deps.organizations.create('Org A', `a-${Date.now()}`, owner.id);
    ctxOrgB = (await core.deps.organizations.create('Org B', `b-${Date.now()}`, intruder.id)).id;

    app = await buildApp({
      ...core.deps,
      auth: new TokenAuthProvider(
        new Map([
          ['owner', owner.id],
          ['intruder', intruder.id],
        ]),
      ),
    });
    await app.ready();
    // A real socket: the MCP transport is exercised over HTTP, not injected.
    await app.listen({ port: 0, host: '127.0.0.1' });
    mcpPort = (app.server.address() as AddressInfo).port;

    // Org A's contents, created by its own owner through the API.
    const space = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      headers: OWNER,
      payload: { orgId: orgA.id, name: 'Confidencial' },
    });
    expect(space.statusCode).toBe(201);
    const spaceA = space.json().id as string;

    const folder = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceA}/folders`,
      headers: OWNER,
      payload: { name: 'Interno' },
    });
    expect(folder.statusCode).toBe(201);

    const note = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceA}/notes`,
      headers: OWNER,
      payload: { title: 'Secreto de A', contentMd: '# Secreto\n\ndato confidencial de A\n' },
    });
    expect(note.statusCode).toBe(201);
    const noteA = note.json().id as string;

    // A second save so there is a version to try to read.
    await app.inject({
      method: 'PUT',
      url: `/api/notes/${noteA}`,
      headers: OWNER,
      payload: { contentMd: '# Secreto\n\ndato confidencial de A, v2\n' },
    });
    const versions = await app.inject({ url: `/api/notes/${noteA}/versions`, headers: OWNER });
    const versionList = versions.statusCode === 200 ? (versions.json() as { id: string }[]) : [];

    const token = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgA.id}/tokens`,
      headers: OWNER,
      payload: { label: 'de A' },
    });

    ctx = {
      orgA: orgA.id,
      spaceA,
      noteA,
      versionA: versionList[0]?.id ?? '00000000-0000-0000-0000-000000000000',
      folderA: folder.json().id as string,
      userA: owner.id,
      tokenA: token.statusCode === 201 ? (token.json().id as string) : '00000000-0000-0000-0000-000000000000',
    };
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it('the control: org A\'s own org_admin CAN read org A', async () => {
    // Without this the suite could pass by refusing everyone, which is not
    // isolation — it is an outage.
    const r = await app.inject({ url: `/api/spaces/${ctx.spaceA}/notes`, headers: OWNER });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(1);
  });

  it('the listings show org B nothing of org A', async () => {
    const orgs = await app.inject({ url: '/api/organizations', headers: INTRUDER });
    expect(orgs.statusCode).toBe(200);
    expect((orgs.json() as { id: string }[]).map((o) => o.id)).not.toContain(ctx.orgA);

    const spaces = await app.inject({ url: '/api/spaces', headers: INTRUDER });
    expect(spaces.statusCode).toBe(200);
    expect((spaces.json() as { id: string }[]).map((s) => s.id)).not.toContain(ctx.spaceA);
  });

  it.each(PROBES.map((p) => [p.route, p] as const))(
    'org B\'s org_admin is refused: %s',
    async (_route, probe) => {
      const res = await app.inject({
        method: probe.method,
        url: probe.url(ctx),
        headers: INTRUDER,
        ...(probe.payload ? { payload: probe.payload(ctx) as object } : {}),
      });

      // A 404 from Fastify's router means the URL in the probe is wrong, and
      // the whole assertion below would pass for the wrong reason — the
      // single easiest way to write an isolation suite that tests nothing.
      expect(
        /"message":"Route [A-Z]+:[^"]* not found"/.test(res.body),
        `the probe URL does not match a route: ${probe.method} ${probe.url(ctx)}`,
      ).toBe(false);
      // Nor may a 400 stand in for a refusal: a malformed payload never
      // reaches the authorisation check.
      expect(res.statusCode, `${probe.method} ${probe.url(ctx)} answered a validation error`).not.toBe(400);

      expect(probe.refuses ?? REFUSED).toContain(res.statusCode);
    },
  );

  // ── MCP: the surface the product exists for ──────────────────────────
  //
  // An agent reads the brain through MCP, so a hole here is a hole in the
  // whole proposition. It also had one: the tools checked bare membership
  // and ignored the workspace role, which is why they now go through the
  // same `space-authz` door as REST.

  async function mcpPost(body: unknown, token: string, sid?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...(sid ? { 'mcp-session-id': sid } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function mcpSession(token: string): Promise<string> {
    const res = await mcpPost(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'cross-org', version: '0.0.0' },
        },
      },
      token,
    );
    expect(res.status).toBe(200);
    const sid = res.headers.get('mcp-session-id')!;
    await res.body?.cancel();
    return sid;
  }

  async function mcpCall(
    token: string,
    sid: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const res = await mcpPost(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
      token,
      sid,
    );
    const raw = await res.text();
    const line = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    const json = JSON.parse((line ?? raw).replace(/^data:\s*/, ''));
    return (json.result?.content ?? []).map((c: { text: string }) => c.text).join('\n');
  }

  it('MCP: the control — org A reads org A', async () => {
    const sid = await mcpSession('owner');
    expect(await mcpCall('owner', sid, 'read_note', { id: ctx.noteA })).toContain('confidencial');
  });

  it('MCP: org B cannot read, search or list its way into org A', async () => {
    const sid = await mcpSession('intruder');

    expect(await mcpCall('intruder', sid, 'read_note', { id: ctx.noteA })).not.toContain(
      'dato confidencial de A',
    );
    // Naming the space explicitly must not help either.
    expect(
      await mcpCall('intruder', sid, 'search_memory', { query: 'confidencial', space: ctx.spaceA }),
    ).not.toContain('dato confidencial de A');
    expect(await mcpCall('intruder', sid, 'list_notes', { space: ctx.spaceA })).not.toContain(
      'Secreto de A',
    );
    expect(await mcpCall('intruder', sid, 'list_spaces', {})).not.toContain(ctx.spaceA);
    expect(await mcpCall('intruder', sid, 'recent_notes', {})).not.toContain('Secreto de A');
  });

  it('MCP: org B cannot write into org A either', async () => {
    const sid = await mcpSession('intruder');
    await mcpCall('intruder', sid, 'write_note', {
      title: 'Colada',
      content: 'no debería entrar',
      space: ctx.spaceA,
    });
    await mcpCall('intruder', sid, 'append_to_note', { id: ctx.noteA, content: '\n\nanexo ajeno' });
    await mcpCall('intruder', sid, 'delete_note', { id: ctx.noteA });

    // Read back as the owner: the workspace is untouched.
    const notes = await app.inject({ url: `/api/spaces/${ctx.spaceA}/notes`, headers: OWNER });
    const titles = (notes.json() as { title: string; contentMd: string }[]).map((n) => n.title);
    expect(titles).toEqual(['Secreto de A']);
    const body = (notes.json() as { contentMd: string }[])[0].contentMd;
    expect(body).not.toContain('anexo ajeno');
  });

  it('the shared users table does NOT let another org rewrite a person\'s name', async () => {
    // `users` is global by design — one account can belong to several
    // organisations — and it is the one tenant-adjacent table with no RLS.
    // The CSV import upserts by email, which used to let org B's admin write
    // the profile of somebody in org A. Bounded (only first and last name,
    // never credentials or memberships) but still theirs, so it is now scoped
    // the way an invite already was: people in THIS organisation, or people
    // who do not exist yet.
    const before = await core.deps.users.findByEmail('owner@a.test');
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/orgs/${ctxOrgB}/users/import-csv`,
      headers: INTRUDER,
      payload: { csv: 'email,firstName,lastName\nowner@a.test,Renombrado,PorOtraOrg' },
    });
    expect(res.statusCode).toBe(200);
    // Skipped rather than silently doing less: the import says so.
    expect(res.json().skipped).toBe(1);
    expect(res.json().updated).toBe(0);

    const after = await core.deps.users.findByEmail('owner@a.test');
    expect(after!.firstName).toBe(before!.firstName);
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(after!.active).toBe(before!.active);
    const orgs = await core.deps.organizations.listForUser(after!.id);
    expect(orgs.map((o) => o.id)).toEqual([ctx.orgA]);
  });

  it('but it still imports its OWN people, and creates genuinely new ones', async () => {
    // The half a scoping rule is easy to break: an import that refuses
    // everybody is not a fix, it is an outage.
    const fresh = `nueva-${Date.now()}@b.test`;
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/orgs/${ctxOrgB}/users/import-csv`,
      headers: INTRUDER,
      payload: { csv: `email,firstName,lastName\n${fresh},Nueva,Persona` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(1);
    expect(res.json().skipped).toBe(0);
    expect((await core.deps.users.findByEmail(fresh))!.firstName).toBe('Nueva');
  });

  it('bulk delete refuses outright when the caller may touch none of it', async () => {
    // It used to answer `200 {deleted: 0}` — a success code for a request
    // that was entirely refused, indistinguishable from "there was nothing to
    // delete". Nothing leaked and nothing was deleted; the answer was simply
    // not true.
    const res = await app.inject({
      method: 'POST',
      url: '/api/notes/delete-many',
      headers: INTRUDER,
      payload: { ids: [ctx.noteA] },
    });
    expect(res.statusCode).toBe(403);

    const still = await app.inject({ url: `/api/notes/${ctx.noteA}`, headers: OWNER });
    expect(still.statusCode, "org A's note was deleted by org B").toBe(200);
  });

  it('bulk tag refuses outright, and does not edit org A\'s note', async () => {
    // Same shape as `delete-many`: nothing the caller may touch means 403,
    // not a 200 with a zero count. And the note it could not tag must come
    // back byte-identical — a tag is an EDIT to the markdown, so a leak here
    // would be a write into another organisation's note.
    const before = await app.inject({ url: `/api/notes/${ctx.noteA}`, headers: OWNER });
    expect(before.statusCode).toBe(200);
    const original = (before.json() as { contentMd: string }).contentMd;

    const res = await app.inject({
      method: 'POST',
      url: '/api/notes/tag-many',
      headers: INTRUDER,
      payload: { ids: [ctx.noteA], add: ['intruso'] },
    });
    expect(res.statusCode).toBe(403);

    const after = await app.inject({ url: `/api/notes/${ctx.noteA}`, headers: OWNER });
    expect((after.json() as { contentMd: string }).contentMd, "org B edited org A's note").toBe(
      original,
    );
  });

  it('a refused search does not leak org A\'s text in the body either', async () => {
    // A 200 with zero results would still be isolation; a body carrying the
    // secret would not. Checked separately because the status code alone
    // cannot tell the two apart.
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: INTRUDER,
      payload: { query: 'confidencial', spaceId: ctx.spaceA },
    });
    expect(res.body).not.toContain('dato confidencial de A');
  });

  it('every tenant-scoped route in the app has a probe here', async () => {
    // The property that keeps this suite honest as the API grows: a new
    // route touching :spaceId, :orgId or a note id must appear above, or
    // this fails. An isolation suite that only covers what someone
    // remembered is one that decays silently.
    const printed = app.printRoutes({ commonPrefix: false });
    const covered = new Set(PROBES.map((p) => p.route));

    // Rebuild "path (METHOD)" pairs from the printed tree.
    const paths: string[] = [];
    const stack: string[] = [];
    for (const line of printed.split('\n')) {
      // Fastify indents exactly four characters per level ("│   ", "├── ").
      const m = /^((?:[│├└]── |│   |    )*)(\S+)\s*(?:\(([A-Z, ]+)\))?/.exec(line);
      if (!m || !m[2]) continue;
      const depth = m[1].length / 4;
      stack.length = depth;
      stack[depth] = m[2];
      if (!m[3]) continue;
      const full = stack.slice(0, depth + 1).join('');
      for (const method of m[3].split(',').map((x) => x.trim())) {
        if (method === 'HEAD') continue;
        paths.push(`${full} (${method})`);
      }
    }
    // The parser is load-bearing: if it produced nothing, the comparison
    // below would pass by comparing two empty sets.
    expect(paths.length, 'the route tree could not be parsed').toBeGreaterThan(30);

    const tenantScoped = paths.filter(
      (p) =>
        (/:spaceId|:orgId|\/api\/notes\/|\/api\/folders\/|\/api\/admin\//.test(p) ||
          p.startsWith('/api/search')) &&
        !p.startsWith('/api/auth'),
    );
    // `delete-many` has a test of its own above (it answers 200 by design).
    covered.add('/api/notes/delete-many (POST)');
    // `tag-many` likewise: its probe checks the 403 AND that org A's note came
    // back byte-identical, which a generic PROBES row cannot assert.
    covered.add('/api/notes/tag-many (POST)');
    // The instance-wide embedding routes have their own test above: they are
    // not org-scoped, and the limitation that follows from that is documented
    // there rather than papered over by a refusal this suite would assert.
    covered.add('/api/admin/embeddings/config (GET)');
    covered.add('/api/admin/embeddings/config (PUT)');
    covered.add('/api/admin/embeddings/test (POST)');
    const missing = tenantScoped.filter((p) => !covered.has(p));
    expect(missing, `tenant-scoped routes with no isolation probe:\n${missing.join('\n')}`).toEqual(
      [],
    );
  });
});
