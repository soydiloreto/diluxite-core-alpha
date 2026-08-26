import { describe, it, expect } from 'vitest';
import {
  descendantFolderIds,
  findFolderPath,
  folderPaths,
  folderPathOf,
  resolveFolderPath,
  splitFolderPath,
  type FolderNode,
  type FolderStore,
} from './folders';

function memoryStore(seed: FolderNode[] = []) {
  const rows = [...seed];
  let n = 0;
  const store: FolderStore = {
    list: async (_spaceId: string) => rows.slice(),
    create: async (_spaceId: string, name: string, parentId: string | null) => {
      const row = { id: `f${++n}`, name, parentId };
      rows.push(row);
      return row;
    },
  };
  return { store, rows, created: () => rows.filter((r) => r.id.startsWith('f')) };
}

describe('splitFolderPath', () => {
  it('drops blank segments so stray separators are harmless', () => {
    expect(splitFolderPath('Dailies//2026-08/ ')).toEqual(['Dailies', '2026-08']);
    expect(splitFolderPath('/leading')).toEqual(['leading']);
    expect(splitFolderPath('   ')).toEqual([]);
  });
});

describe('resolveFolderPath', () => {
  it('an empty path is the root', async () => {
    const { store } = memoryStore();
    expect(await resolveFolderPath(store, 's', '')).toBeNull();
    expect(await resolveFolderPath(store, 's', undefined)).toBeNull();
  });

  it('creates the missing segments and nests them', async () => {
    const { store, rows } = memoryStore();
    const id = await resolveFolderPath(store, 's', 'Dailies/2026-08');

    expect(rows).toHaveLength(2);
    const [dailies, month] = rows;
    expect(dailies).toMatchObject({ name: 'Dailies', parentId: null });
    expect(month).toMatchObject({ name: '2026-08', parentId: dailies.id });
    expect(id).toBe(month.id);
  });

  it('reuses what already exists instead of duplicating it', async () => {
    const { store, rows } = memoryStore([
      { id: 'a', name: 'Dailies', parentId: null },
      { id: 'b', name: '2026-08', parentId: 'a' },
    ]);

    expect(await resolveFolderPath(store, 's', 'Dailies/2026-08')).toBe('b');
    expect(rows).toHaveLength(2);
  });

  it('extends an existing branch rather than starting a new one', async () => {
    const { store, rows } = memoryStore([{ id: 'a', name: 'Dailies', parentId: null }]);

    const id = await resolveFolderPath(store, 's', 'Dailies/2026-08/week-3');

    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ name: '2026-08', parentId: 'a' });
    expect(rows[2]).toMatchObject({ name: 'week-3', parentId: rows[1].id });
    expect(id).toBe(rows[2].id);
  });

  it('matches siblings case-insensitively — "dailies" is not a second "Dailies"', async () => {
    const { store, rows } = memoryStore([{ id: 'a', name: 'Dailies', parentId: null }]);

    expect(await resolveFolderPath(store, 's', 'dailies')).toBe('a');
    expect(rows).toHaveLength(1);
  });

  it('only matches inside the right parent', async () => {
    const { store } = memoryStore([
      { id: 'a', name: 'Work', parentId: null },
      { id: 'b', name: 'notes', parentId: 'a' },
      { id: 'c', name: 'Personal', parentId: null },
    ]);

    // 'notes' lives under Work, so Personal/notes has to be created.
    const id = await resolveFolderPath(store, 's', 'Personal/notes');
    expect(id).not.toBe('b');
  });

  it('is stable across calls when siblings differ only by case', async () => {
    const { store } = memoryStore([
      { id: 'b', name: 'dailies', parentId: null },
      { id: 'a', name: 'Dailies', parentId: null },
    ]);

    const first = await resolveFolderPath(store, 's', 'DAILIES');
    const second = await resolveFolderPath(store, 's', 'dailies');
    expect(first).toBe(second);
  });
});

