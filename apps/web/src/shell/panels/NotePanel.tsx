import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useApp } from '../AppContext';
import { CodeMirrorEditor, type CollabConnectionStatus } from '../../components/CodeMirrorEditor';
import { CollabBanner } from '../../components/CollabBanner';
import { PresenceAvatars, type PresenceUser } from '../../components/PresenceAvatars';
import { renderMarkdown } from '../../markdown';
import { useT } from '../../i18n';
import type { NoteRef } from '../../api';
import {
  ArrowRight,
  Code,
  Hash,
  History,
  Link2,
  Network,
  Sparkles,
  Star,
  Trash2,
  X,
} from '../../icons';
import { Modal, Splitter, useDialogs } from '../../ui';
import type { NoteVersion, NoteVersionMeta } from '../../api';
import { extractTags, extractWikilinkTargets, removeWikilink } from '../../utils/markdown';
import { filterRelated, relevanceFromDistance } from '../../lib/related';
import { getDismissed, dismissRelated } from '../../lib/dismissedRelated';
import { useSettings, type NeighborsTab, type PreviewLayout } from '../../useSettings';
import { useIsMobile } from '../../lib/useIsMobile';

/**
 * A single open note rendered as a Dockview tab.
 *
 * Layout: title bar + actions on top, optional tag chip strip below
 * (only if the note carries any), then ONE full-area body: the rendered
 * Markdown reading view by default, or the raw CodeMirror editor when the
 * Code toggle is on. The two never share the screen — the old split
 * preview was retired in favor of a single mode at a time.
 *
 * Action icons (left → right):
 *   </>        raw-Markdown editor on/off (reading view otherwise)
 *   🔗 + badge neighbors footer (badge shows the backlink count if any)
 *   ⭐         favorite toggle
 *   🗑          delete with confirm
 */
