import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { Sql } from 'postgres';
import { createDb } from '@diluxite/db';

/**
 * El seed demo elegía "el primer space" (`LIMIT 1` sin orden) → en una DB con
 * varios workspaces (server mode, o un restore con varios usuarios) caía en el
 * equivocado. Ahora `DILUXITE_SEED_SPACE_ID` lo fuerza al space elegido (lo
 * setea install.sh cuando hay varios). Este test prueba que las notas caen
 * EXACTAMENTE en el space pedido y NO en el otro.
 */

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('seed-demo — DILUXITE_SEED_SPACE_ID targets the chosen workspace', () => {
  let sql: Sql;
  beforeEach(async () => {
    sql = createDb(TEST_URL).sql;
    await sql`TRUNCATE chunks, notes, memberships, spaces, users RESTART IDENTITY CASCADE`;
  });
  afterEach(async () => {
    await sql.end();
  });

  it('seeds into the requested space, not the first one', async () => {
    const [u1] = await sql<{ id: string }[]>`
      INSERT INTO users (email, provider) VALUES ('a@x.com', 'local') RETURNING id`;
    const [u2] = await sql<{ id: string }[]>`
      INSERT INTO users (email, provider) VALUES ('b@x.com', 'local') RETURNING id`;
    const [org] = await sql<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES ('Org', 'org-test') RETURNING id`;
    const [s1] = await sql<{ id: string }[]>`
      INSERT INTO spaces (name, owner_id, org_id) VALUES ('Space 1', ${u1.id}, ${org.id}) RETURNING id`;
    const [s2] = await sql<{ id: string }[]>`
      INSERT INTO spaces (name, owner_id, org_id) VALUES ('Space 2', ${u2.id}, ${org.id}) RETURNING id`;

    // Corre el seed REAL apuntando a s2 (count chico para que sea rápido).
    const COUNT = 4;
    execSync('pnpm exec tsx scripts/seed-demo.ts', {
      cwd: REPO,
      stdio: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL: TEST_URL,
        COUNT: String(COUNT),
        SEED: '1',
        DILUXITE_SEED_SPACE_ID: s2.id,
      },
    });

    const [{ n: n2 }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notes WHERE space_id = ${s2.id}`;
    const [{ n: n1 }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notes WHERE space_id = ${s1.id}`;

    // El seed inserta COUNT notas del plan + 1 nota "Knowledge Hub" (root MOC
    // agregada por el PR #48 / commit ef5e3ca, para tener el panel Neighbors
    // con un caso real-world). Por eso la cuenta esperada es COUNT + 1, no
    // COUNT. Ese mismo +1 va al space elegido — el bug que este test cubre
    // es "todas las notas caen en s2 y NINGUNA en s1", no la cuenta exacta.
    expect(n2).toBe(COUNT + 1); // notas del plan + hub note
    expect(n1).toBe(0); // y NO al otro
  });
});
