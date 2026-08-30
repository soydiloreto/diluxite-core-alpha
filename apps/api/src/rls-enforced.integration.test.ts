import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * With the application guards REMOVED, one tenant still cannot read another's
 * rows — ADR-004.
 *
 * This is the only test that distinguishes "RLS is engaged" from "RLS exists".
 * Every other suite passes either way: an instance whose requests never enter
 * the scope behaves exactly like one that does, right up until the day a route
 * ships without its guard. So the guards are mocked open here, deliberately,
 * and what is measured is whether Postgres refuses on its own.
 *
 * If this test can be made to pass with the scope disengaged, it is testing
 * nothing — which is checked by disengaging it, and is why the assertions are
 * about rows the intruder must NOT see rather than about status codes.
 */

// Forced open BEFORE the app is imported: `space-authz` is the single door
// every surface goes through, so this removes the entire application layer.
vi.mock('@diluxite/core', async () => {
  const actual = await vi.importActual<typeof import('@diluxite/core')>('@diluxite/core');
  return {
    ...actual,
    canReadSpace: async () => true,
    canWriteSpace: async () => true,
  };
});

const { TokenAuthProvider } = await import('@diluxite/core');
const { createDb } = await import('@diluxite/db');
const { buildApp } = await import('./app');
const { buildCoreDeps } = await import('./services');

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

const OWNER = { authorization: 'Bearer owner' };
const INTRUDER = { authorization: 'Bearer intruder' };

describe('RLS is engaged, not merely present', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sql: ReturnType<typeof createDb>['sql'];
  let spaceA: string;
  let noteA: string;
  let secret: string;

  beforeAll(async () => {
    const clean = createDb(TEST_DATABASE_URL);
    await clean.sql`TRUNCATE chunks, notes, memberships, spaces, users RESTART IDENTITY CASCADE`;
    await clean.sql.end();

    const core = await buildCoreDeps(TEST_DATABASE_URL);
    sql = core.sql;

    const owner = await core.deps.users.create('owner@rls.test');
    const intruder = await core.deps.users.create('intruder@rls.test');
    const orgA = await core.deps.organizations.create('RLS A', `rls-a-${Date.now()}`, owner.id);
    await core.deps.organizations.create('RLS B', `rls-b-${Date.now()}`, intruder.id);

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

    const space = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      headers: OWNER,
      payload: { orgId: orgA.id, name: 'Confidencial' },
    });
    expect(space.statusCode).toBe(201);
    spaceA = space.json().id as string;

    secret = `dato-confidencial-${Date.now()}`;
    const note = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceA}/notes`,
      headers: OWNER,
      payload: { title: 'Secreto de A', contentMd: `# Secreto\n\n${secret}\n` },
    });
    expect(note.statusCode).toBe(201);
    noteA = note.json().id as string;
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it('the guards really are open — otherwise this suite proves nothing', async () => {
    // The control. If `space-authz` were still refusing, every assertion below
    // would pass for the wrong reason and this file would be decoration.
    const { canReadSpace } = await import('@diluxite/core');
    expect(await canReadSpace({} as never, {} as never, 'cualquiera')).toBe(true);
  });

  it('the owner still reads their own note — the door is open both ways', async () => {
    const r = await app.inject({ url: `/api/notes/${noteA}`, headers: OWNER });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(secret);
  });

  it('the intruder is refused the note, by the database', async () => {
    const r = await app.inject({ url: `/api/notes/${noteA}`, headers: INTRUDER });
    expect(r.body).not.toContain(secret);
    expect([403, 404]).toContain(r.statusCode);
  });

  it('the intruder lists the workspace and gets nothing', async () => {
    const r = await app.inject({ url: `/api/spaces/${spaceA}/notes`, headers: INTRUDER });
    expect(r.body).not.toContain(secret);
    expect(r.body).not.toContain('Secreto de A');
  });

  it('search does not reach across either', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: INTRUDER,
      payload: { query: secret, spaceId: spaceA },
    });
    expect(r.body).not.toContain(secret);
  });

  it('the export hands over an archive with none of it', async () => {
    const r = await app.inject({ url: `/api/spaces/${spaceA}/export.zip`, headers: INTRUDER });
    // Whatever it answers, the bytes must not carry another tenant's note.
    expect(r.rawPayload.toString('latin1')).not.toContain(secret);
  });

  it('MCP does not reach across either, with the guards open', async () => {
    // MCP resolves its own identity outside the request pipeline, so it
    // publishes its own scope. Before this it ran privileged — the same shape
    // of hole that once made the workspace role mean nothing on this surface.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;

    const post = async (body: unknown, token: string, sid?: string) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          ...(sid ? { 'mcp-session-id': sid } : {}),
        },
        body: JSON.stringify(body),
      });

    const init = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'rls', version: '0' } },
      },
      'intruder',
    );
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id')!;
    await init.body?.cancel();

    const call = await post(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_note', arguments: { id: noteA } },
      },
      'intruder',
      sid,
    );
    expect(await call.text()).not.toContain(secret);
  });

  it('a write from the intruder does not land', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/notes/${noteA}`,
      headers: INTRUDER,
      payload: { contentMd: 'pisada por otra organización' },
    });
    const [row] = await sql<{ content_md: string }[]>`
      SELECT content_md FROM notes WHERE id = ${noteA}`;
    expect(row.content_md).toContain(secret);
  });
});
