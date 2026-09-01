import { describe, it, expect } from 'vitest';
import {
  detectImportFormat,
  notionLinksToWikilinks,
  planImport,
  stripFrontmatter,
  stripNotionId,
  type ImportFile,
} from './import-markdown';
import { exportWorkspace } from './export-markdown';

const f = (path: string, content: string): ImportFile => ({ path, content });

describe('detectImportFormat', () => {
  it('knows an Obsidian vault by its settings folder', () => {
    expect(
      detectImportFormat([f('Vault/.obsidian/app.json', '{}'), f('Vault/Nota.md', 'x')]),
    ).toBe('obsidian');
  });

  it('knows a Notion export by the id on every file', () => {
    expect(
      detectImportFormat([
        f('Export/Roadmap a1b2c3d4e5f67890abcdef1234567890.md', '# Roadmap'),
        f('Export/Notas 0123456789abcdef0123456789abcdef.md', '# Notas'),
      ]),
    ).toBe('notion');
  });

  it('does not call a vault Notion because one note ends in hex', () => {
    // A single such filename would otherwise rewrite every title in the
    // import — the majority is what decides.
    expect(
      detectImportFormat([
        f('Nota.md', 'x'),
        f('Otra.md', 'x'),
        f('Hash a1b2c3d4e5f67890abcdef1234567890.md', 'x'),
      ]),
    ).toBe('markdown');
  });
});

describe('stripFrontmatter', () => {
  it('reads what our own export writes, and removes it from the body', () => {
    const { meta, body } = stripFrontmatter(
      '---\nid: "abc"\ntitle: "Una \\"nota\\""\nfavorite: true\n---\n\nCuerpo.\n',
    );
    expect(meta).toMatchObject({ id: 'abc', title: 'Una "nota"', favorite: 'true' });
    expect(body).toBe('Cuerpo.\n');
  });

  it('leaves a note that has none exactly as it is', () => {
    const md = 'Sin frontmatter.\n\n---\n\nUna regla horizontal.';
    expect(stripFrontmatter(md)).toEqual({ meta: {}, body: md });
  });

  it('does not eat the note when the block is never closed', () => {
    const md = '---\nid: abc\n\nse olvidaron de cerrarlo';
    expect(stripFrontmatter(md).body).toBe(md);
  });
});

