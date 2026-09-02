import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  Y_TEXT_KEY,
  applyServerEdit,
  deriveMarkdown,
  noteDocName,
  parseDocName,
  seedDocFromMarkdown,
} from './collab';
import type { Note, NotesRepository, YjsStateRepository } from '@diluxite/core';

/**
 * Pure unit tests for the collab helpers — no Postgres, no WebSocket.
 *
 * These are the contract the Hocuspocus hooks build on. If these break, the
 * integration tests will rot in confusing ways, so we lock them down first.
 */

describe('parseDocName / noteDocName round-trip', () => {
  const noteId = '550e8400-e29b-41d4-a716-446655440000';

  it('builds a name with the note: prefix', () => {
    expect(noteDocName(noteId)).toBe(`note:${noteId}`);
  });

  it('parses back to the original id (case-insensitive uuid)', () => {
    expect(parseDocName(`note:${noteId}`)).toBe(noteId);
    expect(parseDocName(`note:${noteId.toUpperCase()}`)).toBe(noteId.toUpperCase());
  });

  it('rejects malformed names', () => {
    expect(parseDocName('note:not-a-uuid')).toBeNull();
    expect(parseDocName('other:550e8400-e29b-41d4-a716-446655440000')).toBeNull();
    expect(parseDocName('')).toBeNull();
    expect(parseDocName(`note:${noteId};drop`)).toBeNull();
  });
});

describe('seedDocFromMarkdown + deriveMarkdown', () => {
  it('round-trips an empty document', () => {
    const doc = seedDocFromMarkdown('');
    expect(deriveMarkdown(doc)).toBe('');
  });

  it('round-trips a multiline markdown body verbatim', () => {
    const md = ['# Hola', '', 'Esto es **bold** y un [[wikilink]].', '', '- item 1', '- item 2'].join('\n');
    const doc = seedDocFromMarkdown(md);
    expect(deriveMarkdown(doc)).toBe(md);
  });

  it('writes into the canonical Y_TEXT_KEY', () => {
    const md = 'contenido';
    const doc = seedDocFromMarkdown(md);
    expect(doc.getText(Y_TEXT_KEY).toString()).toBe(md);
  });
});

describe('applyServerEdit', () => {
  // In-memory stand-ins for the two repos collab depends on. We don't reuse
  // notes-memory.ts because that one is wired to NotesService — here we want
  // the bare ports the collab module sees.
  function makeRepos(noteId: string, initialMd: string) {
    const note: Note = {
      id: noteId,
      spaceId: 'space-1',
      folderId: null,
      title: 'Test',
      contentMd: initialMd,
      favorite: false,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const states = new Map<string, Uint8Array>();
    const notes: NotesRepository = {
      async create() {
        throw new Error('not used');
      },
      async findById(id) {
        return id === noteId ? note : null;
      },
      async findByTitle() {
        return null;
      },
      async list() {
        return [note];
      },
      async update(id, patch) {
        if (id !== noteId) return null;
        if (patch.contentMd !== undefined) note.contentMd = patch.contentMd;
        if (patch.title !== undefined) note.title = patch.title;
        note.updatedAt = new Date();
        return note;
      },
      async delete() {
        return true;
      },
      async setFavorite() {
        return note;
      },
      async setArchived() {
        return note;
      },
      async deleteMany() {
        return 0;
      },
    };
    const yjs: YjsStateRepository = {
      async load(id) {
        return states.get(id) ?? null;
      },
      async save(id, state) {
        states.set(id, state);
      },
      async clear(id) {
        states.delete(id);
      },
    };
    return { note, notes, yjs, states };
  }

  it('seeds from contentMd on first edit and persists both state + markdown', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';
    const { note, notes, yjs, states } = makeRepos(noteId, 'hola');

    const markdownAfter = await applyServerEdit(
      { auth: null as never, notes, yjs },
      noteId,
      (text) => text.insert(text.length, ' mundo'),
    );

    expect(markdownAfter).toBe('hola mundo');
    expect(note.contentMd).toBe('hola mundo');
    expect(states.has(noteId)).toBe(true);
    expect(states.get(noteId)!.byteLength).toBeGreaterThan(0);
  });

  it('hydrates from existing yjs_state on subsequent edits (does NOT re-seed)', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';
    const { notes, yjs } = makeRepos(noteId, 'real text');

    // First edit: seeds the doc from contentMd ('real text'), then appends.
    // After this yjs_state is authoritative.
    const afterFirst = await applyServerEdit(
      { auth: null as never, notes, yjs },
      noteId,
      (text) => text.insert(text.length, ' v1'),
    );
    expect(afterFirst).toBe('real text v1');

    // Mutate contentMd out-of-band — simulating something weird (a bad
    // migration, manual SQL). The next edit should NOT re-seed from
    // contentMd; it should pick up the Y.Doc we just persisted.
    const note = await notes.findById(noteId);
    note!.contentMd = 'IGNORE: stale contentMd';

    const afterSecond = await applyServerEdit(
      { auth: null as never, notes, yjs },
      noteId,
      (text) => text.insert(text.length, ' v2'),
    );

    expect(afterSecond).toBe('real text v1 v2');
  });

  it('two concurrent edits applied to the same doc converge (CRDT property)', async () => {
    // Direct Y.Doc concurrency without the repo — proves we're using Y.Text
    // and not String, which would lose one side on every concurrent edit.
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.getText(Y_TEXT_KEY).insert(0, 'hola');

    // Sync initial state A → B
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    expect(docB.getText(Y_TEXT_KEY).toString()).toBe('hola');

    // Concurrent edits: A appends ' world' at end, B prepends 'Buenas, '.
    docA.getText(Y_TEXT_KEY).insert(4, ' world');
    docB.getText(Y_TEXT_KEY).insert(0, 'Buenas, ');

    // Bidirectional merge
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // Both converge to the same string with neither edit lost.
    expect(docA.getText(Y_TEXT_KEY).toString()).toBe(docB.getText(Y_TEXT_KEY).toString());
    expect(docA.getText(Y_TEXT_KEY).toString()).toContain('hola world');
    expect(docA.getText(Y_TEXT_KEY).toString()).toContain('Buenas');
  });
});
