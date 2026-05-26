import { useState } from 'react';
import type { Carpeta, Note, TagCount } from '../api';
import { Button, IconButton, Input, ListItem, Section } from '../ui';
import { NotasTree } from '../components/NotasTree';
import { parseHeadings } from '../outline';

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
            aria-label="buscar"
            placeholder="Buscar memoria…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full"
          />
        </form>
        <IconButton
          aria-label="abrir buscador rápido"
          title="Buscador rápido (Ctrl+K)"
          onClick={onOpenQuickSwitcher}
        >
          ⌘K
        </IconButton>
        <IconButton aria-label="ver grafo" title="Vista de grafo" onClick={onOpenGraph}>
          🕸
        </IconButton>
      </div>

      {selected.size > 0 && (
        <div
          data-testid="selection-bar"
          className="flex items-center justify-between gap-2 rounded-md border border-brand bg-brand-soft px-2 py-1.5 text-xs"
        >
          <span>{selected.size} seleccionada{selected.size === 1 ? '' : 's'}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="danger" onClick={onDeleteSelected}>
              Borrar
            </Button>
            <Button size="sm" variant="secondary" onClick={onClearSelected}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      <Section
        title="Notes"
        right={
          <div className="flex">
            <IconButton
              aria-label="new note"
              title="New note"
              onClick={() => onCreateNote(null)}
            >
              <span className="text-base leading-none">📝</span>
            </IconButton>
            <IconButton
              aria-label="new folder"
              title="New folder"
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
        <Section title="Outline" defaultOpen={false}>
          {headings.length === 0 ? (
            <div className="text-xs text-ink-muted px-2">Sin headings.</div>
          ) : (
            <ul className="text-sm" data-testid="outline">
              {headings.map((h, i) => (
                <li key={i} style={{ paddingLeft: (h.level - 1) * 10 }} className="px-1 py-0.5 text-ink">
                  <span className="text-ink-muted text-xs mr-1">{'#'.repeat(h.level)}</span>
                  {h.text}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title="Recientes" defaultOpen={false}>
        {recientes.length === 0 && <div className="text-xs text-ink-muted px-2">Sin notas aún.</div>}
        {recientes.map((n) => (
          <ListItem key={n.id} active={currentId === n.id} onClick={() => onOpen(n)}>
            {n.titulo}
          </ListItem>
        ))}
      </Section>

      <Section title="Favoritas" defaultOpen={false}>
        {favoritas.length === 0 && (
          <div className="text-xs text-ink-muted px-2">Marcá una nota con ★ para fijarla acá.</div>
        )}
        {favoritas.map((n) => (
          <ListItem key={n.id} active={currentId === n.id} onClick={() => onOpen(n)}>
            ★ {n.titulo}
          </ListItem>
        ))}
      </Section>

      <Section title="Tags" defaultOpen={false}>
        {tags.length === 0 && <div className="text-xs text-ink-muted px-2">Usá #tag dentro de una nota.</div>}
        <div className="flex flex-wrap gap-1 px-1" data-testid="tags-cloud">
          {tags.map((t) => (
            <button
              key={t.tag}
              onClick={() => onFilterTag(t.tag)}
              className="px-2 py-0.5 text-xs rounded-full bg-brand-soft text-brand border border-line hover:bg-bg"
            >
              #{t.tag} ({t.count})
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}
