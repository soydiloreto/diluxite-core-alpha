import { useState } from 'react';
import { useApp } from './AppContext';
import { NotesTree } from '../components/NotesTree';
import { Button } from '../ui';
import { useT } from '../i18n';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Hash,
  Plus,
  Star,
  Trash2,
  X,
} from '../icons';

/**
 * Left sidebar (VS Code-style "Explorer"):
 *  - Header with title and quick-action buttons (new note / new folder).
 *  - Collapsible sections: Explorer (tree), Favorites, Recent, Tags.
 *  - Floating multi-selection bar (absolute, doesn't push layout).
 *
 * Everything inside is min-w-0 so titles truncate cleanly when the
 * sidebar is resized narrow.
 */
export function Sidebar({
  selected,
  onToggleSelect,
  onClearSelected,
  onDeleteSelected,
  onCreateNote,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
}: {
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onClearSelected: () => void;
  onDeleteSelected: () => void;
  onCreateNote: (folderId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onRenameFolder: (id: string) => void;
  onDeleteFolder: (id: string) => void;
}) {
  const { notes, folders, tags, openNote } = useApp();
  const t = useT();

  const recent = [...notes]
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, 8);
  const favorites = notes.filter((n) => n.favorite);

  // Sections that can collapse.
  const [open, setOpen] = useState({ explorer: true, favorites: true, recent: true, tags: false });
  const route = window.location.pathname;
  const currentId =
    route.startsWith('/notes/') ? route.replace('/notes/', '') : null;

  return (
    <div className="h-full flex flex-col bg-bg-surface text-ink min-w-0">
      {/* Header */}
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

      {/* Floating selection bar */}
      {selected.size > 0 && (
        <div
          data-testid="selection-bar"
          className="mx-2 mt-2 flex items-center justify-between gap-2 rounded border border-brand bg-brand-soft px-2 py-1 text-xs shrink-0"
        >
          <span className="text-ink">{t('dock.selected', { n: selected.size })}</span>
          <div className="flex items-center gap-1">
            <Button variant="danger" size="sm" onClick={onDeleteSelected}>
              <Trash2 size={12} /> {t('dock.delete')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClearSelected}>
              <X size={12} />
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1 min-w-0">
        <Section
          label={t('dock.notes')}
          open={open.explorer}
          onToggle={() => setOpen((o) => ({ ...o, explorer: !o.explorer }))}
        >
          <NotesTree
            folders={folders}
            notes={notes}
            currentId={currentId}
            selected={selected}
            onToggleSelect={onToggleSelect}
            onOpen={(n) => openNote(n.id)}
            onCreateNote={onCreateNote}
            onCreateFolder={onCreateFolder}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
          />
        </Section>

        <Section
          label={t('dock.favorites')}
          open={open.favorites}
          onToggle={() => setOpen((o) => ({ ...o, favorites: !o.favorites }))}
        >
          {favorites.length === 0 ? (
            <Empty>{t('dock.markFavorite')}</Empty>
          ) : (
            favorites.map((n) => (
              <Row
                key={n.id}
                icon={<Star size={13} className="text-yellow-300 fill-yellow-300 shrink-0" />}
                active={currentId === n.id}
                onClick={() => openNote(n.id)}
                title={n.title}
              />
            ))
          )}
        </Section>

        <Section
          label={t('dock.recent')}
          open={open.recent}
          onToggle={() => setOpen((o) => ({ ...o, recent: !o.recent }))}
        >
          {recent.length === 0 ? (
            <Empty>{t('dock.noNotesYet')}</Empty>
          ) : (
            recent.map((n) => (
              <Row
                key={n.id}
                icon={<FileText size={13} className="text-ink-muted shrink-0" />}
                active={currentId === n.id}
                onClick={() => openNote(n.id)}
                title={n.title}
              />
            ))
          )}
        </Section>

        <Section
          label={t('dock.tags')}
          open={open.tags}
          onToggle={() => setOpen((o) => ({ ...o, tags: !o.tags }))}
        >
          {tags.length === 0 ? (
            <Empty>{t('dock.useHashtag')}</Empty>
          ) : (
            <div className="flex flex-wrap gap-1 p-1">
              {tags.map((tg) => (
                <span
                  key={tg.tag}
                  className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-bg text-ink-muted border border-line"
                  title={`${tg.tag} (${tg.count})`}
                >
                  <Hash size={10} />
                  {tg.tag}
                </span>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const Chev = open ? ChevronDown : ChevronRight;
  return (
    <div className="min-w-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1 px-1 py-1 text-[11px] uppercase tracking-wider text-ink-muted hover:text-ink"
      >
        <Chev size={12} />
        <span className="flex-1 text-left truncate">{label}</span>
      </button>
      {open && <div className="min-w-0">{children}</div>}
    </div>
  );
}

function Row({
  icon,
  active,
  onClick,
  title,
}: {
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-sm text-left min-w-0 ${
        active ? 'bg-brand text-white' : 'text-ink hover:bg-bg'
      }`}
      title={title}
    >
      {icon}
      <span className="flex-1 min-w-0 truncate">{title}</span>
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-ink-muted px-2 py-1">{children}</div>;
}
