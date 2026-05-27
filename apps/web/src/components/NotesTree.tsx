import { useState } from 'react';
import type { Folder, Note } from '../api';
import {
  ChevronDown,
  ChevronRight,
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
 *  - Single-line rows, chevron to expand, lucide icons.
 *  - Hover surfaces row actions (new note, new subfolder, rename, delete).
 *  - Every row enforces min-w-0 so titles truncate cleanly at any sidebar width.
 */
export function NotesTree({
  folders,
  notes,
  currentId,
  selected,
  onToggleSelect,
  onOpen,
  onCreateFolder,
  onCreateNote,
  onDeleteFolder,
  onRenameFolder,
}: {
  folders: Folder[];
  notes: Note[];
  currentId: string | null;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (n: Note) => void;
  onCreateFolder: (parentId: string | null) => void;
  onCreateNote: (folderId: string | null) => void;
  onDeleteFolder?: (id: string) => void;
  onRenameFolder?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

  const renderFolder = (f: Folder, depth: number) => {
    const open = expanded.has(f.id);
    const Chevron = open ? ChevronDown : ChevronRight;
    const FolderGlyph = open ? FolderOpen : FolderIcon;
    return (
      <div key={f.id} className="min-w-0">
        <div
          className="group flex items-center gap-1 rounded text-sm text-ink hover:bg-bg-surface min-w-0"
          style={{ paddingLeft: depth * 12 }}
        >
          <button
            type="button"
            onClick={() => toggle(f.id)}
            aria-label={open ? 'collapse' : 'expand'}
            className="p-1 text-ink-muted hover:text-ink"
          >
            <Chevron size={14} />
          </button>
          <FolderGlyph size={14} className="text-ink-muted shrink-0" />
          <button
            type="button"
            onClick={() => toggle(f.id)}
            className="flex-1 min-w-0 text-left py-1 truncate"
            title={f.name}
          >
            {f.name}
          </button>
          <div className="flex shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <IconBtn label={`new note in ${f.name}`} title="New note here" onClick={() => onCreateNote(f.id)}>
              <Plus size={13} />
            </IconBtn>
            <IconBtn
              label={`new subfolder in ${f.name}`}
              title="New subfolder"
              onClick={() => onCreateFolder(f.id)}
            >
              <FolderIcon size={13} />
            </IconBtn>
            {onRenameFolder && (
              <IconBtn label={`rename ${f.name}`} title="Rename" onClick={() => onRenameFolder(f.id)}>
                <Pencil size={13} />
              </IconBtn>
            )}
            {onDeleteFolder && (
              <IconBtn
                label={`delete folder ${f.name}`}
                title="Delete folder"
                onClick={() => onDeleteFolder(f.id)}
              >
                <Trash2 size={13} />
              </IconBtn>
            )}
          </div>
        </div>
        {open && (
          <div className="min-w-0">
            {childFolders(f.id).map((sub) => renderFolder(sub, depth + 1))}
            {notesIn(f.id).map((n) => renderNote(n, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const renderNote = (n: Note, depth: number) => {
    const isSel = selected.has(n.id);
    const active = currentId === n.id;
    return (
      <div
        key={n.id}
        className={`group flex items-center gap-1 rounded text-sm min-w-0 ${
          active ? 'bg-brand text-white' : 'hover:bg-bg-surface text-ink'
        } ${isSel ? 'ring-1 ring-brand' : ''}`}
        style={{ paddingLeft: depth * 12 + 18 /* align with folder titles past the chevron */ }}
      >
        <button
          onClick={() => onToggleSelect(n.id)}
          aria-label={isSel ? `unselect ${n.title}` : `select ${n.title}`}
          className="shrink-0 p-1 text-ink-muted hover:text-ink opacity-0 group-hover:opacity-100"
        >
          {isSel ? '☑' : '☐'}
        </button>
        {n.favorite ? (
          <Star size={13} className="shrink-0 text-yellow-300 fill-yellow-300" />
        ) : (
          <FileText size={13} className={`shrink-0 ${active ? 'text-white/80' : 'text-ink-muted'}`} />
        )}
        <button
          onClick={() => onOpen(n)}
          className="flex-1 min-w-0 text-left py-1 px-1 truncate"
          title={n.title}
        >
          {n.title}
        </button>
      </div>
    );
  };

  const empty = folders.length === 0 && notes.length === 0;

  return (
    <div className="flex flex-col gap-0.5 min-w-0 overflow-hidden">
      {childFolders(null).map((c) => renderFolder(c, 0))}
      {notesIn(null).map((n) => renderNote(n, 0))}
      {empty && (
        <div className="text-xs text-ink-muted px-2 py-3">
          Empty. Create a note or folder from the buttons above.
        </div>
      )}
    </div>
  );
}

function IconBtn({
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
      onClick={onClick}
      className="p-1 text-ink-muted hover:text-ink hover:bg-bg rounded"
    >
      {children}
    </button>
  );
}
