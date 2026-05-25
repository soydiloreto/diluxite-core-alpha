import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import {
  DeterministicEmbeddingProvider,
  NotesService,
  SearchService,
  TokenAuthProvider,
} from '@diluxite/core';
import {
  createDb,
  DrizzleNotesRepository,
  DrizzleSearchRepository,
  DrizzleSpacesRepository,
  DrizzleUsersRepository,
} from '@diluxite/db';
import { buildApp } from '../src/app';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

const A = { authorization: 'Bearer tokA' };
const B = { authorization: 'Bearer tokB' };

describe('API multiusuario: aislamiento y compartir (seguridad RS-2)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceAId: string;

  beforeEach(async () => {
    const clean = createDb(TEST_DATABASE_URL);
    await clean.sql`TRUNCATE chunks, notas, miembros, espacios, usuarios RESTART IDENTITY CASCADE`;
    await clean.sql.end();

    const conn = createDb(TEST_DATABASE_URL);
    sql = conn.sql;
    const { db } = conn;

    const users = new DrizzleUsersRepository(db);
    const spaces = new DrizzleSpacesRepository(db);
    const a = await users.create('a@diluxite');
    await users.create('b@diluxite');
    const spaceA = await spaces.create('Espacio A', a.id);
    spaceAId = spaceA.id;

    const notesRepo = new DrizzleNotesRepository(db);
    const search = new SearchService(
      new DrizzleSearchRepository(db),
      new DeterministicEmbeddingProvider(1536),
      notesRepo,
    );
    const notes = new NotesService(notesRepo, search);
    const auth = new TokenAuthProvider(
      new Map([
        ['tokA', a.id],
        ['tokB', (await users.findByEmail('b@diluxite'))!.id],
      ]),
    );

    app = buildApp({ notes, search, spaces, users, auth });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('sin token => 401', async () => {
    expect((await app.inject({ url: '/api/spaces' })).statusCode).toBe(401);
  });

  it('aislamiento: B no puede ver ni acceder a las notas de A', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/notes`,
      headers: A,
      payload: { titulo: 'Secreto', contenidoMd: 'datos privados' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    expect((await app.inject({ url: `/api/spaces/${spaceAId}/notes`, headers: B })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/notes/${id}`, headers: B })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/notes/${id}`, headers: A })).statusCode).toBe(200);
  });

  it('compartir: tras invitar a B, accede a todo el espacio', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/notes`,
      headers: A,
      payload: { titulo: 'N', contenidoMd: 'x' },
    });
    const id = create.json().id;

    const invite = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/members`,
      headers: A,
      payload: { email: 'b@diluxite' },
    });
    expect(invite.statusCode).toBe(200);

    expect((await app.inject({ url: `/api/spaces/${spaceAId}/notes`, headers: B })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/notes/${id}`, headers: B })).statusCode).toBe(200);
  });

  it('un no-owner no puede invitar', async () => {
    const invite = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/members`,
      headers: B,
      payload: { email: 'a@diluxite' },
    });
    expect(invite.statusCode).toBe(403);
  });
});
