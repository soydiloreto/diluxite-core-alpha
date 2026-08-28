import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createDb,
  DrizzleNotesRepository,
  DrizzleOrganizationsRepository,
  DrizzleSpacesRepository,
  DrizzleYjsStateRepository,
} from '@diluxite/db';
import { bearerToken, type AuthHeaders } from '@diluxite/core';
import { buildApp } from './app';
import { buildCollabServer, noteDocName } from './collab';
import { buildTestApp, TEST_DATABASE_URL } from '../test/helpers';

/**
 * MCP server e2e con un cliente MCP REAL (el mismo SDK que usan Claude/Copilot/
 * Codex) sobre Streamable HTTP. Cubrimos el "segundo cerebro" completo: las 10
 * tools, además de los caminos de seguridad (sin auth → rechazo) y de
 * autorización (no podés tocar un space del que no sos miembro).
 */

function textOf(res: unknown): string {
  return ((res as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n');
}
function idOf(listText: string, title: string): string | undefined {
  return listText.match(new RegExp(`${title}\\s*\\(id:\\s*([0-9a-f-]+)\\)`, 'i'))?.[1];
}

async function connectClient(port: number): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

describe('MCP server — second-brain tools (real MCP client)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let client: Client;
  let userId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    userId = t.userId;
    await app.listen({ port: 0, host: '127.0.0.1' });
    client = await connectClient((app.server.address() as AddressInfo).port);
  });

  afterEach(async () => {
    await client.close();
    await app.close();
    await sql.end();
  });

  it('lists all seventeen memory tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'append_to_note',
        'backlinks_of',
        'delete_folder',
        'delete_note',
        'list_folders',
        'list_notes',
        'list_spaces',
        'list_tags',
        'move_note',
        'purge_note',
        'read_note',
        'read_notes',
        'recent_notes',
        'search_by_tag',
        'search_memory',
        'write_note',
        'write_notes',
      ].sort(),
    );
  });

  it('write_note + search_memory: stores and retrieves a memory by meaning', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Azure', content: 'Azure is the Microsoft cloud' },
    });
    const res = await client.callTool({
      name: 'search_memory',
      arguments: { query: 'the microsoft cloud' },
    });
    expect(textOf(res)).toContain('Azure');
  });

  it('write_note files a new note in a folder path, creating what is missing', async () => {
    const res = await client.callTool({
      name: 'write_note',
      arguments: { title: 'Daily', content: 'today', folder: 'Dailies/2026-08' },
    });
    expect(textOf(res)).toContain('in Dailies/2026-08');

    const [row] = await sql`
      select f.name as folder, p.name as parent
      from notes n join folders f on f.id = n.folder_id
      join folders p on p.id = f.parent_id
      where n.title = 'Daily'`;
    expect(row).toMatchObject({ folder: '2026-08', parent: 'Dailies' });
  });

  it('write_note reuses an existing folder path instead of duplicating it', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'One', content: 'a', folder: 'Dailies/2026-08' },
    });
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Two', content: 'b', folder: 'dailies/2026-08' },
    });

    const folders = await sql`select name from folders`;
    expect(folders).toHaveLength(2);
  });

  it('write_note never moves a note that already exists', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Fixed', content: 'a' } });
    const res = await client.callTool({
      name: 'write_note',
      arguments: { title: 'Fixed', content: 'b', folder: 'Somewhere/Else' },
    });

    // The reply states where the note really is — the root, not the path asked for.
    expect(textOf(res)).not.toContain('in Somewhere/Else');
    const [row] = await sql`select folder_id from notes where title = 'Fixed'`;
    expect(row.folder_id).toBeNull();
  });

  it('move_note files an existing note into a folder path', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Loose', content: 'x' } });
    const id = idOf(textOf(await client.callTool({ name: 'list_notes', arguments: {} })), 'Loose');

    const res = await client.callTool({
      name: 'move_note',
      arguments: { id, folder: 'Archive/2026' },
    });
    expect(textOf(res)).toContain('Moved "Loose" to Archive/2026');

    const [row] = await sql`
      select f.name as folder from notes n join folders f on f.id = n.folder_id
      where n.title = 'Loose'`;
    expect(row.folder).toBe('2026');
  });

  it('move_note with no folder sends the note back to the root', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Filed', content: 'x', folder: 'Deep/Down' },
    });
    const id = idOf(textOf(await client.callTool({ name: 'list_notes', arguments: {} })), 'Filed');

    const res = await client.callTool({ name: 'move_note', arguments: { id } });
    expect(textOf(res)).toContain('to the root');

    const [row] = await sql`select folder_id from notes where title = 'Filed'`;
    expect(row.folder_id).toBeNull();
  });

  it('move_note refuses an id it cannot reach', async () => {
    const res = await client.callTool({
      name: 'move_note',
      arguments: { id: '00000000-0000-0000-0000-000000000000', folder: 'Nope' },
    });
    expect(textOf(res)).toBe('Not found.');
    const folders = await sql`select name from folders`;
    expect(folders).toHaveLength(0);
  });

  it('delete_folder removes an empty folder', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Tmp', content: 'x', folder: 'Empty/Inner' },
    });
    // Move the note out so 'Empty/Inner' is genuinely empty.
    const id = idOf(textOf(await client.callTool({ name: 'list_notes', arguments: {} })), 'Tmp');
    await client.callTool({ name: 'move_note', arguments: { id } });

    const res = await client.callTool({
      name: 'delete_folder',
      arguments: { folder: 'Empty/Inner' },
    });
    expect(textOf(res)).toContain('Deleted the empty folder');
    expect(await sql`select name from folders`).toHaveLength(1);
  });

  it('delete_folder refuses a folder that holds something, and deletes nothing', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Keep', content: 'x', folder: 'Full/Inner' },
    });

    const res = await client.callTool({ name: 'delete_folder', arguments: { folder: 'Full' } });
    expect(textOf(res)).toContain('1 note and 1 subfolder');
    expect(textOf(res)).toContain('recursive: true');

    // Nothing was touched — the refusal has to be a no-op, not a partial delete.
    expect(await sql`select name from folders`).toHaveLength(2);
    expect(await sql`select title from notes where title = 'Keep'`).toHaveLength(1);
  });

  it('delete_folder with recursive erases the subtree and its notes for good', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Doomed', content: 'x', folder: 'Full/Inner' },
    });
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Safe', content: 'x', folder: 'Other' },
    });

    const res = await client.callTool({
      name: 'delete_folder',
      arguments: { folder: 'Full', recursive: true },
    });
    expect(textOf(res)).toContain('and everything inside: 1 note and 1 subfolder');
    expect(textOf(res)).toContain('This was permanent.');

    // Erased, not trashed: the row is gone, so it cannot be restored.
    expect(await sql`select title from notes where title = 'Doomed'`).toHaveLength(0);
    expect(await sql`select title from notes where title = 'Safe'`).toHaveLength(1);
    expect(await sql`select name from folders`).toHaveLength(1);
  });

  it('delete_folder on an unknown path is a no-op', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Kept', content: 'x', folder: 'Real' },
    });

    const res = await client.callTool({
      name: 'delete_folder',
      arguments: { folder: 'Real/Nope', recursive: true },
    });
    expect(textOf(res)).toBe('Not found.');
    expect(await sql`select name from folders`).toHaveLength(1);
  });

  it('list_folders shows the paths the other tools take, with note counts', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'One', content: 'x', folder: 'Dailies/2026-08' },
    });
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Two', content: 'x', folder: 'Dailies/2026-08' },
    });
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Three', content: 'x', folder: 'Archive' },
    });

    const text = textOf(await client.callTool({ name: 'list_folders', arguments: {} }));

    // Sorted, child after parent, and the count is what sits DIRECTLY inside.
    expect(text.split('\n')).toEqual([
      '- Archive (1 note)',
      '- Dailies (0 notes)',
      '- Dailies/2026-08 (2 notes)',
    ]);
  });

  it('list_folders says so when there are none', async () => {
    expect(textOf(await client.callTool({ name: 'list_folders', arguments: {} }))).toBe(
      'No folders.',
    );
  });

  it('read_note returns the full content of a note by id', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Doc', content: 'full body here' } });
    const list = textOf(await client.callTool({ name: 'list_notes', arguments: {} }));
    const id = idOf(list, 'Doc');
    expect(id).toBeTruthy();
    const read = textOf(await client.callTool({ name: 'read_note', arguments: { id } }));
    expect(read).toContain('full body here');
  });

  it('write_notes creates a batch and says which were new', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Old', content: 'v1' } });

    const text = textOf(
      await client.callTool({
        name: 'write_notes',
        arguments: {
          notes: [
            { title: 'Old', content: 'v2' },
            { title: 'New', content: 'fresh', folder: 'Dailies/2026-08' },
          ],
        },
      }),
    );

    // created vs updated per item: "saved 2 notes" would hide the overwrite.
    expect(text).toContain('Updated "Old"');
    expect(text).toContain('Created "New" in Dailies/2026-08');

    const [old] = await sql`select content_md from notes where title = 'Old'`;
    expect(old.content_md).toBe('v2');
  });

  it('write_notes reports a failed item and still writes the rest', async () => {
    const text = textOf(
      await client.callTool({
        name: 'write_notes',
        arguments: {
          notes: [
            { title: 'Good', content: 'ok' },
            { title: '', content: 'no title' },
            { title: 'AlsoGood', content: 'ok' },
          ],
        },
      }),
    );

    expect(text).toContain('"Good"');
    expect(text).toContain('"AlsoGood"');
    // The REST route rejects a blank title; the MCP path has to agree, and the
    // batch must survive the bad item.
    expect(text).toContain('Failed');
    expect(await sql`select title from notes where title in ('Good', 'AlsoGood')`).toHaveLength(2);
    expect(await sql`select title from notes where trim(title) = ''`).toHaveLength(0);
  });

  it('write_notes refuses an oversized batch instead of writing part of it', async () => {
    const notes = Array.from({ length: 26 }, (_, i) => ({ title: `N${i}`, content: 'x' }));
    const text = textOf(await client.callTool({ name: 'write_notes', arguments: { notes } }));

    expect(text).toContain('the limit is 25');
    expect(await sql`select title from notes`).toHaveLength(0);
  });

  it('write_notes with an empty batch says so', async () => {
    expect(textOf(await client.callTool({ name: 'write_notes', arguments: { notes: [] } }))).toBe(
      'No notes given.',
    );
  });

  it('write_note rejects a blank title, like the REST route', async () => {
    const res = await client.callTool({
      name: 'write_note',
      arguments: { title: '   ', content: 'body' },
    });
    expect(textOf(res)).toBe('A title is required.');
    expect(await sql`select title from notes`).toHaveLength(0);
  });

  it('read_notes returns several bodies in one call', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'A', content: 'body of A' } });
    await client.callTool({ name: 'write_note', arguments: { title: 'B', content: 'body of B' } });
    const list = textOf(await client.callTool({ name: 'list_notes', arguments: {} }));
    const ids = [idOf(list, 'A'), idOf(list, 'B')];

    const text = textOf(await client.callTool({ name: 'read_notes', arguments: { ids } }));

    expect(text).toContain('## A');
    expect(text).toContain('body of A');
    expect(text).toContain('## B');
    expect(text).toContain('body of B');
  });

  it('read_notes names the ids it could not reach', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'A', content: 'body of A' } });
    const id = idOf(textOf(await client.callTool({ name: 'list_notes', arguments: {} })), 'A');
    const ghost = '00000000-0000-0000-0000-000000000000';

    const text = textOf(await client.callTool({ name: 'read_notes', arguments: { ids: [id, ghost] } }));

    // Silence would read as "that note is empty" rather than "no such note".
    expect(text).toContain('body of A');
    expect(text).toContain(`Not found: ${ghost}`);
  });

  it('read_notes refuses a batch over the limit instead of truncating it', async () => {
    const ids = Array.from({ length: 51 }, () => '00000000-0000-0000-0000-000000000000');
    const text = textOf(await client.callTool({ name: 'read_notes', arguments: { ids } }));
    expect(text).toContain('the limit is 50');
  });

  it('read_notes with no ids says so', async () => {
    expect(textOf(await client.callTool({ name: 'read_notes', arguments: { ids: [] } }))).toBe(
      'No ids given.',
    );
  });

  it('append_to_note lets the AI jot onto an existing memory', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Journal', content: 'line 1' } });
    const id = idOf(textOf(await client.callTool({ name: 'list_notes', arguments: {} })), 'Journal');
    await client.callTool({ name: 'append_to_note', arguments: { id, content: 'line 2' } });
    const read = textOf(await client.callTool({ name: 'read_note', arguments: { id } }));
    expect(read).toContain('line 1');
    expect(read).toContain('line 2');
  });

  it('list_notes and list_spaces', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Note1', content: 'hi' } });
    expect(textOf(await client.callTool({ name: 'list_notes', arguments: {} }))).toContain('Note1');
    expect(textOf(await client.callTool({ name: 'list_spaces', arguments: {} }))).toContain('My space');
  });

  it('list_tags + search_by_tag + recent_notes', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Infra', content: 'uses #pgvector and #azure' },
    });
    expect(textOf(await client.callTool({ name: 'list_tags', arguments: {} }))).toContain('pgvector');
    expect(
      textOf(await client.callTool({ name: 'search_by_tag', arguments: { tag: 'pgvector' } })),
    ).toContain('Infra');
    expect(textOf(await client.callTool({ name: 'recent_notes', arguments: {} }))).toContain('Infra');
  });

  it('backlinks_of lists notes that wikilink to a target', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Target', content: 'the target' } });
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Source', content: 'see [[Target]] for details' },
    });
    const targetId = idOf(textOf(await client.callTool({ name: 'list_notes', arguments: {} })), 'Target');
    const res = textOf(await client.callTool({ name: 'backlinks_of', arguments: { id: targetId } }));
    expect(res).toContain('Source');
  });

  it('delete_note trashes a note (hidden from listings/tags), then purge_note drops it', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Throwaway', content: 'temporary #scratch note' },
    });
    const id = idOf(textOf(await client.callTool({ name: 'list_notes', arguments: {} })), 'Throwaway');

    // Soft delete → gone from listings, search-by-tag and the tag cloud.
    const del = textOf(await client.callTool({ name: 'delete_note', arguments: { id } }));
    expect(del).toMatch(/trash/i);
    expect(textOf(await client.callTool({ name: 'list_notes', arguments: {} }))).not.toContain(
      'Throwaway',
    );
    expect(
      textOf(await client.callTool({ name: 'search_by_tag', arguments: { tag: 'scratch' } })),
    ).not.toContain('Throwaway');
    expect(textOf(await client.callTool({ name: 'list_tags', arguments: {} }))).not.toContain(
      'scratch',
    );

    // Purge the trashed note → permanent.
    const purged = textOf(await client.callTool({ name: 'purge_note', arguments: { id } }));
    expect(purged).toMatch(/permanently deleted/i);
    // Already gone, so a second purge can't find it.
    expect(
      textOf(await client.callTool({ name: 'purge_note', arguments: { id } })),
    ).toMatch(/not found/i);
  });

  it('purge_note refuses a note that is not yet in the trash', async () => {
    await client.callTool({ name: 'write_note', arguments: { title: 'Live', content: 'still here' } });
    const id = idOf(textOf(await client.callTool({ name: 'list_notes', arguments: {} })), 'Live');
    expect(
      textOf(await client.callTool({ name: 'purge_note', arguments: { id } })),
    ).toMatch(/must be in the trash/i);
  });

  it('write_note into a space the user does NOT belong to is refused', async () => {
    // Crear otro usuario + org + space que el single-user NO posee.
    const db = createDb(TEST_DATABASE_URL);
    const [other] = await db.sql<{ id: string }[]>`
      INSERT INTO users (email, provider) VALUES ('stranger@x.com', 'local') RETURNING id`;
    // Unique slug: organizations survive buildTestApp's TRUNCATE, so a fixed
    // value collides when the suite runs twice against the same database.
    const slug = `other-org-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const [org] = await db.sql<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES ('Other', ${slug}) RETURNING id`;
    const [foreign] = await db.sql<{ id: string }[]>`
      INSERT INTO spaces (name, owner_id, org_id) VALUES ('Foreign', ${other.id}, ${org.id}) RETURNING id`;
    await db.sql.end();

    const res = textOf(
      await client.callTool({
        name: 'write_note',
        arguments: { title: 'sneaky', content: 'x', space: foreign.id },
      }),
    );
    expect(res).toMatch(/no space you can write to/i);
    expect(userId).toBeTruthy();
  });
});

