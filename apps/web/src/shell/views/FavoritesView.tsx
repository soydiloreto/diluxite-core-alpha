import { useApp } from '../AppContext';
import { Star, FileText } from '../../icons';

/** Sidebar view: notes marked as favorite. Click opens the note. */
export function FavoritesView() {
  const { notes, openNote } = useApp();
  const favorites = notes.filter((n) => n.favorite);

  return (
    <ViewShell title="Favorites" count={favorites.length}>
      {favorites.length === 0 ? (
        <Empty>
          Star a note (★) from its title bar — it will show up here for quick access.
        </Empty>
      ) : (
        favorites.map((n) => (
          <Row key={n.id} icon={<Star size={13} className="text-yellow-300 fill-yellow-300" />} onClick={() => openNote(n.id)}>
            {n.title}
          </Row>
        ))
      )}
    </ViewShell>
  );
}

export function ViewShell({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full flex flex-col bg-bg-surface text-ink min-w-0">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-line shrink-0">
        <span className="text-[11px] uppercase tracking-wider text-ink-muted flex-1 truncate">
          {title}
        </span>
        {count !== undefined && (
          <span className="text-[11px] text-ink-muted">{count}</span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

export function Row({
  icon,
  onClick,
  active,
  children,
  title,
}: {
  icon?: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-sm text-left min-w-0 ${
        active ? 'bg-brand text-white' : 'text-ink hover:bg-bg'
      }`}
    >
      {icon ?? <FileText size={13} className="text-ink-muted shrink-0" />}
      <span className="flex-1 min-w-0 truncate">{children}</span>
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-ink-muted px-2 py-3 leading-relaxed">{children}</div>;
}
