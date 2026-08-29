import { describe, it, expect } from 'vitest';
import {
  exportWorkspace,
  frontmatter,
  safeSegment,
  type ExportableFolder,
  type ExportableNote,
} from './export-markdown';

const note = (over: Partial<ExportableNote> = {}): ExportableNote => ({
  id: 'n1',
  title: 'Nota',
  contentMd: '# Nota\n\ncuerpo\n',
  folderId: null,
  ...over,
});

describe('safeSegment', () => {
  it('keeps a normal title intact, accents and all', () => {
    expect(safeSegment('Métricas del trimestre')).toBe('Métricas del trimestre');
  });

  it('cannot escape the archive', () => {
    // The whole point: a title is data, and this one is an attempt to write
    // outside the folder the user unzipped into.
    expect(safeSegment('../../etc/passwd')).toBe('..-..-etc-passwd');
    expect(safeSegment('/absolute')).toBe('-absolute');
    expect(safeSegment('C:\\Windows\\System32')).toBe('C--Windows-System32');
  });

  it('drops the characters Windows refuses', () => {
    expect(safeSegment('a*b?c"d<e>f|g')).toBe('a-b-c-d-e-f-g');
  });

  it('drops control characters rather than writing them into a filename', () => {
    expect(safeSegment('nota\u0000con\u001bcontrol')).toBe('nota-con-control');
  });

  it('trims the trailing dots and spaces Windows silently eats', () => {
    // Left alone, "Nota." and "Nota" become the same file on Windows and one
    // note disappears without an error anywhere.
    expect(safeSegment('Nota. ')).toBe('Nota');
  });

  it('sidesteps the reserved device names', () => {
    expect(safeSegment('CON')).toBe('CON-');
    expect(safeSegment('lpt1')).toBe('lpt1-');
    expect(safeSegment('console')).toBe('console');
  });

  it('caps a very long title without leaving a trailing dot', () => {
    const s = safeSegment(`${'a'.repeat(200)}.`);
    expect(s.length).toBeLessThanOrEqual(120);
    expect(s.endsWith('.')).toBe(false);
  });

  it('falls back rather than producing an empty name', () => {
    expect(safeSegment('   ')).toBe('untitled');
    expect(safeSegment('...')).toBe('untitled');
  });
});

describe('frontmatter', () => {
  it('carries what the body cannot', () => {
    const fm = frontmatter(
      note({ createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z', favorite: true }),
    );
    expect(fm).toBe(
      '---\n' +
        'id: "n1"\n' +
        'title: "Nota"\n' +
        'created: "2026-08-01T00:00:00Z"\n' +
        'updated: "2026-08-02T00:00:00Z"\n' +
        'favorite: true\n' +
        '---\n\n',
    );
  });

  it('escapes a title that would break the YAML', () => {
    expect(frontmatter(note({ title: 'He said "hi"\\' }))).toContain(
      'title: "He said \\"hi\\"\\\\"',
    );
  });

  it('takes the Date the repository hands over, not only a string', () => {
    expect(frontmatter(note({ createdAt: new Date('2026-08-01T10:20:30Z') }))).toContain(
      'created: "2026-08-01T10:20:30.000Z"',
    );
  });

  it('says nothing about tags — they are already in the body', () => {
    // A second copy of the tags in frontmatter is a second copy to disagree
    // with the first the moment someone edits the file.
    expect(frontmatter(note({ contentMd: 'texto #uno #dos' }))).not.toContain('tags');
  });
});

describe('exportWorkspace', () => {
  const folders: ExportableFolder[] = [
    { id: 'f1', name: 'Proyectos', parentId: null },
    { id: 'f2', name: 'Diluxite', parentId: 'f1' },
  ];

  it('mirrors the folder tree', () => {
    const files = exportWorkspace(
      [note({ id: 'a', title: 'Raíz' }), note({ id: 'b', title: 'Hija', folderId: 'f2' })],
      folders,
    );
    expect(files.map((f) => f.path)).toEqual(['Raíz.md', 'Proyectos/Diluxite/Hija.md']);
  });

  it('keeps the body verbatim, wikilinks and tags included', () => {
    const body = 'ver [[Otra nota]] y #proyecto\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
    const [file] = exportWorkspace([note({ contentMd: body })], []);
    expect(file.content.endsWith(body)).toBe(true);
  });

  it('does not let sanitisation collapse two notes into one file', () => {
    // Titles are unique per space, so the collisions come from cleaning them:
    // these three are three live notes that all reduce to `Nota-uno`.
    const files = exportWorkspace(
      [
        note({ id: 'a', title: 'Nota/uno' }),
        note({ id: 'b', title: 'Nota-uno' }),
        note({ id: 'c', title: 'Nota:uno' }),
      ],
      [],
    );
    expect(files.map((f) => f.path)).toEqual([
      'Nota-uno.md',
      'Nota-uno (2).md',
      'Nota-uno (3).md',
    ]);
  });

  it('treats a collision case-insensitively, as macOS and Windows do', () => {
    // Two distinct live notes — the unique index is case-sensitive, the
    // filesystems most people unzip onto are not.
    const files = exportWorkspace(
      [note({ id: 'a', title: 'Reunión' }), note({ id: 'b', title: 'REUNIÓN' })],
      [],
    );
    expect(files[1].path).toBe('REUNIÓN (2).md');
  });

  it('separates a title that only differs by a trailing dot', () => {
    // Windows drops the dot, so both would land on `Nota.md`.
    const files = exportWorkspace(
      [note({ id: 'a', title: 'Nota' }), note({ id: 'b', title: 'Nota.' })],
      [],
    );
    expect(files.map((f) => f.path)).toEqual(['Nota.md', 'Nota (2).md']);
  });

  it('separates same-titled notes that live in different folders', () => {
    const files = exportWorkspace(
      [note({ id: 'a', title: 'Notas', folderId: 'f1' }), note({ id: 'b', title: 'Notas', folderId: 'f2' })],
      folders,
    );
    expect(files.map((f) => f.path)).toEqual([
      'Proyectos/Notas.md',
      'Proyectos/Diluxite/Notas.md',
    ]);
  });

  it('puts a note with a missing folder at the root rather than losing it', () => {
    const files = exportWorkspace([note({ folderId: 'gone' })], folders);
    expect(files[0].path).toBe('Nota.md');
  });

  it('survives a cycle in the folder parents instead of hanging', () => {
    const cyclic: ExportableFolder[] = [
      { id: 'x', name: 'X', parentId: 'y' },
      { id: 'y', name: 'Y', parentId: 'x' },
    ];
    const files = exportWorkspace([note({ folderId: 'x' })], cyclic);
    expect(files[0].path).toMatch(/^(X\/Y|Y\/X)\/Nota\.md$/);
  });

  it('exports nothing for an empty workspace', () => {
    expect(exportWorkspace([], folders)).toEqual([]);
  });
});