describe('MCP server — authentication gate', () => {
  let app: FastifyInstance;
  let sql: Sql;

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('rejects an unauthenticated MCP client (no identity → 401)', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    // Reconstruir la app con un AuthProvider que nunca resuelve identidad.
    await t.app.close();
    app = await buildApp({ ...t.deps, auth: { resolve: async () => null } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const client = new Client({ name: 'anon', version: '0.0.0' });
    await expect(
      client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))),
    ).rejects.toThrow();
  });
});

/**
 * Sessions are NOT credentials: every non-initialize request must re-resolve
 * the Authorization header and match it against the identity the session was
 * created with. A revoked token must stop working on the very next request,
 * and a session id must never be rideable with someone else's token.
 */
describe('MCP server — per-request re-auth + session eviction', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let port: number;
  // token → userId. Deleting an entry simulates revocation.
  const validTokens = new Map<string, string>();

  beforeEach(async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    validTokens.clear();
    validTokens.set('tok-alice', t.userId);
    validTokens.set('tok-mallory', '00000000-0000-4000-8000-000000000bad');
    app = await buildApp({
      ...t.deps,
      auth: {
        async resolve(headers: AuthHeaders) {
          const token = bearerToken(headers);
          const userId = token ? validTokens.get(token) : undefined;
          return userId ? { kind: "user" as const, userId } : null;
        },
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  // Raw JSON-RPC over fetch — the SDK client pins its headers at connect
  // time, and these scenarios need to swap/revoke credentials mid-session.
  async function mcpPost(
    body: unknown,
    headers: Record<string, string>,
  ): Promise<Response> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return res;
  }

  async function initializeSession(token: string): Promise<string> {
    const res = await mcpPost(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'raw-test', version: '0.0.0' },
        },
      },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(200);
    const sid = res.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    await res.body?.cancel();
    return sid!;
  }

  const listTools = (sid: string, token?: string) =>
    mcpPost(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        'mcp-session-id': sid,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    );

  it('a revoked token gets 401 on the NEXT request of an open session', async () => {
    const sid = await initializeSession('tok-alice');

    // Sanity: the session works while the token is valid.
    const ok = await listTools(sid, 'tok-alice');
    expect(ok.status).toBe(200);
    await ok.body?.cancel();

    // Grant a SECOND token to the same user before revoking the first, so we
    // can prove the session survives a 401 and resolves again with a valid
    // credential for the same identity.
    validTokens.set('tok-alice-2', validTokens.get('tok-alice')!);

    // Revoke alice's first token. The session id alone must no longer be enough.
    validTokens.delete('tok-alice');
    const denied = await listTools(sid, 'tok-alice');
    expect(denied.status).toBe(401);

    // The session is NOT evicted on a 401 (a stray bad-credential request must
    // not tear down a session/SSE another request is using). Presenting a
    // still-valid credential for the SAME user resolves the same session again.
    const stillAlive = await listTools(sid, 'tok-alice-2');
    expect(stillAlive.status).toBe(200);
    await stillAlive.body?.cancel();
  });

  it('an unknown / expired session id is answered 404 (so the client can re-init)', async () => {
    // Never-initialized session id, valid credential → 404 (was 400).
    const res = await listTools('00000000-dead-beef-0000-000000000000', 'tok-alice');
    expect(res.status).toBe(404);
  });

  it("a session id used with a DIFFERENT user's token is rejected with 401", async () => {
    const sid = await initializeSession('tok-alice');
    const hijack = await listTools(sid, 'tok-mallory');
    expect(hijack.status).toBe(401);
  });

  it('a session id with NO credentials at all is rejected with 401', async () => {
    const sid = await initializeSession('tok-alice');
    const anon = await listTools(sid);
    expect(anon.status).toBe(401);
  });
});

