import { describe, it, expect } from 'vitest';
import type { Folder, Note } from '../api';
import {
  applyClick,
  flattenVisible,
  folderKey,
  forbiddenTargets,
  noteKey,
  parseKey,
  splitKeys,
  EMPTY_SELECTION,
  type SelectionState,
} from './tree-selection';

const folder = (id: string, parentId: string | null, name = id): Folder =>
  ({ id, parentId, name, spaceId: 's' }) as Folder;
const note = (id: string, folderId: string | null, title = id): Note =>
  ({ id, folderId, title, spaceId: 's', contentMd: '' }) as Note;

const sel = (keys: string[], anchor: string | null = null): SelectionState => ({
  selected: new Set(keys),
  anchor,
});

describe('tree-selection keys', () => {
  it('namespaces and parses note/folder keys', () => {
    expect(parseKey(noteKey('a'))).toEqual({ kind: 'note', id: 'a' });
    expect(parseKey(folderKey('b'))).toEqual({ kind: 'folder', id: 'b' });
  });

  it('parses ids that contain a colon (uuids never do, but be safe)', () => {
    expect(parseKey('note:x:y')).toEqual({ kind: 'note', id: 'x:y' });
  });

  it('splitKeys separates notes from folders', () => {
    const { noteIds, folderIds } = splitKeys([noteKey('n1'), folderKey('f1'), noteKey('n2')]);
    expect(noteIds).toEqual(['n1', 'n2']);
    expect(folderIds).toEqual(['f1']);
  });
});

describe('flattenVisible', () => {
  // Tree:
  //   f1 (expanded)
  //     f1a (collapsed)  [has child note hiddenNote]
  //     note a1
  //   f2 (collapsed)
  //   note rootNote
  const folders = [folder('f1', null), folder('f1a', 'f1'), folder('f2', null)];
  const notes = [note('a1', 'f1'), note('hidden', 'f1a'), note('root', null)];

  it('lists folders-before-notes per level, descending into expanded folders only', () => {
    const order = flattenVisible(folders, notes, new Set(['f1']));
    expect(order).toEqual([
      folderKey('f1'),
      folderKey('f1a'), // visible (child of expanded f1) but itself collapsed
      noteKey('a1'),
      folderKey('f2'),
      noteKey('root'),
    ]);
    // hidden note (inside collapsed f1a) must NOT appear
    expect(order).not.toContain(noteKey('hidden'));
  });

  it('hides all descendants when the parent is collapsed', () => {
    const order = flattenVisible(folders, notes, new Set());
    expect(order).toEqual([folderKey('f1'), folderKey('f2'), noteKey('root')]);
  });

  it('sorts folders by name and notes by title within a level', () => {
    const fs = [folder('b', null, 'Beta'), folder('a', null, 'Alpha')];
    const ns = [note('z', null, 'Zeta'), note('m', null, 'Mu')];
    expect(flattenVisible(fs, ns, new Set())).toEqual([
      folderKey('a'),
      folderKey('b'),
      noteKey('m'),
      noteKey('z'),
    ]);
  });
});

describe('forbiddenTargets', () => {
  // f1 → f1a → f1a1 ; f2 standalone
  const folders = [folder('f1', null), folder('f1a', 'f1'), folder('f1a1', 'f1a'), folder('f2', null)];

  it('forbids a selected folder and its whole subtree', () => {
    expect(forbiddenTargets(folders, ['f1'])).toEqual(new Set(['f1', 'f1a', 'f1a1']));
  });

  it('forbids only the subtree of each selected folder', () => {
    expect(forbiddenTargets(folders, ['f1a'])).toEqual(new Set(['f1a', 'f1a1']));
    expect(forbiddenTargets(folders, ['f2'])).toEqual(new Set(['f2']));
  });

  it('handles multiple selected folders', () => {
    expect(forbiddenTargets(folders, ['f1a', 'f2'])).toEqual(new Set(['f1a', 'f1a1', 'f2']));
  });

  it('returns empty when nothing is selected', () => {
    expect(forbiddenTargets(folders, [])).toEqual(new Set());
  });
});

describe('applyClick', () => {
  const order = [folderKey('f1'), noteKey('a1'), folderKey('f2'), noteKey('root')];

  it('plain click selects only that row and sets the anchor', () => {
    const r = applyClick(sel([noteKey('a1'), folderKey('f2')]), noteKey('root'), { toggle: false, range: false }, order);
    expect([...r.selected]).toEqual([noteKey('root')]);
    expect(r.anchor).toBe(noteKey('root'));
  });

  it('toggle adds an unselected row and keeps the rest', () => {
    const r = applyClick(sel([noteKey('a1')], noteKey('a1')), folderKey('f2'), { toggle: true, range: false }, order);
    expect(r.selected).toEqual(new Set([noteKey('a1'), folderKey('f2')]));
    expect(r.anchor).toBe(folderKey('f2'));
  });

  it('toggle removes an already-selected row', () => {
    const r = applyClick(sel([noteKey('a1'), folderKey('f2')]), folderKey('f2'), { toggle: true, range: false }, order);
    expect(r.selected).toEqual(new Set([noteKey('a1')]));
    expect(r.anchor).toBe(folderKey('f2'));
  });

  it('range selects everything between anchor and target, inclusive', () => {
    const r = applyClick(sel([folderKey('f1')], folderKey('f1')), folderKey('f2'), { toggle: false, range: true }, order);
    expect(r.selected).toEqual(new Set([folderKey('f1'), noteKey('a1'), folderKey('f2')]));
    // anchor stays put for chained range clicks
    expect(r.anchor).toBe(folderKey('f1'));
  });

  it('range works backwards (anchor below target)', () => {
    const r = applyClick(sel([noteKey('root')], noteKey('root')), folderKey('f1'), { toggle: false, range: true }, order);
    expect(r.selected).toEqual(new Set(order));
  });

  it('range with no anchor degrades to a single selection', () => {
    const r = applyClick(EMPTY_SELECTION, noteKey('a1'), { toggle: false, range: true }, order);
    expect([...r.selected]).toEqual([noteKey('a1')]);
    expect(r.anchor).toBe(noteKey('a1'));
  });

  it('range falls back to single when the anchor is no longer visible', () => {
    // anchor 'gone' is not present in `order` (its folder was collapsed)
    const r = applyClick(sel([], 'note:gone'), folderKey('f2'), { toggle: false, range: true }, order);
    expect([...r.selected]).toEqual([folderKey('f2')]);
    expect(r.anchor).toBe(folderKey('f2'));
  });

  it('chained range from a fixed anchor reselects a different span', () => {
    const first = applyClick(sel([folderKey('f1')], folderKey('f1')), folderKey('f2'), { toggle: false, range: true }, order);
    const second = applyClick(first, noteKey('a1'), { toggle: false, range: true }, order);
    // anchor is still f1, so f1..a1
    expect(second.selected).toEqual(new Set([folderKey('f1'), noteKey('a1')]));
  });
});