describe('notion', () => {
  it('strips the id from a page name', () => {
    expect(stripNotionId('Roadmap a1b2c3d4e5f67890abcdef1234567890')).toBe('Roadmap');
    expect(stripNotionId('Roadmap')).toBe('Roadmap');
  });

  it('turns a relative page link into a wikilink', () => {
    expect(
      notionLinksToWikilinks('Ver [Roadmap](Roadmap%20a1b2c3d4e5f67890abcdef1234567890.md).'),
    ).toBe('Ver [[Roadmap]].');
  });

  it('keeps the visible text as an alias when it differs', () => {
    expect(
      notionLinksToWikilinks('[el plan](Roadmap%20a1b2c3d4e5f67890abcdef1234567890.md)'),
    ).toBe('[[Roadmap|el plan]]');
  });

  it('does not backtrack on hostile input', () => {
    // These are the shapes CodeQL flags for polynomial ReDoS, and they arrive
    // inside an archive somebody else built. The assertion is the clock: a
    // pattern that retries every split takes seconds on these.
    const started = Date.now();
    notionLinksToWikilinks(`[${'['.repeat(20000)}](${'!'.repeat(20000)}`);
    stripNotionId(' '.repeat(50000));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('leaves absolute links and non-markdown targets alone', () => {
    // An image was not imported; a wikilink to it would be a promise the
    // product cannot keep.
    const md = '[web](https://example.com/a.md) ![img](Captura%20de%20pantalla.png)';
    expect(notionLinksToWikilinks(md)).toBe(md);
  });
});

describe('planImport', () => {
  it('maps folders to folders and files to notes', () => {
    const plan = planImport([
      f('Vault/Proyectos/Diluxite.md', 'Sobre el proyecto.'),
      f('Vault/Diario.md', 'Hoy.'),
    ]);
    expect(plan.notes).toHaveLength(2);
    expect(plan.notes[0]).toMatchObject({
      title: 'Diluxite',
      folderPath: ['Proyectos'],
      contentMd: 'Sobre el proyecto.',
    });
    expect(plan.notes[1].folderPath).toEqual([]);
  });

  it('drops the archive own top folder', () => {
    // Otherwise the whole workspace lands inside a folder named after the ZIP.
    const plan = planImport([f('MiVault/a.md', 'a'), f('MiVault/sub/b.md', 'b')]);
    expect(plan.notes.map((n) => n.folderPath)).toEqual([[], ['sub']]);
  });

  it('keeps a real folder that happens to be the only one', () => {
    // `Docs/Arquitectura.md` is a note in Docs, not a vault called Docs. When
    // the top level has a single child there is nothing to tell them apart,
    // and keeping a level is the recoverable mistake.
    const plan = planImport([f('Docs/Arquitectura.md', 'x')]);
    expect(plan.notes[0].folderPath).toEqual(['Docs']);
  });

  it('keeps a top folder that is not shared by everything', () => {
    const plan = planImport([f('uno/a.md', 'a'), f('dos/b.md', 'b')]);
    expect(plan.notes.map((n) => n.folderPath)).toEqual([['uno'], ['dos']]);
  });

  it('reports what it did not import instead of dropping it quietly', () => {
    const plan = planImport([
      f('V/.obsidian/app.json', '{}'),
      f('V/imagen.png', 'binario'),
      f('V/vacía.md', '   '),
      f('V/buena.md', 'contenido'),
    ]);
    expect(plan.notes).toHaveLength(1);
    expect(plan.skipped.map((s) => s.path)).toEqual([
      'V/.obsidian/app.json',
      'V/imagen.png',
      'V/vacía.md',
    ]);
    expect(plan.skipped[1].reason).toMatch(/attachments/);
  });

  it('gives two files that want the same title different ones', () => {
    // Titles are unique per workspace, so the second insert would simply fail.
    const plan = planImport([f('a/Nota.md', 'una'), f('b/Nota.md', 'otra'), f('c/NOTA.md', 'tres')]);
    // The third keeps its own casing — it is a different file name, and the
    // suffix is about the collision, not about normalising the title.
    expect(plan.notes.map((n) => n.title)).toEqual(['Nota', 'Nota (2)', 'NOTA (3)']);
  });

  it('reads a Notion export: title from the heading, links rewritten', () => {
    const plan = planImport([
      f(
        'Export/Área a1b2c3d4e5f67890abcdef1234567890/Roadmap 0123456789abcdef0123456789abcdef.md',
        '# Roadmap\n\nVer [Notas](Notas%20fedcba9876543210fedcba9876543210.md).',
      ),
      // A second top-level entry, as any real export has — that is what marks
      // `Export/` as the archive's wrapper rather than a folder of its own.
      f('Export/Notas fedcba9876543210fedcba9876543210.md', '# Notas\n\nCuerpo.'),
    ]);
    expect(plan.format).toBe('notion');
    expect(plan.notes[0]).toMatchObject({
      title: 'Roadmap',
      folderPath: ['Área'],
      contentMd: 'Ver [[Notas]].',
    });
  });

  it('round-trips our own export', () => {
    // The export writes `id` into frontmatter so a re-import can recognise the
    // same note. If that is not read back, this is a duplicating importer.
    const files = exportWorkspace(
      [
        {
          id: 'note-1',
          title: 'Arquitectura',
          contentMd: 'Con [[Otra]] y #tag.',
          folderId: 'f1',
          favorite: true,
        },
      ],
      [{ id: 'f1', name: 'Docs', parentId: null }],
    );
    const plan = planImport(files.map((x) => f(x.path, x.content)));
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toMatchObject({
      title: 'Arquitectura',
      externalId: 'note-1',
      favorite: true,
      folderPath: ['Docs'],
      contentMd: 'Con [[Otra]] y #tag.',
    });
  });
});
