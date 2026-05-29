import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useApp } from '../AppContext';
import { MonacoMarkdown } from '../../components/MonacoMarkdown';
import { renderMarkdown } from '../../markdown';
import { useT } from '../../i18n';
import type { NoteRef } from '../../api';
import {
  ArrowRight,
  Columns2,
  Eye,
  EyeOff,
  Hash,
  Link2,
  Network,
  Rows2,
  Sparkles,
  Star,
  Trash2,
  X,
} from '../../icons';
import { useDialogs } from '../../ui';
import { extractTags, extractWikilinkTargets } from '../../utils/markdown';
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
  const { api, getNote, notes: allNotes, openByTitle, openNote, saveNote, toggleFavorite, deleteNote, searchTag } = useApp();
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
  // ── Neighbors panel ──────────────────────────────────────────────────
  // One panel, three tabs — collapses the editor's "knowledge context" into
  // a single affordance so the header stays tidy.
  type NeighborsTab = 'outlinks' | 'backlinks' | 'related';
  const [neighborsOpen, setNeighborsOpen] = useState(false);
  const [neighborsTab, setNeighborsTab] = useState<NeighborsTab>('backlinks');
  const [backlinks, setBacklinks] = useState<NoteRef[]>([]);
  const [related, setRelated] = useState<(NoteRef & { distance: number })[]>([]);
  const [loading, setLoading] = useState({ backlinks: false, related: false });

  useEffect(() => {
    if (note) setDraft(note.contentMd);
  }, [note?.id, note?.contentMd]);

  // Keep the dockview tab title in sync with the note's title.
  useEffect(() => {
    if (note) props.api.setTitle(note.title);
  }, [note?.title, props.api]);

  // Eagerly load backlinks — the count badge in the Neighbors button needs
  // to be correct without an extra click. Re-runs when the user edits their
  // own outgoing links (changes who-links-to-whom downstream).
  useEffect(() => {
    if (!note) return;
    setLoading((l) => ({ ...l, backlinks: true }));
    void api.backlinks(note.id).then((rs) => {
      setBacklinks(rs);
      setLoading((l) => ({ ...l, backlinks: false }));
    });
  }, [api, note?.id, note?.contentMd]);

  // Lazy load related notes only the first time the user opens the panel on
  // that tab — pgvector cosine is cheap but unnecessary while it's hidden.
  useEffect(() => {
    if (!note || !neighborsOpen || neighborsTab !== 'related' || related.length > 0) return;
    setLoading((l) => ({ ...l, related: true }));
    void api
      .related(note.id, 10)
      .then((rs) => {
        setRelated(rs);
        setLoading((l) => ({ ...l, related: false }));
      })
      .catch(() => setLoading((l) => ({ ...l, related: false })));
  }, [api, note?.id, neighborsOpen, neighborsTab, related.length]);

  // Only render the preview HTML when it's visible — saves a re-parse on every keystroke.
  const html = useMemo(() => (previewOpen ? renderMarkdown(draft) : ''), [draft, previewOpen]);
  const noteTags = useMemo(() => extractTags(draft), [draft]);

  // Outlinks computed client-side from the draft. Resolve each wikilink
  // target to a known note title (case-insensitive); unresolved targets
  // show up as "missing" so the user can see what links point nowhere.
  const { resolvedOutlinks, missingOutlinks } = useMemo(() => {
    const targets = extractWikilinkTargets(draft);
    const byLower = new Map<string, { id: string; title: string }>();
    // notes from context — only the active workspace's notes are in scope.
    for (const n of allNotes) byLower.set(n.title.toLowerCase(), { id: n.id, title: n.title });
    const ok: NoteRef[] = [];
    const missing: string[] = [];
    for (const t of targets) {
      const m = byLower.get(t);
      if (m) ok.push(m);
      else missing.push(t);
    }
    return { resolvedOutlinks: ok, missingOutlinks: missing };
  }, [draft, allNotes]);

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
            aria-label={neighborsOpen ? 'hide neighbors' : 'show neighbors'}
            title={
              backlinks.length > 0
                ? `Neighbors — ${backlinks.length} backlinks`
                : 'Neighbors (outlinks, backlinks, suggested)'
            }
            onClick={() => setNeighborsOpen((v) => !v)}
            className={`relative p-1 rounded hover:bg-bg-surface ${
              neighborsOpen ? 'text-brand' : 'text-ink-muted hover:text-ink'
            }`}
          >
            <Network size={14} />
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

      {neighborsOpen && (
        <aside
          data-testid="neighbors-footer"
          className="shrink-0 border-t border-line bg-bg-surface flex flex-col max-h-[300px]"
        >
          {/* Tabs */}
          <div className="flex items-center gap-1 px-2 pt-1 border-b border-line shrink-0">
            <NeighborTab
              active={neighborsTab === 'outlinks'}
              onClick={() => setNeighborsTab('outlinks')}
              icon={<ArrowRight size={11} />}
              label="Outlinks"
              count={resolvedOutlinks.length + missingOutlinks.length}
            />
            <NeighborTab
              active={neighborsTab === 'backlinks'}
              onClick={() => setNeighborsTab('backlinks')}
              icon={<Link2 size={11} />}
              label="Backlinks"
              count={backlinks.length}
            />
            <NeighborTab
              active={neighborsTab === 'related'}
              onClick={() => setNeighborsTab('related')}
              icon={<Sparkles size={11} />}
              label="Suggested"
              count={related.length}
            />
            <span className="flex-1" />
            <button
              onClick={() => setNeighborsOpen(false)}
              aria-label="hide neighbors"
              title="Hide neighbors"
              className="p-1 rounded hover:bg-bg text-ink-muted hover:text-ink"
            >
              <X size={12} />
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 text-xs">
            {neighborsTab === 'outlinks' && (
              <OutlinksList
                resolved={resolvedOutlinks}
                missing={missingOutlinks}
                onOpen={openNote}
                onOpenByTitle={(t) => void openByTitle(t)}
              />
            )}
            {neighborsTab === 'backlinks' && (
              <BacklinksList
                items={backlinks}
                loading={loading.backlinks}
                noteTitle={note.title}
                onOpen={openNote}
              />
            )}
            {neighborsTab === 'related' && (
              <RelatedList items={related} loading={loading.related} onOpen={openNote} />
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

// ── Neighbors sub-components ──────────────────────────────────────────
function NeighborTab({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded-t transition-colors ${
        active
          ? 'text-ink border-b-2 border-brand -mb-px'
          : 'text-ink-muted hover:text-ink border-b-2 border-transparent -mb-px'
      }`}
    >
      {icon}
      <span>{label}</span>
      <span className="text-ink-muted">· {count}</span>
    </button>
  );
}

function NoteChip({ title, onClick, hint }: { title: string; onClick: () => void; hint?: string }) {
  return (
    <button
      onClick={onClick}
      title={hint}
      className="px-2 py-0.5 text-xs rounded border border-line bg-brand-soft text-brand hover:bg-bg transition-colors"
    >
      {title}
    </button>
  );
}

function OutlinksList({
  resolved,
  missing,
  onOpen,
  onOpenByTitle,
}: {
  resolved: NoteRef[];
  missing: string[];
  onOpen: (id: string) => void;
  onOpenByTitle: (title: string) => void;
}) {
  if (resolved.length === 0 && missing.length === 0) {
    return (
      <p className="text-ink-muted leading-relaxed">
        No outgoing links yet. Add <code className="px-1 py-0.5 bg-bg rounded">[[Other note]]</code>{' '}
        inside this note to link.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {resolved.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {resolved.map((n) => (
            <NoteChip key={n.id} title={n.title} onClick={() => onOpen(n.id)} />
          ))}
        </div>
      )}
      {missing.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] uppercase tracking-wider text-ink-muted">
            Missing — click to create
          </div>
          <div className="flex flex-wrap gap-1.5">
            {missing.map((m) => (
              <button
                key={m}
                onClick={() => onOpenByTitle(m)}
                className="px-2 py-0.5 text-xs rounded border border-dashed border-line text-ink-muted hover:text-ink hover:border-brand/40 transition-colors"
                title={`Create the note "${m}"`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BacklinksList({
  items,
  loading,
  noteTitle,
  onOpen,
}: {
  items: NoteRef[];
  loading: boolean;
  noteTitle: string;
  onOpen: (id: string) => void;
}) {
  if (loading) return <div className="text-ink-muted">Loading…</div>;
  if (items.length === 0) {
    return (
      <p className="text-ink-muted leading-relaxed">
        No notes link here yet. Mention this one with{' '}
        <code className="px-1 py-0.5 bg-bg rounded">[[{noteTitle}]]</code> from another note and
        it'll appear here.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((b) => (
        <NoteChip key={b.id} title={b.title} onClick={() => onOpen(b.id)} />
      ))}
    </div>
  );
}

function RelatedList({
  items,
  loading,
  onOpen,
}: {
  items: (NoteRef & { distance: number })[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  if (loading) return <div className="text-ink-muted">Looking for related notes…</div>;
  if (items.length === 0) {
    return (
      <p className="text-ink-muted leading-relaxed">
        No semantic neighbours yet — once the embedder has indexed enough notes the closest by
        meaning will show up here, even when there's no <code>[[wikilink]]</code> between them.
      </p>
    );
  }
  // Distance → relevance hint (0..2 cosine; we render lower = brighter).
  return (
    <ul className="flex flex-col gap-1">
      {items.map((r) => {
        const relevance = Math.max(0, Math.min(1, 1 - r.distance / 2));
        return (
          <li key={r.id} className="flex items-center gap-2">
            <button
              onClick={() => onOpen(r.id)}
              className="flex-1 text-left px-2 py-1 rounded hover:bg-bg transition-colors text-ink"
            >
              {r.title}
            </button>
            <span
              className="w-12 h-1 rounded bg-line overflow-hidden shrink-0"
              title={`Cosine distance ${r.distance.toFixed(3)}`}
            >
              <span
                className="block h-full bg-brand"
                style={{ width: `${Math.round(relevance * 100)}%` }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
