import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { NotesService, SearchService, DeterministicEmbeddingProvider } from '@diluxite/core';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleNotesRepository } from './notes-repository';
import { DrizzleSearchRepository } from './search-repository';
import { ensureSingleUserBootstrap } from './spaces-repository';

const { sql, db } = getTestDb();

afterAll(async () => {
  await sql.end();
});

describe('Búsqueda híbrida (integración pgvector + FTS)', () => {
  let espacioId: string;
  let search: SearchService;
  let notesSvc: NotesService;

  beforeEach(async () => {
    await truncateAll(sql);
    ({ espacioId } = await ensureSingleUserBootstrap(db));
    const notesRepo = new DrizzleNotesRepository(db);
    const searchRepo = new DrizzleSearchRepository(db);
    search = new SearchService(searchRepo, new DeterministicEmbeddingProvider(1536), notesRepo);
    notesSvc = new NotesService(notesRepo, search); // crea => indexa

    await notesSvc.create({
      espacioId,
      titulo: 'Azure',
      contenidoMd: 'Azure es la nube de Microsoft, una plataforma cloud.',
    });
    await notesSvc.create({
      espacioId,
      titulo: 'MUG',
      contenidoMd: 'Microsoft User Group, comunidad de usuarios técnicos.',
    });
    await notesSvc.create({
      espacioId,
      titulo: 'Cocina',
      contenidoMd: 'Recetas de pastas, tartas y postres caseros.',
    });
    await notesSvc.create({
      espacioId,
      titulo: 'Infra',
      contenidoMd: 'Usamos pgvector para guardar los vectores en Postgres.',
    });
  });

  it('búsqueda semántica: "la nube de microsoft" => Azure primero', async () => {
    const r = await search.search(espacioId, 'la nube de microsoft');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].titulo).toBe('Azure');
  });

  it('búsqueda por término exacto: "pgvector" => Infra', async () => {
    const r = await search.search(espacioId, 'pgvector');
    expect(r[0].titulo).toBe('Infra');
  });

  it('búsqueda temática: "recetas" => Cocina', async () => {
    const r = await search.search(espacioId, 'recetas');
    expect(r[0].titulo).toBe('Cocina');
  });

  it('aislamiento por espacio: no devuelve notas de otro espacio', async () => {
    const r = await search.search('00000000-0000-0000-0000-000000000000', 'microsoft');
    expect(r).toEqual([]);
  });

  it('borrar una nota la saca de la búsqueda', async () => {
    const infra = (await notesSvc.list(espacioId)).find((n) => n.titulo === 'Infra')!;
    await notesSvc.delete(infra.id);
    const r = await search.search(espacioId, 'pgvector');
    expect(r.find((x) => x.titulo === 'Infra')).toBeUndefined();
  });
});
