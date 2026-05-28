import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useApp } from '../AppContext';
import { MonacoMarkdown } from '../../components/MonacoMarkdown';
import { renderMarkdown } from '../../markdown';
import { useT } from '../../i18n';
import type { NoteRef } from '../../api';
import {
  Columns2,
  Eye,
  EyeOff,
  Hash,
  Link2,
  Rows2,
  Star,
  Trash2,
  X,
} from '../../icons';
import { useDialogs } from '../../ui';
import { extractTags } from '../../utils/markdown';
import { useSettings, type PreviewLayout } from '../../useSettings';
import { useIsMobile } from '../../lib/useIsMobile';

/**
 * A single open note rendered as a Dockview tab.
 *
 * Layout: title bar + actions on top, optional tag chip strip below
 * (only if the note carries any), then Monaco. Markdown preview and
 * the backlinks footer are both off by default and toggled per-tab
 * via the icons in the title bar — both pieces of info live where the
 * note lives, not as global sidebar views.
 *
 * Action icons (left → right):
 *   👁 / 🚫👁  preview side-by-side
 *   🔗 + badge backlinks footer (badge shows the count if any)
 *   ⭐         favorite toggle
 *   🗑          delete with confirm
 */
export function NotePanel(props: IDockviewPanelProps<{ noteId: string }>) {
  const { api, getNote, openByTitle, openNote, saveNote, toggleFavorite, deleteNote, searchTag } = useApp();
  const { prefs, setPref } = useSettings();
  const isMobile = useIsMobile();
  const dialogs = useDialogs();
  const t = useT();
  const noteId = props.params.noteId;
  const note = getNote(noteId);

  const [draft, setDraft] = useState(note?.contentMd ?? '');
  // Preview layout resolution: mobile forces 'bottom' (a 50/50 horizontal
  // split is unreadable on narrow viewports) regardless of the persisted
  // desktop preference. The Eye/EyeOff toggle drives `hidden`; the
  // Columns/Rows toggle (desktop-only) drives `side` vs `bottom`.
  const effectiveLayout: PreviewLayout = isMobile && prefs.previewLayout !== 'hidden' ? 'bottom' : prefs.previewLayout;
  const previewOpen = effectiveLayout !== 'hidden';
  function togglePreviewVisibility() {
    if (previewOpen) setPref('previewLayout', 'hidden');
    else setPref('previewLayout', isMobile ? 'bottom' : 'side');
  }
  function togglePreviewOrientation() {
    setPref('previewLayout', prefs.previewLayout === 'side' ? 'bottom' : 'side');
  }
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [backlinks, setBacklinks] = useState<NoteRef[]>([]);
  const [backlinksLoading, setBacklinksLoading] = useState(false);
  const [backlinksFilter, setBacklinksFilter] = useState('');

  useEffect(() => {
    if (note) setDraft(note.contentMd);
  }, [note?.id, note?.contentMd]);

  // Keep the dockview tab title in sync with the note's title.
  useEffect(() => {
    if (note) props.api.setTitle(note.title);
  }, [note?.title, props.api]);

  // Eagerly load backlinks so the badge count is always accurate. The
  // call is cheap (a single indexed query) and re-runs when the user
  // edits their own outgoing links — i.e. the new wikilink set might
  // change someone else's backlinks, which arrives on the next refresh.
  useEffect(() => {
    if (!note) return;
    setBacklinksLoading(true);
    void api.backlinks(note.id).then((rs) => {
      setBacklinks(rs);
      setBacklinksLoading(false);
    });
  }, [api, note?.id, note?.contentMd]);

  // Only render the preview HTML when it's visible — saves a re-parse on every keystroke.
  const html = useMemo(() => (previewOpen ? renderMarkdown(draft) : ''), [draft, previewOpen]);
  const noteTags = useMemo(() => extractTags(draft), [draft]);

  const filteredBacklinks = useMemo(() => {
    if (!backlinksFilter.trim()) return backlinks;
    const q = backlinksFilter.toLowerCase();
    return backlinks.filter((b) => b.title.toLowerCase().includes(q));
  }, [backlinks, backlinksFilter]);

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
      {/*
        Thin action row. The note's title already shows on its Dockview tab
        so we don't repeat it here. Tag chips live on the left and scroll
        horizontally when there are many; actions stay pinned to the right.
      */}
      <header className="flex items-center gap-2 px-2 h-7 border-b border-line shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto min-w-0 flex-1 no-scrollbar">
          {noteTags.map((tag) => (
            <button
              key={tag}
              onClick={() => searchTag(tag)}
              title={`Search notes tagged #${tag}`}
              className="inline-flex shrink-0 items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded border border-line bg-bg text-ink-muted hover:text-ink hover:border-brand/40 transition-colors"
            >
              <Hash size={10} />
              {tag}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* Layout toggle — only on desktop with the preview visible.
              Mobile always uses 'bottom', no toggle. */}
          {previewOpen && !isMobile && (
            <button
              aria-label={prefs.previewLayout === 'side' ? 'preview below' : 'preview at side'}
              title={
                prefs.previewLayout === 'side'
                  ? 'Move preview below the editor'
                  : 'Move preview side by side'
              }
              onClick={togglePreviewOrientation}
              className="p-1 rounded text-ink-muted hover:text-ink hover:bg-bg-surface"
            >
              {prefs.previewLayout === 'side' ? <Rows2 size={14} /> : <Columns2 size={14} />}
            </button>
          )}
          <button
            aria-label={previewOpen ? 'hide preview' : 'show preview'}
            title={previewOpen ? 'Hide preview' : 'Show preview'}
            onClick={togglePreviewVisibility}
            className={`p-1 rounded hover:bg-bg-surface ${
              previewOpen ? 'text-brand' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {previewOpen ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          <button
            aria-label={backlinksOpen ? 'hide backlinks' : 'show backlinks'}
            title={
              backlinks.length > 0
                ? `${backlinks.length} backlinks`
                : 'Backlinks (no notes link here yet)'
            }
            onClick={() => setBacklinksOpen((v) => !v)}
            className={`relative p-1 rounded hover:bg-bg-surface ${
              backlinksOpen ? 'text-brand' : 'text-ink-muted hover:text-ink'
            }`}
          >
            <Link2 size={14} />
            {backlinks.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] text-[9px] font-medium leading-[14px] text-center px-0.5 rounded-full bg-brand text-white border border-bg">
                {backlinks.length > 99 ? '99+' : backlinks.length}
              </span>
            )}
          </button>
          <button
            aria-label={note.favorite ? 'unfavorite' : 'favorite'}
            title={note.favorite ? t('editor.unfavorite') : t('editor.favorite')}
            onClick={() => toggleFavorite(note.id, !note.favorite)}
            className="p-1 rounded hover:bg-bg-surface"
          >
            <Star
              size={14}
              className={note.favorite ? 'text-yellow-300 fill-yellow-300' : 'text-ink-muted'}
            />
          </button>
          <button
            aria-label="delete note"
            title="Delete note"
            onClick={async () => {
              const ok = await dialogs.confirm('Delete note?', {
                message: `«${note.title}» will be permanently deleted.`,
                danger: true,
              });
              if (ok) await deleteNote(note.id);
            }}
            className="p-1 rounded hover:bg-bg-surface text-ink-muted hover:text-red-400"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </header>

      {/* Editor + preview container. Orientation = effectiveLayout:
            'side'   → horizontal split (50/50, editor left, preview right)
            'bottom' → vertical stack   (editor top, preview bottom 50%)
            'hidden' → editor only      (preview branch is unmounted) */}
      <div
        className={`flex-1 min-h-0 flex ${effectiveLayout === 'bottom' ? 'flex-col' : 'flex-row'}`}
      >
        <div
          className={`min-w-0 min-h-0 relative ${
            previewOpen
              ? effectiveLayout === 'side'
                ? 'w-1/2 h-full border-r border-line'
                : 'w-full h-1/2 border-b border-line'
              : 'w-full h-full'
          }`}
        >
          <MonacoMarkdown value={draft} onChange={setDraft} onBlur={flush} />
        </div>
        {previewOpen && (
          <div
            data-testid="preview"
            onClick={onPreviewClick}
            className={`md-preview min-w-0 min-h-0 p-5 overflow-auto ${
              effectiveLayout === 'side' ? 'w-1/2 h-full' : 'w-full h-1/2'
            }`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>

      {backlinksOpen && (
        <aside
          data-testid="backlinks-footer"
          className="shrink-0 border-t border-line bg-bg-surface flex flex-col max-h-[260px]"
        >
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line shrink-0 text-xs">
            <Link2 size={12} className="shrink-0 text-ink-muted" />
            <span className="font-medium text-ink">Backlinks</span>
            <span className="text-ink-muted">· {backlinks.length}</span>
            <span className="flex-1" />
            {backlinks.length > 6 && (
              <input
                type="search"
                aria-label="filter backlinks"
                placeholder="Filter…"
                value={backlinksFilter}
                onChange={(e) => setBacklinksFilter(e.target.value)}
                className="w-44 text-[11px] px-2 py-0.5 rounded border border-line bg-bg text-ink placeholder:text-ink-muted focus:outline-none focus:border-brand"
              />
            )}
            <button
              onClick={() => setBacklinksOpen(false)}
              aria-label="hide backlinks"
              title="Hide backlinks"
              className="p-0.5 rounded hover:bg-bg text-ink-muted hover:text-ink"
            >
              <X size={12} />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
            {backlinksLoading ? (
              <div className="text-xs text-ink-muted">Loading…</div>
            ) : backlinks.length === 0 ? (
              <p className="text-xs text-ink-muted leading-relaxed">
                No notes link to this one yet. Mention it from another note with{' '}
                <code className="px-1 py-0.5 bg-bg rounded">[[{note.title}]]</code> and it'll
                appear here.
              </p>
            ) : filteredBacklinks.length === 0 ? (
              <div className="text-xs text-ink-muted">
                No matches for &ldquo;{backlinksFilter}&rdquo;.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {filteredBacklinks.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => openNote(b.id)}
                    className="px-2 py-0.5 text-xs rounded border border-line bg-brand-soft text-brand hover:bg-bg transition-colors"
                  >
                    {b.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
