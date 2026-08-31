import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import { createDb } from '@diluxite/db';
import { buildCoreDeps } from './services';

/**
 * Integration del onboarding local → server (lo que dispara `install.sh` al
 * cambiar de modo): renombrar `local@diluxite` al email del admin (promoción) y
 * arrancar en modo server debe:
 *
 *   1. Conservar al MISMO usuario (mismo id) → conserva sus notas/space/org.
 *   2. Seguir siendo org_admin de la org local.
 *   3. Que `bootstrapServerAdmin` le aplique el password (hash PBKDF2).
 *   4. NUNCA guardar el password en texto plano (solo el hash `pbkdf2$...`).
 *
 * El install.sh hace el rename por SQL (sin secretos) y deja que la APP haga el
 * hash del password — este test prueba justamente esa coordinación.
 */

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

function clearServerEnv() {
  delete process.env.DILUXITE_AUTH_MODE;
  delete process.env.DILUXITE_ADMIN_EMAIL;
  delete process.env.DILUXITE_ADMIN_PASSWORD;
}

describe('admin promotion — local → server super admin', () => {
  let sql: Sql;

  beforeEach(async () => {
    const c = createDb(TEST_URL);
    sql = c.sql;
    await sql`TRUNCATE chunks, notes, memberships, spaces, users RESTART IDENTITY CASCADE`;
    clearServerEnv();
  });

  afterEach(async () => {
    clearServerEnv();
    await sql.end();
  });

  it('keeps the same user (notes + org_admin) and applies a hashed password', async () => {
    // 1. Local bootstrap + a note owned by local@diluxite.
    const local = await buildCoreDeps(TEST_URL);
    const localUserId = local.userId;
    const spaceId = local.defaultSpaceId;
    await local.sql`INSERT INTO notes (space_id, title) VALUES (${spaceId}, 'mi nota local')`;
    await local.sql.end();

    // 2. Promotion — exactly what install.sh runs (rename, no secret).
    await sql`
      UPDATE users SET email = 'admin@x.com'
      WHERE email = 'local@diluxite'
        AND NOT EXISTS (SELECT 1 FROM users WHERE email = 'admin@x.com')`;

    // 3. Boot in server mode with the admin env the installer writes.
    process.env.DILUXITE_AUTH_MODE = 'server';
    process.env.DILUXITE_ADMIN_EMAIL = 'admin@x.com';
    process.env.DILUXITE_ADMIN_PASSWORD = 'superseguro123';
    const server = await buildCoreDeps(TEST_URL);
    expect(server.authMode).toBe('server');
    await server.sql.end();

    // 4a. Same user id (rename preserved identity), password hashed.
    const [admin] = await sql<{ id: string; password_hash: string | null }[]>`
      SELECT id, password_hash FROM users WHERE email = 'admin@x.com'`;
    expect(admin).toBeTruthy();
    expect(admin.id).toBe(localUserId);
    expect(admin.password_hash).toBeTruthy();
    expect(String(admin.password_hash)).toMatch(/^pbkdf2\$/); // hashed, NOT plaintext
    expect(String(admin.password_hash)).not.toContain('superseguro123');

    // 4b. The note still belongs to that user's space (data preserved).
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM notes nt JOIN spaces s ON s.id = nt.space_id
      WHERE s.owner_id = ${localUserId}`;
    expect(n).toBe(1);

    // 4c. Still org_admin of the local org.
    const roles = await sql<{ role: string }[]>`
      SELECT role FROM org_memberships WHERE user_id = ${localUserId}`;
    expect(roles.map((r) => r.role)).toContain('org_admin');
  });

  it('booting server without a prior local user creates a fresh admin (no crash)', async () => {
    process.env.DILUXITE_AUTH_MODE = 'server';
    process.env.DILUXITE_ADMIN_EMAIL = 'fresh@x.com';
    process.env.DILUXITE_ADMIN_PASSWORD = 'anotherpass123';
    const server = await buildCoreDeps(TEST_URL);
    await server.sql.end();

    const [admin] = await sql<{ password_hash: string | null }[]>`
      SELECT password_hash FROM users WHERE email = 'fresh@x.com'`;
    expect(admin).toBeTruthy();
    expect(String(admin.password_hash)).toMatch(/^pbkdf2\$/);
  });

  it('reset-admin flow: clearing the hash makes the next boot re-apply the password', async () => {
    // Initial server boot creates the admin.
    process.env.DILUXITE_AUTH_MODE = 'server';
    process.env.DILUXITE_ADMIN_EMAIL = 'admin@x.com';
    process.env.DILUXITE_ADMIN_PASSWORD = 'firstpass123';
    await (await buildCoreDeps(TEST_URL)).sql.end();
    const [before] = await sql<{ password_hash: string }[]>`
      SELECT password_hash FROM users WHERE email = 'admin@x.com'`;

    // install.sh --reset-admin: clear the hash, set a NEW password, reboot.
    await sql`UPDATE users SET password_hash = NULL WHERE email = 'admin@x.com'`;
    process.env.DILUXITE_ADMIN_PASSWORD = 'newpass456';
    await (await buildCoreDeps(TEST_URL)).sql.end();

    const [after] = await sql<{ password_hash: string }[]>`
      SELECT password_hash FROM users WHERE email = 'admin@x.com'`;
    expect(after.password_hash).toBeTruthy();
    expect(after.password_hash).not.toBe(before.password_hash); // re-hashed (new salt + new pw)
    expect(String(after.password_hash)).toMatch(/^pbkdf2\$/);
  });
});
