import { useApp } from '../AppContext';
import { Archive, Undo2 } from '../../icons';
import { ViewShell, Row, Empty } from './FavoritesView';

/**
 * Sidebar view: archived notes of the active workspace (migration 0035).
 *
 * Reads from the notes already in context — archived notes stay in the normal
 * listing, they are simply filtered out of the tree and the recents. That is
 * the whole difference from the trash, which needs its own endpoint because
 * soft-deleted rows are excluded from every read.
 *
 * Newest first: what you archived last is what you are most likely looking for.
 */
export function ArchiveView() {
  const { notes, openNote, toggleArchive } = useApp();
  const archived = notes
    .filter((n) => n.archivedAt)
    .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));

  return (
    <ViewShell title="Archive" count={archived.length}>
      {archived.length === 0 ? (
        <Empty>
          Archive a note (🗄) from its title bar. It leaves the tree but keeps
          answering searches, marked as archived.
        </Empty>
      ) : (
        archived.map((n) => (
          <div key={n.id} className="flex items-center gap-1 min-w-0">
            <div className="flex-1 min-w-0">
              <Row
                icon={<Archive size={13} className="text-ink-muted shrink-0" />}
                onClick={() => openNote(n.id)}
              >
                {n.title}
              </Row>
            </div>
            <button
              onClick={() => void toggleArchive(n.id, false)}
              title="Bring back to the tree"
              aria-label={`unarchive ${n.title}`}
              className="shrink-0 p-1 rounded text-ink-muted hover:text-ink hover:bg-bg"
            >
              <Undo2 size={13} />
            </button>
          </div>
        ))
      )}
    </ViewShell>
  );
}
