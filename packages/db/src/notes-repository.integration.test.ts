import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { NotesService } from '@diluxite/core';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleNotesRepository } from './notes-repository';
import { ensureSingleUserBootstrap, DrizzleSpacesRepository } from './spaces-repository';

const { sql, db } = getTestDb();

afterAll(async () => {
  await sql.end();
});

describe('DrizzleNotesRepository (integración Postgres)', () => {
  let espacioId: string;
  let repo: DrizzleNotesRepository;

  beforeEach(async () => {
    await truncateAll(sql);
    ({ espacioId } = await ensureSingleUserBootstrap(db));
    repo = new DrizzleNotesRepository(db);
  });

  it('bootstrap es idempotente', async () => {
    const a = await ensureSingleUserBootstrap(db);
    const b = await ensureSingleUserBootstrap(db);
    expect(a.userId).toBe(b.userId);
    expect(a.espacioId).toBe(b.espacioId);
  });

  it('crea y recupera por id', async () => {
    const n = await repo.create({ espacioId, titulo: 'Azure', contenidoMd: 'la nube' });
    expect(n.id).toBeTruthy();
    expect(n.creado).toBeInstanceOf(Date);
    const got = await repo.findById(n.id);
    expect(got?.titulo).toBe('Azure');
  });

  it('lista por espacio ordenado por modificado desc', async () => {
    await repo.create({ espacioId, titulo: 'vieja', contenidoMd: '' });
    const nueva = await repo.create({ espacioId, titulo: 'nueva', contenidoMd: '' });
    const list = await repo.list(espacioId);
    expect(list[0].id).toBe(nueva.id);
    expect(list).toHaveLength(2);
  });

  it('actualiza y borra', async () => {
    const n = await repo.create({ espacioId, titulo: 'T', contenidoMd: 'v1' });
    const upd = await repo.update(n.id, { contenidoMd: 'v2' });
    expect(upd?.contenidoMd).toBe('v2');
    expect(await repo.delete(n.id)).toBe(true);
    expect(await repo.findById(n.id)).toBeNull();
  });

  it('findByTitulo respeta el espacio', async () => {
    await repo.create({ espacioId, titulo: 'Única', contenidoMd: '' });
    expect((await repo.findByTitulo(espacioId, 'Única'))?.titulo).toBe('Única');
    expect(await repo.findByTitulo(espacioId, 'noexiste')).toBeNull();
  });

  it('funciona como NotesRepository del NotesService (openOrCreate)', async () => {
    const svc = new NotesService(repo);
    const a = await svc.openOrCreate(espacioId, 'MUG');
    const b = await svc.openOrCreate(espacioId, 'MUG');
    expect(b.id).toBe(a.id);
  });

  it('DrizzleSpacesRepository lista el espacio del usuario', async () => {
    const { userId } = await ensureSingleUserBootstrap(db);
    const spaces = await new DrizzleSpacesRepository(db).listForUser(userId);
    expect(spaces.length).toBeGreaterThanOrEqual(1);
  });
});
