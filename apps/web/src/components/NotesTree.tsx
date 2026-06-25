import { useEffect, useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import type { Folder, Note } from '../api';
import { useContextMenu, type ContextMenuItem } from '../ui';
import { TreeRow } from './TreeRow';
import { MoveToDialog } from './MoveToDialog';
import {
  applyClick,
  flattenVisible,
  folderKey,
  forbiddenTargets,
  noteKey,
  splitKeys,
  type ItemKey,
  type SelectionState,
} from './tree-selection';
import {
  FileText,
  Folder as FolderIcon,
  FolderOpen,
  Pencil,
  Plus,
  Star,
  Trash2,
} from '../icons';

/**
 * Explorer tree (folders + notes). VS Code-style:
 *  - Single-line rows, chevron toggles folders, leaves get a 14-px spacer
 *    so icons align with their siblings.
 *  - Hover surfaces row actions (new note, new subfolder, rename, delete).
 *  - Right-click any row → context menu with the full action set.
 *  - Drag a note onto a folder to move it; drag a folder onto another to
 *    nest it. Drop on the empty bottom area (or anywhere on the tree
 *    container) to send things back to root.
 */
const DND_MIME = 'application/x-diluxite';

export function NotesTree({
  folders,
  notes,
  currentId,
  onOpen,
  onCreateFolder,
  onCreateNote,
  onDeleteFolder,
  onRenameFolder,
  onDeleteNote,
  onRenameNote,
  onToggleFavorite,
  onMoveNoteToFolder,
  onMoveFolderToFolder,
  onMoveItems,
}: {
  folders: Folder[];
  notes: Note[];
  currentId: string | null;
  onOpen: (n: Note) => void;
  onCreateFolder: (parentId: string | null) => void;
  onCreateNote: (folderId: string | null) => void;
  onDeleteFolder?: (id: string) => void;
  onRenameFolder?: (id: string) => void;
  onDeleteNote?: (note: Note) => void;
  onRenameNote?: (note: Note) => void;
  onToggleFavorite?: (note: Note) => void;
  onMoveNoteToFolder?: (noteId: string, folderId: string | null) => void;
  onMoveFolderToFolder?: (folderId: string, parentId: string | null) => void;
  /** Atomic move of a whole multi-selection (notes + folders) to one place. */
  onMoveItems?: (targetFolderId: string | null, noteIds: string[], folderIds: string[]) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  const ctx = useContextMenu();
  const toggle = (id: string) =>
    setExpanded((e) => {
      const s = new Set(e);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });

  const childFolders = (pid: string | null) =>
    folders.filter((c) => c.parentId === pid).sort((a, b) => a.name.localeCompare(b.name));
  const notesIn = (fid: string | null) =>
    notes.filter((n) => (n.folderId ?? null) === fid).sort((a, b) => a.title.localeCompare(b.title));

  // ── Multi-select ─────────────────────────────────────────────────────────
  // Ctrl/Cmd-click toggles one row, Shift-click selects a range, plain click
  // selects one. Notes + folders share one selection; drag or "Move to…" then
  // moves the whole lot. Disabled entirely when the host doesn't wire moves.
  const multiSelect = !!onMoveItems;
  const [sel, setSel] = useState<SelectionState>({ selected: new Set(), anchor: null });
  const [movePickerKeys, setMovePickerKeys] = useState<Set<ItemKey> | null>(null);
  // Visible rows in render order — the basis for Shift-range resolution.
  const order = useMemo(
    () => flattenVisible(folders, notes, expanded),
    [folders, notes, expanded],
  );
  const clearSelection = () => setSel({ selected: new Set(), anchor: null });

  // Apply a click to the selection; returns whether it was a plain (no-modifier)
  // click so the caller can decide on side effects (open the note / toggle folder).
  function select(key: ItemKey, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) {
    const mods = { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey };
    setSel((s) => applyClick(s, key, mods, order));
    return !mods.toggle && !mods.range;
  }

  // Escape clears the selection (matches every file manager).
  useEffect(() => {
    if (sel.selected.size === 0) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearSelection();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [sel.selected.size]);

  function openMovePicker(keys: Set<ItemKey>) {
    if (keys.size > 0) setMovePickerKeys(keys);
  }

  // ── DnD ────────────────────────────────────────────────────────────────
  type DragItem = { kind: 'note' | 'folder'; id: string };
  function onDragStart(e: DragEvent, key: ItemKey) {
    e.stopPropagation();
    // Drag the whole selection when the grabbed row is part of a multi-select;
    // otherwise the grabbed row becomes the selection (so you never drag a
    // stale, invisible set).
    let keys: ItemKey[];
    if (sel.selected.has(key) && sel.selected.size > 1) {
      keys = [...sel.selected];
    } else {
      keys = [key];
      setSel({ selected: new Set([key]), anchor: key });
    }
    const { noteIds, folderIds } = splitKeys(keys);
    const items: DragItem[] = [
      ...noteIds.map((id) => ({ kind: 'note' as const, id })),
      ...folderIds.map((id) => ({ kind: 'folder' as const, id })),
    ];
    e.dataTransfer.setData(DND_MIME, JSON.stringify(items));
    e.dataTransfer.effectAllowed = 'move';
  }
  function itemsOf(e: DragEvent): DragItem[] | null {
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as DragItem[]) : null;
    } catch {
      return null;
    }
  }
  function targetKey(id: string | null) {
    return id ?? '__root__';
  }
  function makeDropHandlers(target: Folder | null) {
    const key = targetKey(target?.id ?? null);
    return {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(DND_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (hoverTarget !== key) setHoverTarget(key);
      },
      onDragLeave: (e: DragEvent) => {
        if (hoverTarget === key) setHoverTarget(null);
        e.stopPropagation();
      },
      onDrop: (e: DragEvent) => {
        const items = itemsOf(e);
        setHoverTarget(null);
        if (!items) return;
        e.preventDefault();
        e.stopPropagation();
        const targetFolderId = target?.id ?? null;
        const noteIds = items.filter((i) => i.kind === 'note').map((i) => i.id);
        // A folder can never be dropped into itself.
        const folderIds = items
          .filter((i) => i.kind === 'folder' && i.id !== targetFolderId)
          .map((i) => i.id);
        if (noteIds.length === 0 && folderIds.length === 0) return;
        onMoveItems?.(targetFolderId, noteIds, folderIds);
        clearSelection();
      },
    };
  }

  // Right-click: if the row isn't part of the current selection, make it the
  // selection first (so the bulk action operates on what you'd expect).
  function rowContextMenu(
    e: MouseEvent,
    key: ItemKey,
    singleMenu: (ContextMenuItem | 'separator')[],
  ) {
    let active: Set<ItemKey> = new Set(sel.selected);
    if (!active.has(key)) {
      active = new Set([key]);
      setSel({ selected: active, anchor: key });
    }
    if (multiSelect && active.size > 1) {
      ctx.open(e, [
        {
          label: `Move ${active.size} items to…`,
          icon: <FolderIcon size={13} />,
          onSelect: () => openMovePicker(active),
        },
        'separator',
        { label: 'Clear selection', onSelect: clearSelection },
      ]);
      return;
    }
    const items = multiSelect
      ? [
          {
            label: 'Move to…',
            icon: <FolderIcon size={13} />,
            onSelect: () => openMovePicker(active),
          } as ContextMenuItem,
          'separator' as const,
          ...singleMenu,
        ]
      : singleMenu;
    ctx.open(e, items);
  }

  // ── Context menus ──────────────────────────────────────────────────────
  function folderMenu(f: Folder): (ContextMenuItem | 'separator')[] {
    return [
      { label: 'New note here', icon: <Plus size={13} />, onSelect: () => onCreateNote(f.id) },
      { label: 'New subfolder', icon: <FolderIcon size={13} />, onSelect: () => onCreateFolder(f.id) },
      'separator',
      onRenameFolder && {
        label: 'Rename folder',
        icon: <Pencil size={13} />,
        onSelect: () => onRenameFolder(f.id),
      },
      onDeleteFolder && {
        label: 'Delete folder',
        icon: <Trash2 size={13} />,
        onSelect: () => onDeleteFolder(f.id),
        danger: true,
      },
    ].filter(Boolean) as (ContextMenuItem | 'separator')[];
  }

  function noteMenu(n: Note): (ContextMenuItem | 'separator')[] {
    return [
      { label: 'Open note', icon: <FileText size={13} />, onSelect: () => onOpen(n) },
      onRenameNote && {
        label: 'Rename note',
        icon: <Pencil size={13} />,
        onSelect: () => onRenameNote(n),
      },
      onToggleFavorite && {
        label: n.favorite ? 'Remove from favorites' : 'Mark as favorite',
        icon: <Star size={13} className={n.favorite ? 'fill-yellow-300 text-yellow-300' : ''} />,
        onSelect: () => onToggleFavorite(n),
      },
      onMoveNoteToFolder && n.folderId && {
        label: 'Move to root',
        icon: <FolderIcon size={13} />,
        onSelect: () => onMoveNoteToFolder(n.id, null),
      },
      'separator',
      onDeleteNote && {
        label: 'Delete note',
        icon: <Trash2 size={13} />,
        onSelect: () => onDeleteNote(n),
        danger: true,
      },
    ].filter(Boolean) as (ContextMenuItem | 'separator')[];
  }

  // ── Renderers ──────────────────────────────────────────────────────────
  const renderFolder = (f: Folder, depth: number) => {
    const open = expanded.has(f.id);
    const FolderGlyph = open ? FolderOpen : FolderIcon;
    return (
      <div key={f.id} className="min-w-0">
        <TreeRow
          depth={depth}
          expandable
          expanded={open}
          onToggle={() => toggle(f.id)}
          onClick={(e) => {
            // Modifier click only adjusts the selection; a plain click also
            // expands/collapses the folder (the familiar explorer behaviour).
            const plain = select(folderKey(f.id), e);
            if (plain) toggle(f.id);
          }}
          icon={<FolderGlyph size={14} />}
          label={f.name}
          active={false}
          selected={sel.selected.has(folderKey(f.id))}
          highlighted={hoverTarget === f.id}
          draggable={!!onMoveItems}
          onDragStart={(e) => onDragStart(e, folderKey(f.id))}
          onContextMenu={(e) => rowContextMenu(e, folderKey(f.id), folderMenu(f))}
          {...makeDropHandlers(f)}
          actions={
            <>
              <RowAction label={`new note in ${f.name}`} title="New note here" onClick={() => onCreateNote(f.id)}>
                <Plus size={13} />
              </RowAction>
              <RowAction label={`new subfolder in ${f.name}`} title="New subfolder" onClick={() => onCreateFolder(f.id)}>
                <FolderIcon size={13} />
              </RowAction>
              {onRenameFolder && (
                <RowAction label={`rename ${f.name}`} title="Rename" onClick={() => onRenameFolder(f.id)}>
                  <Pencil size={13} />
                </RowAction>
              )}
              {onDeleteFolder && (
                <RowAction label={`delete folder ${f.name}`} title="Delete folder" onClick={() => onDeleteFolder(f.id)}>
                  <Trash2 size={13} />
                </RowAction>
              )}
            </>
          }
        />
        {open && (
          <div className="min-w-0">
            {childFolders(f.id).map((sub) => renderFolder(sub, depth + 1))}
            {notesIn(f.id).map((n) => renderNote(n, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const renderNote = (n: Note, depth: number) => (
    <TreeRow
      key={n.id}
      depth={depth}
      icon={
        n.favorite ? (
          <Star size={13} className="text-yellow-300 fill-yellow-300" />
        ) : (
          <FileText size={13} />
        )
      }
      label={n.title}
      active={currentId === n.id}
      selected={sel.selected.has(noteKey(n.id))}
      onClick={(e) => {
        // A plain click selects + opens; a modifier click just (de)selects.
        const plain = select(noteKey(n.id), e);
        if (plain) onOpen(n);
      }}
      draggable={!!onMoveItems}
      onDragStart={(e) => onDragStart(e, noteKey(n.id))}
      onContextMenu={(e) => rowContextMenu(e, noteKey(n.id), noteMenu(n))}
      actions={
        <>
          {onRenameNote && (
            <RowAction label={`rename note ${n.title}`} title="Rename note" onClick={() => onRenameNote(n)}>
              <Pencil size={12} />
            </RowAction>
          )}
          {onDeleteNote && (
            <RowAction label={`delete note ${n.title}`} title="Delete note" onClick={() => onDeleteNote(n)}>
              <Trash2 size={12} />
            </RowAction>
          )}
        </>
      }
    />
  );

  const empty = folders.length === 0 && notes.length === 0;
  const rootHovered = hoverTarget === '__root__';

  /** Right-click on the bare tree (empty space, gutters, root drop zone). */
  function rootMenu(): (ContextMenuItem | 'separator')[] {
    return [
      { label: 'New note', icon: <Plus size={13} />, onSelect: () => onCreateNote(null) },
      { label: 'New folder', icon: <FolderIcon size={13} />, onSelect: () => onCreateFolder(null) },
    ];
  }

  return (
    <div
      className={`flex flex-col gap-0.5 min-w-0 overflow-hidden min-h-full ${
        rootHovered ? 'ring-1 ring-brand rounded' : ''
      }`}
      onContextMenu={(e) => ctx.open(e, rootMenu())}
      {...makeDropHandlers(null)}
    >
      {childFolders(null).map((c) => renderFolder(c, 0))}
      {notesIn(null).map((n) => renderNote(n, 0))}
      {empty && (
        <div className="text-xs text-ink-muted px-2 py-3">
          Empty. Create a note or folder from the buttons above. Right-click any row for more actions.
        </div>
      )}
      {/* Generous bottom drop zone so dropping outside any folder reliably lands on root.
          Clicking the bare area also clears the current selection. */}
      <div className="flex-1 min-h-6" onClick={clearSelection} />
      <ctx.Menu />
      {movePickerKeys &&
        (() => {
          const { noteIds, folderIds } = splitKeys(movePickerKeys);
          return (
            <MoveToDialog
              open
              count={movePickerKeys.size}
              folders={folders}
              forbidden={forbiddenTargets(folders, folderIds)}
              onPick={(targetFolderId) => {
                onMoveItems?.(targetFolderId, noteIds, folderIds);
                clearSelection();
              }}
              onClose={() => setMovePickerKeys(null)}
            />
          );
        })()}
    </div>
  );
}

function RowAction({
  label,
  title,
  onClick,
  children,
}: {
  label: string;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="p-1 text-ink-muted hover:text-ink hover:bg-bg rounded"
    >
      {children}
    </button>
  );
}
