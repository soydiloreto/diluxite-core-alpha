import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import type { ApiClient, Note, SearchResult } from './api';
import { renderMarkdown } from './markdown';

export function App({ api }: { api: ApiClient }) {
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [current, setCurrent] = useState<Note | null>(null);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [newTitle, setNewTitle] = useState('');

  const refresh = useCallback(
    async (sid: string) => setNotes(await api.listNotes(sid)),
    [api],
  );

  useEffect(() => {
    void (async () => {
      const spaces = await api.listSpaces();
      const sid = spaces[0]?.id ?? null;
      setSpaceId(sid);
      if (sid) await refresh(sid);
    })();
  }, [api, refresh]);

  // Asegura un espacio aunque el effect inicial no haya terminado (evita carreras).
  const ensureSpace = useCallback(async (): Promise<string | null> => {
    if (spaceId) return spaceId;
    const spaces = await api.listSpaces();
    const sid = spaces[0]?.id ?? null;
    setSpaceId(sid);
    return sid;
  }, [api, spaceId]);

  function open(note: Note) {
    setCurrent(note);
    setDraft(note.contenidoMd);
    setResults(null);
  }

  const createNote = useCallback(
    async (titulo: string) => {
      const sid = await ensureSpace();
      if (!sid || !titulo.trim()) return;
      const note = await api.createNote(sid, titulo.trim(), `# ${titulo.trim()}\n\n`);
      await refresh(sid);
      open(note);
    },
    [api, ensureSpace, refresh],
  );

  async function save() {
    if (!current) return;
    const updated = await api.updateNote(current.id, { contenidoMd: draft });
    setCurrent(updated);
    if (spaceId) await refresh(spaceId);
  }

  async function remove(note: Note) {
    await api.deleteNote(note.id);
    if (current?.id === note.id) {
      setCurrent(null);
      setDraft('');
    }
    if (spaceId) await refresh(spaceId);
  }

  async function runSearch() {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    setResults(await api.search(query.trim(), spaceId ?? undefined));
  }

  async function openOrCreateByTitle(titulo: string) {
    const found = notes.find((x) => x.titulo === titulo);
    if (found) open(found);
    else await createNote(titulo);
  }

  function onPreviewClick(e: MouseEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement;
    if (el.classList.contains('wikilink')) {
      e.preventDefault();
      const name = el.getAttribute('data-note');
      if (name) void openOrCreateByTitle(name);
    }
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>🪨 Diluxite</h1>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch();
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
            void createNote(newTitle);
            setNewTitle('');
          }}
        >
          <input
            aria-label="nueva nota"
            placeholder="Nueva nota…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button type="submit">Crear</button>
        </form>

        {results !== null ? (
          <div data-testid="resultados">
            <h2>Resultados</h2>
            <ul>
              {results.map((r) => (
                <li key={r.noteId}>
                  <button
                    onClick={() => {
                      const note = notes.find((n) => n.id === r.noteId);
                      if (note) open(note);
                    }}
                  >
                    {r.titulo}
                  </button>
                  <p>{r.snippet}</p>
                </li>
              ))}
              {results.length === 0 && <li>Sin resultados.</li>}
            </ul>
          </div>
        ) : (
          <ul data-testid="notas">
            {notes.map((n) => (
              <li key={n.id}>
                <button onClick={() => open(n)}>{n.titulo}</button>
                <button aria-label={`borrar ${n.titulo}`} onClick={() => void remove(n)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <main className="main">
        {current ? (
          <div className="editor">
            <h2>{current.titulo}</h2>
            <textarea
              aria-label="contenido"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void save()}
            />
            <div
              className="preview"
              data-testid="preview"
              onClick={onPreviewClick}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }}
            />
          </div>
        ) : (
          <p className="empty">Elegí o creá una nota.</p>
        )}
      </main>
    </div>
  );
}
