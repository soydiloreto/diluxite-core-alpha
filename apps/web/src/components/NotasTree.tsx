import { useState } from 'react';
import type { Carpeta, Note } from '../api';
import { TreeItem, IconButton } from '../ui';

/**
 * Árbol de carpetas + notas. Click en carpeta expande/colapsa.
 * Click en nota la abre. Botones para crear carpeta/nota en raíz.
 */
export function NotasTree({
  carpetas,
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
  carpetas: Carpeta[];
  notes: Note[];
  currentId: string | null;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (n: Note) => void;
  onCreateFolder: (padreId: string | null) => void;
  onCreateNote: (carpetaId: string | null) => void;
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
    carpetas.filter((c) => c.padreId === pid).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const notesIn = (cid: string | null) =>
    notes.filter((n) => (n.carpetaId ?? null) === cid).sort((a, b) => a.titulo.localeCompare(b.titulo));

  const renderFolder = (c: Carpeta, depth: number) => {
    const open = expanded.has(c.id);
    return (
      <div key={c.id}>
        <TreeItem
          depth={depth}
          expandable
          expanded={open}
          onToggle={() => toggle(c.id)}
          onClick={() => toggle(c.id)}
          icon={open ? '📂' : '📁'}
          right={
            <div className="flex">
              <IconButton
                aria-label={`nueva nota en ${c.nombre}`}
                title="Nueva nota aquí"
                onClick={() => onCreateNote(c.id)}
              >
                <span className="text-base leading-none">+</span>
              </IconButton>
              {onRenameFolder && (
                <IconButton aria-label={`renombrar ${c.nombre}`} title="Renombrar" onClick={() => onRenameFolder(c.id)}>
                  <span className="text-xs">✎</span>
                </IconButton>
              )}
              {onDeleteFolder && (
                <IconButton aria-label={`borrar carpeta ${c.nombre}`} title="Borrar carpeta" onClick={() => onDeleteFolder(c.id)}>
                  <span className="text-xs">🗑</span>
                </IconButton>
              )}
            </div>
          }
        >
          {c.nombre}
        </TreeItem>
        {open && (
          <>
            {childFolders(c.id).map((sub) => renderFolder(sub, depth + 1))}
            {notesIn(c.id).map((n) => renderNote(n, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const renderNote = (n: Note, depth: number) => {
    const isSel = selected.has(n.id);
    return (
      <div
        key={n.id}
        className={`flex items-center gap-1 rounded-md text-sm ${
          currentId === n.id ? 'bg-brand text-white' : 'hover:bg-bg-surface'
        } ${isSel ? 'ring-1 ring-brand/60' : ''}`}
        style={{ paddingLeft: depth * 12 }}
      >
        <button
          onClick={() => onToggleSelect(n.id)}
          aria-label={isSel ? `desmarcar ${n.titulo}` : `marcar ${n.titulo}`}
          className="w-5 text-center text-ink-muted hover:text-ink"
        >
          {isSel ? '☑' : '☐'}
        </button>
        <span className="text-xs">{n.favorita ? '★' : '📝'}</span>
        <button
          onClick={() => onOpen(n)}
          className="flex-1 min-w-0 text-left py-1 px-1 truncate"
        >
          {n.titulo}
        </button>
      </div>
    );
  };

  const empty = carpetas.length === 0 && notes.length === 0;

  return (
    <div className="flex flex-col gap-0.5">
      {childFolders(null).map((c) => renderFolder(c, 0))}
      {notesIn(null).map((n) => renderNote(n, 0))}
      {empty && <div className="text-xs text-ink-muted px-2 py-3">Tu memoria está vacía.</div>}
      <div className="flex gap-2 mt-2 px-1 text-xs">
        <button onClick={() => onCreateNote(null)} className="text-ink-muted hover:text-ink">
          + nota
        </button>
        <button onClick={() => onCreateFolder(null)} className="text-ink-muted hover:text-ink">
          + carpeta
        </button>
      </div>
    </div>
  );
}