export function NotePanel(props: IDockviewPanelProps<{ noteId: string }>) {
  const { api, getNote, notes: allNotes, openByTitle, openNote, pinTab, saveNote, toggleFavorite, deleteNote, searchTag, user, collabUrl } = useApp();
  const { prefs, setPref } = useSettings();
  const isMobile = useIsMobile();
  const dialogs = useDialogs();
  const t = useT();
  const noteId = props.params.noteId;
  const note = getNote(noteId);

  const [draft, setDraft] = useState(note?.contentMd ?? '');
  // Tracks the `contentMd` we last synced the draft to. Used to detect a
  // genuine external/remote change vs. our own save round-tripping back: if
  // the incoming contentMd equals what we already synced, there's nothing new
  // to apply, so we never clobber unsaved local keystrokes.
  const syncedContentRef = useRef(note?.contentMd ?? '');

  // Collab mode is server-decided: `/api/info` returns `collabUrl` (or null
  // if the instance has DILUXITE_COLLAB_DISABLED=1). Relative paths like
  // `/collab` are resolved against `window.location` so we get the right
  // ws/wss scheme automatically when the app is served over HTTPS.
  const collabConfig = useMemo(() => {
    if (!collabUrl || !note) return undefined;
    const isAbsolute = /^wss?:\/\//i.test(collabUrl);
    const resolved = isAbsolute
      ? collabUrl
      : (() => {
          const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
          return `${scheme}://${window.location.host}${collabUrl}`;
        })();
    // In local mode the bootstrap user is `local@diluxite`; surface its email
    // as the identity so awareness still gives a deterministic color. In
    // server mode, fall back to a placeholder if `/api/info` hasn't returned
    // yet (the avatar fills in once it does).
    const identity = user?.email ?? 'anonymous';
    const displayName = (user?.email ?? 'You').split('@')[0];
    return {
      url: resolved,
      docName: `note:${note.id}`,
      user: { identity, name: displayName },
    };
  }, [collabUrl, note?.id, user?.email]);

  // Roster of users currently connected to this note's doc. Empty until the
  // first awareness change comes through; in collab-off mode it stays empty
  // and the chip doesn't render.
  const [presenceUsers, setPresenceUsers] = useState<PresenceUser[]>([]);
  const [collabStatus, setCollabStatus] = useState<CollabConnectionStatus | null>(null);
  // One body, one mode. Every note opens in the rendered reading view — a
  // note is for reading first — and the Code toggle switches the whole body
  // to the raw-Markdown editor. Per-tab state, deliberately not a persisted
  // pref: "I'm editing right now" is about THIS note, not a global setting.
  // A brand-new empty note opens straight in the editor: nothing to read yet.
  const [mode, setMode] = useState<'read' | 'edit'>(
    (note?.contentMd ?? '').trim() === '' ? 'edit' : 'read',
  );
  const editing = mode === 'edit';
  async function toggleMode() {
    if (editing) {
      await flush();
      setMode('read');
    } else {
      setMode('edit');
    }
  }
  // ── Neighbors panel ──────────────────────────────────────────────────
  // The toggle + active tab + height are persisted prefs (sticky across
  // documents) — open it once, every future note opens with the panel
  // already visible on the tab you left it on.
  // Mobile can't fit a side sidebar → force the stacked footer there.
  const neighborsLayout: PreviewLayout =
    isMobile && prefs.neighborsLayout === 'side' ? 'bottom' : prefs.neighborsLayout;
  const neighborsOpen = neighborsLayout !== 'hidden';
  const neighborsSide = neighborsLayout === 'side';
  const neighborsTab = prefs.neighborsTab;
  // Remember the last non-hidden placement so the toggle restores it.
  const lastNeighborsPlacement = useRef<'side' | 'bottom'>('bottom');
  useEffect(() => {
    if (prefs.neighborsLayout !== 'hidden') lastNeighborsPlacement.current = prefs.neighborsLayout;
  }, [prefs.neighborsLayout]);
  function toggleNeighbors() {
    setPref('neighborsLayout', neighborsOpen ? 'hidden' : lastNeighborsPlacement.current);
  }
  const [historyOpen, setHistoryOpen] = useState(false);
  // Saving is on blur + collab flush — there is no Save button, which reads
  // as "did it save?" to anyone new. This little state answers it in words.
  const [saving, setSaving] = useState(false);
  const [backlinks, setBacklinks] = useState<NoteRef[]>([]);
  const [related, setRelated] = useState<(NoteRef & { distance: number })[]>([]);
  const [loading, setLoading] = useState({ backlinks: false, related: false });
  // Suggestions the user dismissed for THIS note (persisted), so they don't
  // keep coming back.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Neighbors footer/sidebar sizing. The ref feeds the Splitter primitive;
  // we sync to prefs on drag-end (debounce-style).
  const neighborsAsideRef = useRef<HTMLElement>(null);

  // Smart autosave: 4s after the last keystroke, the draft saves itself.
  // Blur still flushes (belt and braces), but saving no longer REQUIRES the
  // counter-intuitive "click outside the editor". The effect re-arms on every
  // draft change, so the timer naturally debounces while the user types.
  // With collab CONNECTED the timer doesn't run at all: the CRDT channel is
  // already persisting every ~2s server-side — a REST save on top would be
  // pure duplicate traffic, and with several people typing, several times so.
  const liveSync = collabStatus === 'connected';
  // "Am I typing right now?" — drives the indicator: while keys are landing
  // it shows activity ("Syncing…" / "Unsaved…"), and settles to the calm
  // state ~1.2s after the last keystroke. Without this, live-sync mode read
  // "Live sync ✓" WHILE typing, which felt like the keystrokes weren't
  // being noticed at all.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    // Only genuine local keystrokes count — seeding/adopting a draft that
    // matches the last synced content is not typing.
    if (!editing || draft === syncedContentRef.current) return;
    setTyping(true);
    const t = setTimeout(() => setTyping(false), 1200);
    return () => clearTimeout(t);
  }, [draft, editing]);
  useEffect(() => {
    if (!editing || liveSync || !note || draft === note.contentMd) return;
    const t = setTimeout(() => void flush(), 4000);
    return () => clearTimeout(t);
    // `flush` reads note/draft at fire time; keying on draft + contentMd is
    // exactly the debounce we want.
  }, [draft, editing, liveSync, note?.contentMd]);

  // Switching to a different note always (re)seeds the draft from that note,
  // and lands on the reading view (or the editor if the note is empty).
  useEffect(() => {
    if (!note) return;
    setDraft(note.contentMd);
    syncedContentRef.current = note.contentMd;
    setMode(note.contentMd.trim() === '' ? 'edit' : 'read');
    // Intentionally keyed only on note id (not contentMd): re-seed on note
    // switch, never on every content change. The companion effect below handles
    // same-note content updates with a dirty check.
  }, [note?.id]);

  // For the *same* note, adopt an incoming contentMd only when the draft has
  // no unsaved local edits. The dirty check is `draft === syncedContentRef`:
  //  - Idle (draft matches the last content we synced): a new contentMd is an
  //    external/remote change → adopt it.
  //  - Dirty (the user typed since the last sync, so draft differs): a save we
  //    fired round-trips back here as a contentMd change, but the user may have
  //    kept typing while it was in flight. Skipping the adopt keeps those
  //    keystrokes (and the cursor) instead of resetting to the just-saved text.
  // Either way we advance the ref so the next genuine external change is seen.
  useEffect(() => {
    if (!note) return;
    if (note.contentMd === syncedContentRef.current) return;
    const dirty = draft !== syncedContentRef.current;
    syncedContentRef.current = note.contentMd;
    if (!dirty) setDraft(note.contentMd);
    // Keyed on contentMd only; `draft` is read but intentionally not a dep — we
    // want this to run when the *incoming* content changes, reading whatever the
    // current draft is at that moment to decide dirtiness.
  }, [note?.contentMd]);

  // Load this note's dismissed-suggestion memory when it changes.
  useEffect(() => {
    setDismissed(note ? getDismissed(note.id) : new Set());
  }, [note?.id]);

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
    void api
      .backlinks(note.id)
      .then((rs) => {
        setBacklinks(rs);
        setLoading((l) => ({ ...l, backlinks: false }));
      })
      .catch(() => setLoading((l) => ({ ...l, backlinks: false })));
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

  // Only render the reading HTML when it's visible — saves a re-parse on every keystroke.
  const html = useMemo(() => (editing ? '' : renderMarkdown(draft)), [draft, editing]);
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

  // Relevance-gated suggestions — computed once so the tab badge and the list
  // agree (the badge counts exactly what you'll see).
  const relatedView = useMemo(() => filterRelated(related, { dismissed }), [related, dismissed]);

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
    if (note && draft !== note.contentMd) {
      setSaving(true);
      try {
        await saveNote(note.id, draft);
      } finally {
        setSaving(false);
      }
    }
  }

  // Neighbors header metadata, shared by the tab bar (bottom) and the accordion
  // (side). Same `neighborsTab` pref drives "active tab" and "expanded section".
  const neighborSections: { id: NeighborsTab; icon: ReactNode; label: string; count: number }[] = [
    {
      id: 'outlinks',
      icon: <ArrowRight size={11} />,
      label: 'Outlinks',
      count: resolvedOutlinks.length + missingOutlinks.length,
    },
    { id: 'backlinks', icon: <Link2 size={11} />, label: 'Backlinks', count: backlinks.length },
    { id: 'related', icon: <Sparkles size={11} />, label: 'Suggested', count: relatedView.shown.length },
  ];

  function neighborContent(tab: NeighborsTab): ReactNode {
    if (!note) return null;
    if (tab === 'outlinks') {
      return (
        <OutlinksList
          resolved={resolvedOutlinks}
          missing={missingOutlinks}
          onOpen={openNote}
          onOpenByTitle={(t) => void openByTitle(t)}
          onUnlink={async (title) => {
            const next = removeWikilink(draft, title);
            setDraft(next);
            await saveNote(note.id, next);
          }}
        />
      );
    }
    if (tab === 'backlinks') {
      return (
        <BacklinksList
          items={backlinks}
          loading={loading.backlinks}
          noteTitle={note.title}
          onOpen={openNote}
        />
      );
    }
    return (
      <RelatedList
        {...relatedView}
        loading={loading.related}
        onOpen={openNote}
        alreadyLinked={new Set(resolvedOutlinks.map((o) => o.title.toLowerCase()))}
        onLink={async (target) => {
          const sep = draft.endsWith('\n') ? '' : '\n\n';
          const nextDraft = `${draft}${sep}[[${target}]]`;
          setDraft(nextDraft);
          await saveNote(note.id, nextDraft);
        }}
        onDismiss={(id) => {
          dismissRelated(note.id, id);
          setDismissed((prev) => new Set(prev).add(id));
        }}
      />
    );
  }

  return (
    <div className="h-full flex flex-col bg-bg text-ink">
      {/*
        Collab connection banner. We render in two states:
          - connecting → amber, "reconectando".
          - disconnected → red, "edición deshabilitada".
        `connected` and `null` (collab off) hide it. The editor goes
        read-only on its own — this is just visible feedback so the user
        understands why typing isn't doing anything.
      */}
      <CollabBanner status={collabStatus} />
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
        {presenceUsers.length > 0 && (
          <div className="shrink-0 mr-1" data-testid="note-presence">
            <PresenceAvatars users={presenceUsers} />
          </div>
        )}
        <div className="flex items-center gap-0.5 shrink-0">
          {editing && (
            <span
              data-testid="save-state"
              className={`text-[10px] mr-1 whitespace-nowrap ${
                (liveSync && typing) || (!liveSync && (saving || draft !== note.contentMd))
                  ? 'text-ink-muted'
                  : 'text-brand'
              }`}
            >
              {liveSync
                ? typing
                  ? t('editor.syncing')
                  : t('editor.liveSync')
                : saving
                  ? t('editor.saving')
                  : draft !== note.contentMd
                    ? t('editor.unsaved')
                    : t('editor.saved')}
            </span>
          )}
          <button
            aria-label={editing ? 'show formatted view' : 'edit raw markdown'}
            title={editing ? t('editor.readView') : t('editor.rawView')}
            onClick={() => void toggleMode()}
            className={`p-1 rounded hover:bg-bg-surface ${
              editing ? 'text-brand' : 'text-ink-muted hover:text-ink'
            }`}
          >
            <Code size={14} />
          </button>
          <button
            aria-label="note history"
            title={t('history.title')}
            onClick={() => setHistoryOpen(true)}
            className="p-1 rounded hover:bg-bg-surface text-ink-muted hover:text-ink"
          >
            <History size={14} />
          </button>
          <button
            aria-label={neighborsOpen ? 'hide neighbors' : 'show neighbors'}
            title={
              backlinks.length > 0
                ? `Neighbors — ${backlinks.length} backlinks`
                : 'Neighbors (outlinks, backlinks, suggested)'
            }
            onClick={toggleNeighbors}
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
                message: `«${note.title}» will be moved to Trash. You can restore it from there.`,
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

      {/* Body: ONE full-area pane — the reading view or the raw editor —
          plus the Neighbors panel. When Neighbors is docked to the side this
          is a row (panel on the right); otherwise a column (panel below). */}
      <div className={`flex-1 min-h-0 flex ${neighborsSide ? 'flex-row' : 'flex-col'}`}>
      <div className="flex-1 min-w-0 min-h-0 flex">
        {editing ? (
          <div className="min-w-0 min-h-0 relative w-full h-full">
            <CodeMirrorEditor
              value={draft}
              onChange={(v) => {
                setDraft(v);
                if (note) pinTab(note.id);
              }}
              onBlur={flush}
              collab={collabConfig}
              onPresenceChange={setPresenceUsers}
              onConnectionChange={setCollabStatus}
            />
          </div>
        ) : (
          <div
            data-testid="preview"
            onClick={onPreviewClick}
            className="md-preview min-w-0 min-h-0 p-5 overflow-auto flex-1"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>

      {neighborsOpen && (
        <>
          <Splitter
            orientation={neighborsSide ? 'horizontal' : 'vertical'}
            value={neighborsSide ? prefs.neighborsWidth : prefs.neighborsHeight}
            min={neighborsSide ? 220 : 120}
            max={
              neighborsSide
                ? Math.min(560, Math.round(window.innerWidth * 0.5))
                : Math.min(600, Math.round(window.innerHeight * 0.6))
            }
            hostRef={neighborsAsideRef}
            leading="after"
            ariaLabel="resize neighbors panel"
            onChange={(px) =>
              setPref(neighborsSide ? 'neighborsWidth' : 'neighborsHeight', Math.round(px))
            }
          />
          <aside
            ref={neighborsAsideRef}
            data-testid="neighbors-footer"
            className={`shrink-0 bg-bg-surface flex flex-col ${
              neighborsSide ? 'border-l border-line' : 'border-t border-line'
            }`}
            style={neighborsSide ? { width: `${prefs.neighborsWidth}px` } : { height: `${prefs.neighborsHeight}px` }}
          >
          {neighborsSide ? (
            /* Vertical sidebar → accordion: one section expanded at a time,
               stacked top-to-bottom. */
            <>
              <div className="flex items-center justify-between px-2 pt-1 shrink-0">
                <span className="text-[10px] uppercase tracking-wider text-ink-muted px-1">
                  Neighbors
                </span>
                <button
                  onClick={() => setPref('neighborsLayout', 'hidden')}
                  aria-label="hide neighbors"
                  title="Hide neighbors"
                  className="p-1 rounded hover:bg-bg text-ink-muted hover:text-ink"
                >
                  <X size={12} />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
                {neighborSections.map((s) => {
                  const expanded = neighborsTab === s.id;
                  return (
                    <div key={s.id} className="border-t border-line first:border-t-0">
                      <button
                        type="button"
                        data-testid={`neighbor-accordion-${s.id}`}
                        aria-expanded={expanded}
                        onClick={() => setPref('neighborsTab', s.id)}
                        className={`w-full flex items-center gap-1.5 px-3 py-2 text-xs hover:bg-bg transition-colors ${
                          expanded ? 'text-ink' : 'text-ink-muted'
                        }`}
                      >
                        {s.icon}
                        <span className="font-medium">{s.label}</span>
                        <span className="text-ink-muted">· {s.count}</span>
                        <span className="flex-1" />
                        <span className="text-ink-muted">{expanded ? '▾' : '▸'}</span>
                      </button>
                      {expanded && <div className="px-3 pb-3 text-xs">{neighborContent(s.id)}</div>}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            /* Horizontal footer → tabs. */
            <>
              <div className="flex items-center gap-1 px-2 pt-1 border-b border-line shrink-0">
                {neighborSections.map((s) => (
                  <NeighborTab
                    key={s.id}
                    active={neighborsTab === s.id}
                    onClick={() => setPref('neighborsTab', s.id)}
                    icon={s.icon}
                    label={s.label}
                    count={s.count}
                  />
                ))}
                <span className="flex-1" />
                <button
                  onClick={() => setPref('neighborsLayout', 'hidden')}
                  aria-label="hide neighbors"
                  title="Hide neighbors"
                  className="p-1 rounded hover:bg-bg text-ink-muted hover:text-ink"
                >
                  <X size={12} />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 text-xs">
                {neighborContent(neighborsTab)}
              </div>
            </>
          )}
        </aside>
        </>
      )}
      </div>

      {historyOpen && (
        <NoteHistoryModal
          noteId={note.id}
          onClose={() => setHistoryOpen(false)}
          onRestored={(contentMd) => {
            // Adopt the restored text RIGHT NOW: content_md in the DB lags
            // the collab flush by ~2s, so waiting for a refresh showed the
            // old text and read as "restore did nothing".
            setDraft(contentMd);
            syncedContentRef.current = contentMd;
          }}
        />
      )}
    </div>
  );
}

// ── Version history modal ─────────────────────────────────────────────
/**
 * List of what this note used to say (newest first) with a rendered preview
 * of the selected snapshot and a restore action. Restore is a NEW save on
 * top — the modal says so, because "restore" sounds destructive and isn't.
 */
function NoteHistoryModal({
  noteId,
  onClose,
  onRestored,
}: {
  noteId: string;
  onClose: () => void;
  /** Fired with the just-applied markdown so the panel adopts it instantly. */
  onRestored: (contentMd: string) => void;
}) {
  const { api, refreshAll } = useApp();
  const dialogs = useDialogs();
  const t = useT();
  const [versions, setVersions] = useState<NoteVersionMeta[] | null>(null);
  const [selected, setSelected] = useState<NoteVersion | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .listVersions(noteId)
      .then((vs) => {
        setVersions(vs);
        if (vs.length > 0) {
          void api.getVersion(noteId, vs[0].id).then(setSelected);
        }
      })
      .catch(() => setVersions([]));
  }, [api, noteId]);

  const selectedHtml = useMemo(
    () => (selected ? renderMarkdown(selected.contentMd) : ''),
    [selected],
  );

  async function restore() {
    if (!selected) return;
    const ok = await dialogs.confirm(t('history.restoreConfirmTitle'), {
      message: t('history.restoreConfirmBody'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const restored = await api.restoreVersion(noteId, selected.id);
      onRestored(restored.contentMd);
      await refreshAll();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('history.title')} size="lg">
      {versions === null ? (
        <p className="text-sm text-ink-muted p-2">…</p>
      ) : versions.length === 0 ? (
        <p className="text-sm text-ink-muted p-2 leading-relaxed">{t('history.empty')}</p>
      ) : (
        <div className="flex gap-3 min-h-0 h-[60vh]">
          <ul
            className="w-56 shrink-0 overflow-y-auto flex flex-col gap-0.5 border-r border-line pr-2"
            data-testid="history-list"
          >
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  onClick={() => void api.getVersion(noteId, v.id).then(setSelected)}
                  aria-pressed={selected?.id === v.id}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${
                    selected?.id === v.id
                      ? 'bg-bg-surface text-ink'
                      : 'text-ink-muted hover:text-ink hover:bg-bg-surface'
                  }`}
                >
                  <span className="block tabular-nums">
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                  <span className="block truncate text-ink-muted">{v.title}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <div
              data-testid="history-preview"
              className="md-preview flex-1 min-h-0 overflow-auto p-3 border border-line rounded"
              dangerouslySetInnerHTML={{ __html: selectedHtml }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-ink-muted">{t('history.restoreHint')}</span>
              <button
                onClick={() => void restore()}
                disabled={!selected || busy}
                className="shrink-0 px-3 py-1.5 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
              >
                {t('history.restore')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
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


function OutlinksList({
  resolved,
  missing,
  onOpen,
  onOpenByTitle,
  onUnlink,
}: {
  resolved: NoteRef[];
  missing: string[];
  onOpen: (id: string) => void;
  onOpenByTitle: (title: string) => void;
  /** Remove the `[[title]]` from this note (keeps the words, drops the edge). */
  onUnlink: (title: string) => void | Promise<void>;
}) {
  return (
    <LinkList
      rows={[
        ...resolved.map((n) => ({ id: n.id, title: n.title })),
        ...missing.map((t) => ({ id: `missing:${t}`, title: t, missing: true })),
      ]}
      onOpen={onOpen}
      onCreate={onOpenByTitle}
      onUnlink={onUnlink}
      empty={
        <>
          No outgoing links yet. Add{' '}
          <code className="px-1 py-0.5 bg-bg rounded">[[Other note]]</code> inside this note to link.
        </>
      }
    />
  );
}

/** When a neighbor list has more than this, show a filter box. */
const FILTER_AT = 8;

interface LinkRow {
  id: string;
  title: string;
  missing?: boolean;
}

/**
 * A scannable, alphabetically-sorted list of neighbor notes with a filter box
 * once it gets long. Rows open on click (or "create" if it's a missing link),
 * and optionally show a × to remove the link. Shared by Outlinks and Backlinks
 * so they behave the same — important once a note has hundreds of backlinks.
 */
function LinkList({
  rows,
  onOpen,
  onCreate,
  onUnlink,
  empty,
}: {
  rows: LinkRow[];
  onOpen?: (id: string) => void;
  onCreate?: (title: string) => void;
  /** Present → show a × that removes the link (works for resolved and missing). */
  onUnlink?: (title: string) => void | Promise<void>;
  empty: React.ReactNode;
}) {
  const [q, setQ] = useState('');
  if (rows.length === 0) return <p className="text-ink-muted leading-relaxed">{empty}</p>;
  const sorted = [...rows].sort((a, b) => a.title.localeCompare(b.title));
  const needle = q.trim().toLowerCase();
  const filtered = needle ? sorted.filter((r) => r.title.toLowerCase().includes(needle)) : sorted;
  return (
    <div className="flex flex-col gap-1">
      {rows.length > FILTER_AT && (
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Filter ${rows.length}…`}
          aria-label="filter list"
          className="w-full px-2 py-1 text-xs rounded border border-line bg-bg text-ink placeholder:text-ink-muted focus:outline-none focus:border-brand/50"
        />
      )}
      <ul className="flex flex-col gap-0.5">
        {filtered.map((r) => (
          <li key={r.id} className="group flex items-center gap-2">
            <button
              onClick={() => (r.missing ? onCreate?.(r.title) : onOpen?.(r.id))}
              className="flex-1 text-left px-2 py-1 rounded hover:bg-bg transition-colors text-ink truncate"
              title={r.missing ? `Create the note "${r.title}"` : `Open ${r.title}`}
            >
              {r.title}
              {r.missing && (
                <span className="ml-2 text-[9px] uppercase tracking-wider text-ink-muted">
                  missing
                </span>
              )}
            </button>
            {onUnlink && (
              <button
                type="button"
                onClick={() => void onUnlink(r.title)}
                aria-label={`Unlink ${r.title}`}
                title={`Remove the [[${r.title}]] link — keeps the text`}
                className="shrink-0 p-1 rounded text-ink-muted hover:text-ink opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X size={12} />
              </button>
            )}
          </li>
        ))}
        {filtered.length === 0 && <li className="px-2 py-1 text-ink-muted">No matches.</li>}
      </ul>
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
  return (
    <LinkList
      rows={items.map((b) => ({ id: b.id, title: b.title }))}
      onOpen={onOpen}
      empty={
        <>
          No notes link here yet. Mention this one with{' '}
          <code className="px-1 py-0.5 bg-bg rounded">[[{noteTitle}]]</code> from another note and
          it&apos;ll appear here.
        </>
      }
    />
  );
}

function RelatedList({
  shown,
  weak,
  loading,
  onOpen,
  onLink,
  onDismiss,
  alreadyLinked,
}: {
  /** Suggestions above the relevance threshold (already filtered). */
  shown: (NoteRef & { distance: number })[];
  /** How many notes fell below the relevance bar (shown as a hint). */
  weak: number;
  loading: boolean;
  onOpen: (id: string) => void;
  /** Append [[title]] to the current note. */
  onLink: (title: string) => void | Promise<void>;
  /** Don't suggest this note again (persisted per source note). */
  onDismiss: (id: string) => void;
  /** Titles (lower-case) already cited by the current note — hides the Link button. */
  alreadyLinked: Set<string>;
}) {
  if (loading) return <div className="text-ink-muted">Looking for related notes…</div>;
  if (shown.length === 0) {
    return (
      <p className="text-ink-muted leading-relaxed">
        No strongly-related notes right now. Suggestions only appear when another note is genuinely
        close in meaning — so your graph stays meaningful instead of linking everything to
        everything.
      </p>
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-1">
        {shown.map((r) => {
          const pct = Math.round(relevanceFromDistance(r.distance) * 100);
          const linked = alreadyLinked.has(r.title.toLowerCase());
          return (
            <li key={r.id} className="group flex items-center gap-2">
              <button
                onClick={() => onOpen(r.id)}
                className="flex-1 text-left px-2 py-1 rounded hover:bg-bg transition-colors text-ink truncate"
                title={r.title}
              >
                {r.title}
              </button>
              <span
                className="shrink-0 w-9 text-right text-[10px] tabular-nums text-ink-muted"
                title={`Relevance ${pct}% · cosine distance ${r.distance.toFixed(3)}`}
              >
                {pct}%
              </span>
              {linked ? (
                <span
                  className="text-[10px] uppercase tracking-wider text-ink-muted shrink-0 px-1"
                  title="Already linked from this note"
                >
                  ✓ linked
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void onLink(r.title)}
                  title={`Insert [[${r.title}]] at the end of this note`}
                  className="shrink-0 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-line text-ink-muted hover:text-ink hover:border-brand/40 transition-colors"
                >
                  Link
                </button>
              )}
              <button
                type="button"
                onClick={() => onDismiss(r.id)}
                aria-label={`Dismiss ${r.title}`}
                title="Dismiss — don't suggest this note again"
                className="shrink-0 p-1 rounded text-ink-muted hover:text-ink opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X size={12} />
              </button>
            </li>
          );
        })}
      </ul>
      {weak > 0 && (
        <p className="mt-2 text-[10px] text-ink-muted">
          {weak} {weak === 1 ? 'note' : 'notes'} below the relevance bar (hidden)
        </p>
      )}
    </>
  );
}
