import { useState } from 'react';
import type { Carpeta, Note, TagCount } from '../api';
import { Button, IconButton, Input, ListItem, Section } from '../ui';
import { NotasTree } from '../components/NotasTree';
import { parseHeadings } from '../outline';
import { useT } from '../i18n';

export function LeftDock({
  notes,
  carpetas,
  tags,
  recientes,
  favoritas,
  currentNote,
  selected,
  onToggleSelect,
  onClearSelected,
  onDeleteSelected,
  onOpen,
  onCreateNote,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onSearch,
  onFilterTag,
  onOpenQuickSwitcher,
  onOpenGraph,
}: {
  notes: Note[];
  carpetas: Carpeta[];
  tags: TagCount[];
  recientes: Note[];
  favoritas: Note[];
  currentNote: Note | null;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onClearSelected: () => void;
  onDeleteSelected: () => void;
  onOpen: (n: Note) => void;
  onCreateNote: (carpetaId: string | null) => void;
  onCreateFolder: (padreId: string | null) => void;
  onRenameFolder: (id: string) => void;
  onDeleteFolder: (id: string) => void;
  onSearch: (q: string) => void;
  onFilterTag: (tag: string) => void;
  onOpenQuickSwitcher: () => void;
  onOpenGraph: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const currentId = currentNote?.id ?? null;
  const headings = currentNote ? parseHeadings(currentNote.contenidoMd) : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSearch(q);
          }}
          className="flex-1"
        >
          <Input
            aria-label="search"
            placeholder={t('dock.searchPlaceholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full"
          />
        </form>
        <IconButton
          aria-label="open quick switcher"
          title="Quick switcher (Ctrl/Cmd+K)"
          onClick={onOpenQuickSwitcher}
        >
          ⌘K
        </IconButton>
        <IconButton aria-label="open graph" title="Open graph" onClick={onOpenGraph}>
          🕸
        </IconButton>
      </div>

      {selected.size > 0 && (
        <div
          data-testid="selection-bar"
          className="flex items-center justify-between gap-2 rounded-md border border-brand bg-brand-soft px-2 py-1.5 text-xs"
        >
          <span>{t('dock.selected', { n: selected.size })}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="danger" onClick={onDeleteSelected}>
              {t('dock.delete')}
            </Button>
            <Button size="sm" variant="secondary" onClick={onClearSelected}>
              {t('dock.cancel')}
            </Button>
          </div>
        </div>
      )}

      <Section
        title={t('dock.notes')}
        right={
          <div className="flex">
            <IconButton
              aria-label="new note"
              title={t('dock.newNote')}
              onClick={() => onCreateNote(null)}
            >
              <span className="text-base leading-none">📝</span>
            </IconButton>
            <IconButton
              aria-label="new folder"
              title={t('dock.newFolder')}
              onClick={() => onCreateFolder(null)}
            >
              <span className="text-base leading-none">📁</span>
            </IconButton>
          </div>
        }
      >
        <NotasTree
          carpetas={carpetas}
          notes={notes}
          currentId={currentId}
          selected={selected}
          onToggleSelect={onToggleSelect}
          onOpen={onOpen}
          onCreateNote={onCreateNote}
          onCreateFolder={onCreateFolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
        />
      </Section>

      {currentNote && (
        <Section title={t('dock.outline')} defaultOpen={false}>
          {headings.length === 0 ? (
            <div className="text-xs text-ink-muted px-2">{t('dock.noHeadings')}</div>
          ) : (
            <ul className="text-sm" data-testid="outline">
              {headings.map((h, i) => (
                <li
                  key={i}
                  style={{ paddingLeft: (h.level - 1) * 10 }}
                  className="px-1 py-0.5 text-ink"
                >
                  <span className="text-ink-muted text-xs mr-1">{'#'.repeat(h.level)}</span>
                  {h.text}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title={t('dock.recent')} defaultOpen={false}>
        {recientes.length === 0 && (
          <div className="text-xs text-ink-muted px-2">{t('dock.noNotesYet')}</div>
        )}
        {recientes.map((n) => (
          <ListItem key={n.id} active={currentId === n.id} onClick={() => onOpen(n)}>
            {n.titulo}
          </ListItem>
        ))}
      </Section>

      <Section title={t('dock.favorites')} defaultOpen={false}>
        {favoritas.length === 0 && (
          <div className="text-xs text-ink-muted px-2">{t('dock.markFavorite')}</div>
        )}
        {favoritas.map((n) => (
          <ListItem key={n.id} active={currentId === n.id} onClick={() => onOpen(n)}>
            ★ {n.titulo}
          </ListItem>
        ))}
      </Section>

      <Section title={t('dock.tags')} defaultOpen={false}>
        {tags.length === 0 && (
          <div className="text-xs text-ink-muted px-2">{t('dock.useHashtag')}</div>
        )}
        <div className="flex flex-wrap gap-1 px-1" data-testid="tags-cloud">
          {tags.map((tag) => (
            <button
              key={tag.tag}
              onClick={() => onFilterTag(tag.tag)}
              className="px-2 py-0.5 text-xs rounded-full bg-brand-soft text-brand border border-line hover:bg-bg"
            >
              #{tag.tag} ({tag.count})
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}
