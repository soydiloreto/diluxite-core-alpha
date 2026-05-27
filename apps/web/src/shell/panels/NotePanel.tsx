import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useApp } from '../AppContext';
import { MonacoMarkdown } from '../../components/MonacoMarkdown';
import { renderMarkdown } from '../../markdown';
import { useT } from '../../i18n';
import type { NoteRef } from '../../api';
import { Star } from '../../icons';

/** A single open note rendered as a dockview tab: Monaco | preview, with backlinks footer. */
export function NotePanel(props: IDockviewPanelProps<{ noteId: string }>) {
  const { api, getNote, openByTitle, saveNote, toggleFavorite } = useApp();
  const t = useT();
  const noteId = props.params.noteId;
  const note = getNote(noteId);

  const [draft, setDraft] = useState(note?.contentMd ?? '');
  const [backlinks, setBacklinks] = useState<NoteRef[]>([]);

  useEffect(() => {
    if (note) setDraft(note.contentMd);
  }, [note?.id, note?.contentMd]);

  // Keep the dockview tab title in sync with the note's title.
  useEffect(() => {
    if (note) props.api.setTitle(note.title);
  }, [note?.title, props.api]);

  useEffect(() => {
    if (!note) return;
    void api.backlinks(note.id).then(setBacklinks);
  }, [api, note?.id, note?.contentMd]);

  const html = useMemo(() => renderMarkdown(draft), [draft]);

  if (!note) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-ink-muted">
        Note not found.
      </div>
    );
  }

  function onPreviewClick(e: MouseEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement;
    if (el.classList.contains('wikilink')) {
      e.preventDefault();
      const name = el.getAttribute('data-note');
      if (name) void openByTitle(name);
    }
  }

  async function flush() {
    if (note && draft !== note.contentMd) await saveNote(note.id, draft);
  }

  return (
    <div className="h-full flex flex-col bg-bg text-ink">
      <header className="flex items-center gap-2 px-4 py-2 border-b border-line shrink-0">
        <h2 className="text-sm font-medium truncate flex-1 text-ink" title={note.title}>
          {note.title}
        </h2>
        <button
          aria-label={note.favorite ? 'unfavorite' : 'favorite'}
          title={note.favorite ? t('editor.unfavorite') : t('editor.favorite')}
          onClick={() => toggleFavorite(note.id, !note.favorite)}
          className="p-1 rounded hover:bg-bg-surface"
        >
          <Star
            size={16}
            className={note.favorite ? 'text-yellow-300 fill-yellow-300' : 'text-ink-muted'}
          />
        </button>
      </header>

      <div className="flex-1 min-h-0 flex">
        <div className="w-1/2 min-w-0 h-full border-r border-line relative">
          <MonacoMarkdown value={draft} onChange={setDraft} onBlur={flush} />
        </div>
        <div
          data-testid="preview"
          onClick={onPreviewClick}
          className="md-preview w-1/2 min-w-0 p-5 overflow-auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>

      <aside
        data-testid="backlinks"
        className="border-t border-line px-4 py-2 max-h-28 overflow-auto bg-bg-surface shrink-0"
      >
        <h3 className="text-[10px] uppercase tracking-wide text-ink-muted mb-1">
          {t('editor.backlinks')}
        </h3>
        {backlinks.length ? (
          <div className="flex flex-wrap gap-1.5">
            {backlinks.map((b) => (
              <button
                key={b.id}
                onClick={() => void openByTitle(b.title)}
                className="px-2 py-0.5 text-xs rounded border border-line bg-brand-soft text-brand hover:bg-bg"
              >
                {b.title}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink-muted">{t('editor.noBacklinks')}</p>
        )}
      </aside>
    </div>
  );
}
