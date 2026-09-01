import { useApp } from './AppContext';
import { NotesTree } from '../components/NotesTree';
import type { Note } from '../api';
import { Folder, Plus } from '../icons';

/**
 * Left sidebar — Explorer view (folders + notes).
 *
 * VS Code style: a small header with quick-action buttons, then the
 * tree. Favorites / Recent / Tags / Backlinks now live as separate
 * top-level views in the activity bar (see ActivityBar +
 * shell/views/*).
 */
export function Sidebar({
  currentNoteId,
  onCreateNote,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onDeleteNote,
  onRenameNote,
  onToggleFavorite,
  onMoveNoteToFolder,
  onMoveFolderToFolder,
  onMoveItems,
  onDeleteItems,
  onTagItems,
}: {
  /** Id of the note the router currently points at (null off a note route).
      Passed down instead of reading `window.location` during render. */
  currentNoteId: string | null;
  onCreateNote: (folderId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onRenameFolder: (id: string) => void;
  onDeleteFolder: (id: string) => void;
  onDeleteNote: (note: Note) => void;
  onRenameNote: (note: Note) => void;
  onToggleFavorite: (note: Note) => void;
  onMoveNoteToFolder: (noteId: string, folderId: string | null) => void;
  onMoveFolderToFolder: (folderId: string, parentId: string | null) => void;
  onMoveItems: (
    targetFolderId: string | null,
    noteIds: string[],
    folderIds: string[],
  ) => void;
  onDeleteItems: (noteIds: string[], folderIds: string[]) => void;
  onTagItems?: (noteIds: string[]) => void;
}) {
  const { notes, folders, openNote } = useApp();

  const currentId = currentNoteId;

  return (
    <div className="h-full flex flex-col bg-bg-surface text-ink min-w-0">
      <div className="flex items-center gap-1 px-2 py-2 border-b border-line shrink-0">
        <span className="text-[11px] uppercase tracking-wider text-ink-muted flex-1 truncate px-1">
          Explorer
        </span>
        <button
          onClick={() => onCreateNote(null)}
          aria-label="new note"
          title="New note"
          className="p-1 rounded hover:bg-bg text-ink-muted hover:text-ink"
        >
          <Plus size={14} />
        </button>
        <button
          onClick={() => onCreateFolder(null)}
          aria-label="new folder"
          title="New folder"
          className="p-1 rounded hover:bg-bg text-ink-muted hover:text-ink"
        >
          <Folder size={14} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 min-w-0">
        <NotesTree
          folders={folders}
          notes={notes}
          currentId={currentId}
          onOpen={(n) => openNote(n.id)}
          onCreateNote={onCreateNote}
          onCreateFolder={onCreateFolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
          onDeleteNote={onDeleteNote}
          onRenameNote={onRenameNote}
          onToggleFavorite={onToggleFavorite}
          onMoveNoteToFolder={onMoveNoteToFolder}
          onMoveFolderToFolder={onMoveFolderToFolder}
          onMoveItems={onMoveItems}
          onDeleteItems={onDeleteItems}
          onTagItems={onTagItems}
        />
      </div>
    </div>
  );
}