/**
 * Regression for the "collab flush overwrites MCP writes" data-loss bug:
 * write_note / append_to_note used to write content_md straight to the DB;
 * if the note's Y.Doc was live in Hocuspocus, the next onStoreDocument
 * re-derived content_md from the in-memory doc and silently reverted the
 * write. Both tools now route through applyServerEdit (live DirectConnection).
 */
describe('MCP server — writes survive a live collab doc flush', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let client: Client;
  let hServer: ReturnType<typeof buildCollabServer>;
  let collabDb: ReturnType<typeof createDb>;

  beforeEach(async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();

    collabDb = createDb(TEST_DATABASE_URL);
    const notesRepo = new DrizzleNotesRepository(collabDb.db);
    const yjsRepo = new DrizzleYjsStateRepository(collabDb.db);
    const spacesRepo = new DrizzleSpacesRepository(collabDb.db);
    const orgsRepo = new DrizzleOrganizationsRepository(collabDb.db);
    hServer = buildCollabServer({
      auth: t.deps.auth,
      notes: notesRepo,
      yjs: yjsRepo,
      spaces: spacesRepo, organizations: orgsRepo,
    });
    // Same wiring index.ts does when collab is enabled.
    t.deps.collab = {
      notesRepo,
      yjs: yjsRepo,
      hocuspocus: hServer as unknown as { documents: Map<string, { name: string }> },
    };
    app = await buildApp(t.deps);
    await app.listen({ port: 0, host: '127.0.0.1' });
    client = await connectClient((app.server.address() as AddressInfo).port);
  });

  afterEach(async () => {
    await client.close();
    await hServer.destroy();
    await new Promise((r) => setTimeout(r, 50));
    await collabDb.sql.end();
    await app.close();
    await sql.end();
  });

  it('write_note onto a LIVE doc is not lost when onStoreDocument flushes', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Live', content: 'old content' },
    });
    const list = textOf(await client.callTool({ name: 'list_notes', arguments: {} }));
    const id = idOf(list, 'Live')!;
    expect(id).toBeTruthy();

    // Load the doc into Hocuspocus memory — as if an editor had it open.
    const conn = await hServer.openDirectConnection(noteDocName(id));

    // Replace the body via MCP while the doc is live…
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Live', content: 'NEW CONTENT from MCP' },
    });

    // …then disconnect, which flushes onStoreDocument (content_md is
    // re-derived from the in-memory Y.Doc). Before the fix this reverted
    // the row to 'old content'.
    await conn.disconnect();

    const deadline = Date.now() + 10000;
    let contentMd: string | undefined;
    while (Date.now() < deadline) {
      const rows = await sql<{ content_md: string }[]>`
        SELECT content_md FROM notes WHERE id = ${id}`;
      contentMd = rows[0]?.content_md;
      if (contentMd === 'NEW CONTENT from MCP') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(contentMd).toBe('NEW CONTENT from MCP');
  });

  it('append_to_note onto a LIVE doc survives the flush too', async () => {
    await client.callTool({
      name: 'write_note',
      arguments: { title: 'Jotter', content: 'line 1' },
    });
    const id = idOf(textOf(await client.callTool({ name: 'list_notes', arguments: {} })), 'Jotter')!;

    const conn = await hServer.openDirectConnection(noteDocName(id));
    await client.callTool({ name: 'append_to_note', arguments: { id, content: 'line 2' } });
    await conn.disconnect();

    const deadline = Date.now() + 10000;
    let contentMd: string | undefined;
    while (Date.now() < deadline) {
      const rows = await sql<{ content_md: string }[]>`
        SELECT content_md FROM notes WHERE id = ${id}`;
      contentMd = rows[0]?.content_md;
      if (contentMd === 'line 1\nline 2') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(contentMd).toBe('line 1\nline 2');
  });
});