describe('findFolderPath', () => {
  const tree: FolderNode[] = [
    { id: 'a', name: 'Dailies', parentId: null },
    { id: 'b', name: '2026-08', parentId: 'a' },
    { id: 'c', name: '2026-08', parentId: null },
  ];

  it('walks the path and returns the leaf', () => {
    expect(findFolderPath(tree, 'Dailies/2026-08')?.id).toBe('b');
  });

  it('does not confuse a same-named folder at another level', () => {
    expect(findFolderPath(tree, '2026-08')?.id).toBe('c');
  });

  it('returns null when a segment is missing — it never creates', () => {
    expect(findFolderPath(tree, 'Dailies/2026-09')).toBeNull();
    expect(findFolderPath(tree, 'Nope/2026-08')).toBeNull();
  });

  it('an empty path is not a folder', () => {
    expect(findFolderPath(tree, '')).toBeNull();
    expect(findFolderPath(tree, '  /  ')).toBeNull();
  });

  it('matches case-insensitively, like resolveFolderPath', () => {
    expect(findFolderPath(tree, 'DAILIES/2026-08')?.id).toBe('b');
  });
});

describe('descendantFolderIds', () => {
  const tree: FolderNode[] = [
    { id: 'a', name: 'A', parentId: null },
    { id: 'b', name: 'B', parentId: 'a' },
    { id: 'c', name: 'C', parentId: 'b' },
    { id: 'd', name: 'D', parentId: 'a' },
    { id: 'z', name: 'Z', parentId: null },
  ];

  it('collects the whole subtree, root included', () => {
    expect(new Set(descendantFolderIds(tree, 'a'))).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('a leaf is just itself', () => {
    expect(descendantFolderIds(tree, 'c')).toEqual(['c']);
  });

  it('leaves siblings out', () => {
    expect(descendantFolderIds(tree, 'a')).not.toContain('z');
  });

  it('terminates on a cyclic parent chain', () => {
    const cyclic: FolderNode[] = [
      { id: 'x', name: 'X', parentId: 'y' },
      { id: 'y', name: 'Y', parentId: 'x' },
    ];
    expect(new Set(descendantFolderIds(cyclic, 'x'))).toEqual(new Set(['x', 'y']));
  });
});

describe('folderPaths', () => {
  it('lists every folder as a full path, child after parent', () => {
    const tree: FolderNode[] = [
      { id: 'b', name: '2026-08', parentId: 'a' },
      { id: 'a', name: 'Dailies', parentId: null },
      { id: 'z', name: 'Archive', parentId: null },
    ];

    expect(folderPaths(tree).map((f) => f.path)).toEqual([
      'Archive',
      'Dailies',
      'Dailies/2026-08',
    ]);
  });

  it('is empty for a space with no folders', () => {
    expect(folderPaths([])).toEqual([]);
  });

  it('keeps the id alongside the path', () => {
    const tree: FolderNode[] = [{ id: 'a', name: 'Dailies', parentId: null }];
    expect(folderPaths(tree)).toEqual([{ id: 'a', path: 'Dailies' }]);
  });
});

describe('folderPathOf', () => {
  const tree: FolderNode[] = [
    { id: 'a', name: 'Dailies', parentId: null },
    { id: 'b', name: '2026-08', parentId: 'a' },
  ];

  it('builds the path from the leaf up', () => {
    expect(folderPathOf(tree, 'b')).toBe('Dailies/2026-08');
    expect(folderPathOf(tree, 'a')).toBe('Dailies');
  });

  it('the root is an empty path', () => {
    expect(folderPathOf(tree, null)).toBe('');
  });

  it('survives a broken or cyclic parent chain', () => {
    expect(folderPathOf(tree, 'missing')).toBe('');
    const cyclic: FolderNode[] = [
      { id: 'x', name: 'X', parentId: 'y' },
      { id: 'y', name: 'Y', parentId: 'x' },
    ];
    expect(folderPathOf(cyclic, 'x')).toBe('Y/X');
  });
});
