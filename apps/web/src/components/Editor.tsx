import { useEffect, useState, type MouseEvent } from 'react';
import type { ApiClient, Note, NoteRef } from '../api';
import { renderMarkdown } from '../markdown';

export function Editor({
  api,
  note,
  onSaved,
  onDeleted,
  onOpenByTitle,
}: {
  api: ApiClient;
  note: Note;
  onSaved: (n: Note) => void;
  onDeleted: (n: Note) => void;
  onOpenByTitle: (titulo: string) => void;
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
    <div className="editor">
      <header className="editor-head">
        <div>
          <h2>{note.titulo}</h2>
          {note.modificado && (
            <span className="meta">editada {new Date(note.modificado).toLocaleString()}</span>
          )}
        </div>
        {!confirming ? (
          <button className="danger" onClick={() => setConfirming(true)}>
            Borrar
          </button>
        ) : (
          <span className="confirm">
            ¿Borrar «{note.titulo}»?
            <button className="danger" onClick={() => onDeleted(note)}>
              Sí, borrar
            </button>
            <button onClick={() => setConfirming(false)}>Cancelar</button>
          </span>
        )}
      </header>

      <div className="editor-body">
        <textarea
          aria-label="contenido"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
        />
        <div
          className="preview"
          data-testid="preview"
          onClick={onPreviewClick}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }}
        />
      </div>

      <aside className="backlinks" data-testid="backlinks">
        <h3>Backlinks</h3>
        {backlinks.length ? (
          <ul>
            {backlinks.map((b) => (
              <li key={b.id}>
                <button onClick={() => onOpenByTitle(b.titulo)}>{b.titulo}</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Ninguna nota enlaza a esta.</p>
        )}
      </aside>
    </div>
  );
}
