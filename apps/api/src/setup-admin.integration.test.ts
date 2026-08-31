import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TokenAuthProvider } from '@diluxite/core';
import { createDb } from '@diluxite/db';
import { buildApp } from './app';
import { buildCoreDeps } from './services';

/**
 * Who owns the installation — ADR-005.
 *
 * `setup_admin` exists because instance-wide settings had nobody to belong to:
 * the embedding provider is one per installation, so its routes had no
 * organisation to scope by, and the bar ended up being "admin of any
 * organisation" — which on a shared installation let one tenant change what
 * every other tenant searched with.
 *
 * The other half of the definition matters as much: owning the installation is
 * NOT owning what is stored in it. An operator who hosts customers is not
 * thereby entitled to read their notes, and that is asserted here rather than
 * left as an intention.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

const OWNER = { authorization: 'Bearer owner' };     // setup_admin
const TENANT = { authorization: 'Bearer tenant' };   // org_admin of their own org

describe('the installation has an owner', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sql: ReturnType<typeof createDb>['sql'];
  let core: Awaited<ReturnType<typeof buildCoreDeps>>;
  let tenantOrg: string;
  let tenantSpace: string;
  let secret: string;

  beforeAll(async () => {
    const clean = createDb(TEST_DATABASE_URL);
    await clean.sql`TRUNCATE chunks, notes, memberships, spaces, users RESTART IDENTITY CASCADE`;
    await clean.sql.end();

    core = await buildCoreDeps(TEST_DATABASE_URL);
    sql = core.sql;

    const owner = await core.deps.users.create('owner@setup.test');
    const tenant = await core.deps.users.create('tenant@setup.test');
    await sql`UPDATE users SET setup_admin = true WHERE id = ${owner.id}`;
    await sql`UPDATE users SET setup_admin = false WHERE id = ${tenant.id}`;

    // The owner is deliberately given NO organisation. Owning the
    // installation is not membership in anything.
    const org = await core.deps.organizations.create('Tenant SA', `t-${Date.now()}`, tenant.id);
    tenantOrg = org.id;

    app = await buildApp({
      ...core.deps,
      auth: new TokenAuthProvider(
        new Map([
          ['owner', owner.id],
          ['tenant', tenant.id],
        ]),
      ),
    });
    await app.ready();

    const space = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      headers: TENANT,
      payload: { orgId: tenantOrg, name: 'Del inquilino' },
    });
    expect(space.statusCode).toBe(201);
    tenantSpace = space.json().id as string;

    secret = `secreto-del-inquilino-${Date.now()}`;
    const note = await app.inject({
      method: 'POST',
      url: `/api/spaces/${tenantSpace}/notes`,
      headers: TENANT,
      payload: { title: 'Privada', contentMd: `# Privada\n\n${secret}\n` },
    });
    expect(note.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it('a tenant admin cannot add another tenant to the installation', async () => {
    // The instance-wide act that remains after ADR-005 moved the embedding
    // provider to the organisation: creating one. On an installation shared
    // by organisations that do not trust each other, one tenant's admin must
    // not be able to add another.
    const r = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: TENANT,
      payload: { name: 'Colada', slug: `colada-${Date.now()}` },
    });
    // Local mode refuses org creation outright, which is a different refusal
    // and an equally correct one — the point is that the tenant cannot.
    expect([403, 404]).toContain(r.statusCode);
  });

  it("and an organisation's provider is its own, not the installation's", async () => {
    // The mirror image: what used to be instance-wide is now the tenant's, so
    // the tenant admin CAN reach it and the installation owner cannot — they
    // are not a member of that organisation.
    const tenantReads = await app.inject({
      url: `/api/organizations/${tenantOrg}/embeddings/config`,
      headers: TENANT,
    });
    expect(tenantReads.statusCode).toBe(200);

    const ownerReads = await app.inject({
      url: `/api/organizations/${tenantOrg}/embeddings/config`,
      headers: OWNER,
    });
    expect([403, 404]).toContain(ownerReads.statusCode);
  });

  it('and owning the installation is NOT owning the data in it', async () => {
    // The half that keeps an operator from being a silent superuser over
    // their customers. Reading a tenant's notes needs membership in that
    // tenant's organisation, which the owner deliberately does not have.
    const notes = await app.inject({ url: `/api/spaces/${tenantSpace}/notes`, headers: OWNER });
    expect(notes.body).not.toContain(secret);
    expect([403, 404]).toContain(notes.statusCode);

    const search = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: OWNER,
      payload: { query: secret, spaceId: tenantSpace },
    });
    expect(search.body).not.toContain(secret);

    const zip = await app.inject({ url: `/api/spaces/${tenantSpace}/export.zip`, headers: OWNER });
    expect(zip.rawPayload.toString('latin1')).not.toContain(secret);
  });

  it('the tenant still administers their own organisation', async () => {
    // The bar moved for INSTANCE settings only. An org_admin must not have
    // lost anything inside their own organisation.
    const members = await app.inject({
      url: `/api/organizations/${tenantOrg}/members`,
      headers: TENANT,
    });
    expect(members.statusCode).toBe(200);

    const cfg = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${tenantOrg}/search-config`,
      headers: TENANT,
      payload: { mode: 'keyword', topK: 3 },
    });
    expect(cfg.statusCode).toBe(200);
  });

  it('an installation is never left without an owner', async () => {
    // A setting nobody can reach is an installation nobody can fix.
    //
    // The bootstrap makes `local@diluxite` an owner too, so this reduces the
    // installation to exactly one first — otherwise it would be asserting
    // that demoting one of two is refused, which it should not be.
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = 'owner@setup.test'`;
    const others = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE setup_admin = true AND id <> ${ownerId}`;
    for (const o of others) {
      expect(await core.deps.users.setSetupAdmin(o.id, false)).toBe('ok');
    }

    expect(await core.deps.users.setSetupAdmin(ownerId, false)).toBe('would_orphan');
    expect(await core.deps.users.isSetupAdmin(ownerId)).toBe(true);
  });

  it('but a second owner can be appointed, and then the first may step down', async () => {
    const [{ id: tenantId }] = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = 'tenant@setup.test'`;
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = 'owner@setup.test'`;

    expect(await core.deps.users.setSetupAdmin(tenantId, true)).toBe('ok');
    expect(await core.deps.users.setSetupAdmin(ownerId, false)).toBe('ok');
    expect(await core.deps.users.isSetupAdmin(ownerId)).toBe(false);

    // Put it back so the rest of the suite sees the world it expects.
    await core.deps.users.setSetupAdmin(ownerId, true);
    await core.deps.users.setSetupAdmin(tenantId, false);
  });
});
