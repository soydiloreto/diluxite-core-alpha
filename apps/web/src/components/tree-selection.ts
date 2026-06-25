import type { Folder, Note } from '../api';

/**
 * Multi-select model for the explorer tree (folders + notes), following the
 * standard file-manager behaviour: plain click selects one, Cmd/Ctrl-click
 * toggles one, Shift-click selects a contiguous range. Notes and folders share
 * one selection, so a key is namespaced by kind: `note:<id>` / `folder:<id>`.
 */
export type ItemKey = string;

export const noteKey = (id: string): ItemKey => `note:${id}`;
export const folderKey = (id: string): ItemKey => `folder:${id}`;

export interface ParsedKey {
  kind: 'note' | 'folder';
  id: string;
}

export function parseKey(key: ItemKey): ParsedKey {
  const i = key.indexOf(':');
  return { kind: key.slice(0, i) as 'note' | 'folder', id: key.slice(i + 1) };
}

/** Split a set of selection keys into the note and folder id arrays the move API expects. */
export function splitKeys(keys: Iterable<ItemKey>): { noteIds: string[]; folderIds: string[] } {
  const noteIds: string[] = [];
  const folderIds: string[] = [];
  for (const k of keys) {
    const { kind, id } = parseKey(k);
    if (kind === 'note') noteIds.push(id);
    else folderIds.push(id);
  }
  return { noteIds, folderIds };
}

/**
 * The selectable rows in render order, honouring which folders are expanded.
 * Mirrors NotesTree's recursive render exactly: at each level sub-folders come
 * first (sorted by name), then notes (sorted by title); an expanded folder is
 * immediately followed by its visible descendants. This is what makes a
 * Shift-range match what the user actually sees on screen.
 */
export function flattenVisible(
  folders: Folder[],
  notes: Note[],
  expanded: ReadonlySet<string>,
): ItemKey[] {
  const childFolders = (pid: string | null) =>
    folders.filter((c) => c.parentId === pid).sort((a, b) => a.name.localeCompare(b.name));
  const notesIn = (fid: string | null) =>
    notes
      .filter((n) => (n.folderId ?? null) === fid)
      .sort((a, b) => a.title.localeCompare(b.title));

  const out: ItemKey[] = [];
  const walk = (pid: string | null) => {
    for (const f of childFolders(pid)) {
      out.push(folderKey(f.id));
      if (expanded.has(f.id)) walk(f.id);
    }
    for (const n of notesIn(pid)) out.push(noteKey(n.id));
  };
  walk(null);
  return out;
}

/**
 * Folder ids that may NOT be a move destination for the given selection: the
 * selected folders themselves plus every descendant (moving a folder under
 * itself or its own child is a cycle). Used to grey those out of the
 * "Move to…" picker before the server has to reject them.
 */
export function forbiddenTargets(
  folders: Folder[],
  selectedFolderIds: Iterable<string>,
): Set<string> {
  const childrenOf = new Map<string | null, string[]>();
  for (const f of folders) {
    const arr = childrenOf.get(f.parentId) ?? [];
    arr.push(f.id);
    childrenOf.set(f.parentId, arr);
  }
  const forbidden = new Set<string>();
  const stack = [...selectedFolderIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (forbidden.has(id)) continue;
    forbidden.add(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return forbidden;
}

export interface SelectionState {
  selected: ReadonlySet<ItemKey>;
  /** Pivot for Shift-range selection (set by the last plain/toggle click). */
  anchor: ItemKey | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null };

export interface ClickMods {
  /** Cmd (mac) or Ctrl (win/linux): toggle this one item. */
  toggle: boolean;
  /** Shift: select the contiguous range from the anchor to here. */
  range: boolean;
}

/**
 * Pure reducer for a click on a tree row:
 *  - plain   → select only this row; it becomes the anchor.
 *  - toggle  → add/remove this row from the selection; it becomes the anchor.
 *  - range   → select every row between the anchor and this one (inclusive) in
 *              the visible order; the anchor stays put.
 *
 * `order` is the flattened visible list (see flattenVisible). If the anchor is
 * no longer visible (its folder collapsed), a range click degrades gracefully
 * to a single selection instead of producing a nonsensical range.
 */
export function applyClick(
  state: SelectionState,
  key: ItemKey,
  mods: ClickMods,
  order: ItemKey[],
): SelectionState {
  if (mods.range && state.anchor) {
    const a = order.indexOf(state.anchor);
    const b = order.indexOf(key);
    if (a === -1 || b === -1) {
      return { selected: new Set([key]), anchor: key };
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return { selected: new Set(order.slice(lo, hi + 1)), anchor: state.anchor };
  }
  if (mods.toggle) {
    const next = new Set(state.selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return { selected: next, anchor: key };
  }
  return { selected: new Set([key]), anchor: key };
}
