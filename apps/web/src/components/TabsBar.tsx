import type { Note } from '../api';

/** Bar de pestañas estilo VS Code — notas abiertas. */
export function TabsBar({
  tabs,
  currentId,
  onSelect,
  onClose,
}: {
  tabs: Note[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div
      data-testid="tabs-bar"
      className="flex items-stretch h-9 border-b border-line bg-bg-surface overflow-x-auto shrink-0"
    >
      {tabs.map((n) => {
        const active = currentId === n.id;
        return (
          <div
            key={n.id}
            className={`group flex items-center gap-1.5 px-3 text-sm border-r border-line cursor-pointer max-w-[220px] ${
              active ? 'bg-bg text-ink' : 'bg-bg-surface text-ink-muted hover:text-ink hover:bg-bg/60'
            }`}
            onClick={() => onSelect(n.id)}
            title={n.titulo}
          >
            <span className="text-xs">{n.favorita ? '★' : '📝'}</span>
            <span className="truncate">{n.titulo}</span>
            <button
              aria-label={`close tab ${n.titulo}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(n.id);
              }}
              className="ml-1 px-1 rounded text-ink-muted hover:text-ink hover:bg-bg-surface opacity-0 group-hover:opacity-100 transition-opacity"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
