import { useEffect, useState, type MouseEvent } from 'react';
import type { ApiClient, Note, NoteRef } from '../api';
import { renderMarkdown } from '../markdown';
import { Button, IconButton } from '../ui';

export function Editor({
  api,
  note,
  onSaved,
  onDeleted,
  onOpenByTitle,
  onToggleFavorita,
}: {
  api: ApiClient;
  note: Note;
  onSaved: (n: Note) => void;
  onDeleted: (n: Note) => void;
  onOpenByTitle: (titulo: string) => void;
  onToggleFavorita: (id: string, valor: boolean) => void;
}) {
  const [draft, setDraft] = useState(note.contenidoMd);
  const [backlinks, setBacklinks] = useState<NoteRef[]>([]);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setDraft(note.contenidoMd);
    setConfirming(false);
  }, [note.id, note.contenidoMd]);

  useEffect(() => {
    void api.backlinks(note.id).then(setBacklinks);
  }, [api, note.id, note.contenidoMd]);

  async function save() {
    if (draft === note.contenidoMd) return;
    onSaved(await api.updateNote(note.id, { contenidoMd: draft }));
  }

  function onPreviewClick(e: MouseEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement;
    if (el.classList.contains('wikilink')) {
      e.preventDefault();
      const name = el.getAttribute('data-note');
      if (name) onOpenByTitle(name);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-line">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold truncate text-ink">{note.titulo}</h2>
          {note.modificado && (
            <p className="text-xs text-ink-muted">
              editada {new Date(note.modificado).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <IconButton
            aria-label={note.favorita ? 'quitar favorita' : 'marcar favorita'}
            title={note.favorita ? 'Quitar de favoritas' : 'Marcar como favorita'}
            onClick={() => onToggleFavorita(note.id, !note.favorita)}
          >
            <span className={note.favorita ? 'text-yellow-300' : 'text-ink-muted'}>★</span>
          </IconButton>
          {!confirming ? (
            <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
              Borrar
            </Button>
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <span>¿Borrar «{note.titulo}»?</span>
              <Button variant="danger" size="sm" onClick={() => onDeleted(note)}>
                Sí, borrar
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
                Cancelar
              </Button>
            </div>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <textarea
          aria-label="contenido"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          className="w-1/2 p-5 bg-bg text-ink border-none outline-none resize-none font-mono text-sm leading-relaxed"
        />
        <div
          data-testid="preview"
          onClick={onPreviewClick}
          className="md-preview w-1/2 p-5 border-l border-line overflow-auto"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }}
        />
      </div>

      <aside
        data-testid="backlinks"
        className="border-t border-line px-5 py-2 max-h-32 overflow-auto bg-bg-surface"
      >
        <h3 className="text-xs uppercase tracking-wide text-ink-muted mb-1">Backlinks</h3>
        {backlinks.length ? (
          <div className="flex flex-wrap gap-2">
            {backlinks.map((b) => (
              <button
                key={b.id}
                onClick={() => onOpenByTitle(b.titulo)}
                className="px-2 py-0.5 text-xs rounded-md border border-line bg-brand-soft text-brand hover:bg-bg"
              >
                {b.titulo}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink-muted">Ninguna nota enlaza a esta.</p>
        )}
      </aside>
    </div>
  );
}
