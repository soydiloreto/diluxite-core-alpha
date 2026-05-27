import { useState, type DragEvent } from 'react';
import type { Folder, Note } from '../api';
import { useContextMenu, type ContextMenuItem } from '../ui';
import { TreeRow } from './TreeRow';
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

type DragPayload =
  | { kind: 'note'; id: string }
  | { kind: 'folder'; id: string };

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

  // ── DnD ────────────────────────────────────────────────────────────────
  function onDragStart(e: DragEvent, payload: DragPayload) {
    e.stopPropagation();
    e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
  }
  function payloadOf(e: DragEvent): DragPayload | null {
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DragPayload;
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
        const p = payloadOf(e);
        setHoverTarget(null);
        if (!p) return;
        e.preventDefault();
        e.stopPropagation();
        const targetFolderId = target?.id ?? null;
        if (p.kind === 'note') {
          onMoveNoteToFolder?.(p.id, targetFolderId);
        } else if (p.kind === 'folder' && p.id !== targetFolderId) {
          onMoveFolderToFolder?.(p.id, targetFolderId);
        }
      },
    };
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
          onClick={() => toggle(f.id)}
          icon={<FolderGlyph size={14} />}
          label={f.name}
          highlighted={hoverTarget === f.id}
          draggable={!!onMoveFolderToFolder}
          onDragStart={(e) => onDragStart(e, { kind: 'folder', id: f.id })}
          onContextMenu={(e) => ctx.open(e, folderMenu(f))}
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
      onClick={() => onOpen(n)}
      draggable={!!onMoveNoteToFolder}
      onDragStart={(e) => onDragStart(e, { kind: 'note', id: n.id })}
      onContextMenu={(e) => ctx.open(e, noteMenu(n))}
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
      {/* Generous bottom drop zone so dropping outside any folder reliably lands on root. */}
      <div className="flex-1 min-h-6" />
      <ctx.Menu />
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
