import { useState } from 'react';
import type { Note, TagCount } from '../api';

export function Sidebar({
  notes,
  tags,
  activeTag,
  filterLabel,
  onOpen,
  onNew,
  onSearch,
  onTag,
  onClearFilter,
}: {
  notes: Note[];
  tags: TagCount[];
  activeTag: string | null;
  filterLabel: string | null;
  onOpen: (n: Note) => void;
  onNew: (titulo: string) => void;
  onSearch: (q: string) => void;
  onTag: (tag: string) => void;
  onClearFilter: () => void;
}) {
  const [query, setQuery] = useState('');
  const [nuevo, setNuevo] = useState('');

  return (
    <aside className="sidebar">
      <h1>🪨 Diluxite</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSearch(query);
        }}
      >
        <input
          aria-label="buscar"
          placeholder="Buscar en la memoria…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit">Buscar</button>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onNew(nuevo);
          setNuevo('');
        }}
      >
        <input
          aria-label="nueva nota"
          placeholder="Nueva nota…"
          value={nuevo}
          onChange={(e) => setNuevo(e.target.value)}
        />
        <button type="submit">Crear</button>
      </form>

      {filterLabel && (
        <div className="filter-chip" data-testid="filtro">
          {filterLabel}
          <button aria-label="limpiar filtro" onClick={onClearFilter}>
            ✕
          </button>
        </div>
      )}

      <ul className="notas" data-testid="notas">
        {notes.length === 0 && <li className="muted">Sin notas.</li>}
        {notes.map((n) => (
          <li key={n.id}>
            <button onClick={() => onOpen(n)}>{n.titulo}</button>
          </li>
        ))}
      </ul>

      {tags.length > 0 && (
        <div className="tags" data-testid="tags">
          <h3>Tags</h3>
          <div className="tag-cloud">
            {tags.map((t) => (
              <button
                key={t.tag}
                className={activeTag === t.tag ? 'tag active' : 'tag'}
                onClick={() => onTag(t.tag)}
              >
                #{t.tag} ({t.count})
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
