import { describe, it, expect, beforeEach } from 'vitest';
import { NotesService, type Note, type NoteIndexer } from './notes';
import { InMemoryNotesRepository } from './notes-memory';

const SPACE = 'space-1';

describe('NotesService', () => {
  let clock: number;
  let repo: InMemoryNotesRepository;
  let svc: NotesService;
  let indexed: Note[];
  let removed: string[];
  let indexer: NoteIndexer;

  beforeEach(() => {
    clock = 1000;
    repo = new InMemoryNotesRepository(() => new Date(clock));
    indexed = [];
    removed = [];
    indexer = {
      index: async (n) => void indexed.push(n),
      remove: async (id) => void removed.push(id),
    };
    svc = new NotesService(repo, indexer);
  });

  it('crea una nota con id y timestamps, y la indexa', async () => {
    const n = await svc.create({ espacioId: SPACE, titulo: 'Hola', contenidoMd: 'mundo' });
    expect(n.id).toBeTruthy();
    expect(n.titulo).toBe('Hola');
    expect(n.creado.getTime()).toBe(1000);
    expect(n.modificado.getTime()).toBe(1000);
    expect(indexed).toHaveLength(1);
    expect(indexed[0].id).toBe(n.id);
  });

  it('lee y lista notas del espacio', async () => {
    const a = await svc.create({ espacioId: SPACE, titulo: 'A' });
    await svc.create({ espacioId: 'otro', titulo: 'B' });
    expect((await svc.get(a.id))?.titulo).toBe('A');
    const list = await svc.list(SPACE);
    expect(list.map((n) => n.titulo)).toEqual(['A']);
  });

  it('actualiza contenido y bumpea modificado, reindexando', async () => {
    const n = await svc.create({ espacioId: SPACE, titulo: 'T', contenidoMd: 'v1' });
    clock = 5000;
    const upd = await svc.update(n.id, { contenidoMd: 'v2' });
    expect(upd?.contenidoMd).toBe('v2');
    expect(upd?.modificado.getTime()).toBe(5000);
    expect(upd?.creado.getTime()).toBe(1000);
    expect(indexed).toHaveLength(2); // create + update
  });

  it('borra y notifica al indexer', async () => {
    const n = await svc.create({ espacioId: SPACE, titulo: 'X' });
    expect(await svc.delete(n.id)).toBe(true);
    expect(await svc.get(n.id)).toBeNull();
    expect(removed).toEqual([n.id]);
    expect(await svc.delete('inexistente')).toBe(false);
  });

  it('openOrCreate crea si no existe y reusa si existe', async () => {
    const first = await svc.openOrCreate(SPACE, 'MUG');
    expect(first.contenidoMd).toContain('# MUG');
    const second = await svc.openOrCreate(SPACE, 'MUG');
    expect(second.id).toBe(first.id);
    expect((await svc.list(SPACE)).length).toBe(1);
  });

  it('extrae los wikilinks salientes de una nota', async () => {
    const n = await svc.create({
      espacioId: SPACE,
      titulo: 'Ideas',
      contenidoMd: 'ver [[ConoSurTech]] y [[MUG|el grupo]] y [[ConoSurTech]]',
    });
    expect(svc.outgoingLinks(n)).toEqual(['ConoSurTech', 'MUG']);
  });
});
