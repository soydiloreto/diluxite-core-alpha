import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDb } from './client';

/**
 * "Exactly one live embedding model per organisation" — the guarantee the
 * blue/green flip in ADR-003 rests on, checked at the level that actually
 * holds it.
 *
 * The application flips models inside a transaction and is careful about it,
 * so a test that goes through the repository proves the repository is
 * careful, not that the rule is enforced. These INSERTs go straight at the
 * table: if the constraint is missing, the row lands.
 *
 * The hole this was written for: `org_id` was nullable, and the index is
 * `UNIQUE (org_id) WHERE state = 'active'`. Two NULLs are distinct in
 * Postgres, so any number of organisation-less rows could be active at once.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

const conn = createDb(TEST_DATABASE_URL);
const raw = conn.sql;
let orgId = '';

const stamp = `one-active-${process.pid}`;

beforeAll(async () => {
  const [org] = await raw<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES (${stamp}, ${stamp}) RETURNING id`;
  orgId = org.id;
});

afterAll(async () => {
  await raw`DELETE FROM organizations WHERE id = ${orgId}`;
  await raw.end();
});

async function insert(key: string, state: string, org: string | null) {
  await raw`
    INSERT INTO embedding_models (key, org_id, slot, provider, model, dimensions, state)
    VALUES (${key}, ${org}, ${`${org ?? 'none'}:${key}`}, 'probe', 'm', 8, ${state})`;
}

describe('one live embedding model per organisation', () => {
  it('a second active model in the same organisation is refused', async () => {
    await insert(`${stamp}-a`, 'active', orgId);
    await expect(insert(`${stamp}-b`, 'active', orgId)).rejects.toThrow(
      /embedding_models_one_active_per_org/,
    );
  });

  it('a retired one alongside it is fine — that is what a flip leaves behind', async () => {
    await expect(insert(`${stamp}-c`, 'retired', orgId)).resolves.toBeUndefined();
  });

  it('a model belonging to no organisation cannot exist at all', async () => {
    // Without this the rule above is bypassable: the partial unique index is
    // on `org_id`, and NULLs do not collide with each other.
    await expect(insert(`${stamp}-d`, 'active', null)).rejects.toThrow(/null value|not-null/i);
  });
});
