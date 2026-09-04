import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../AppContext';
import { useDialogs } from '../../ui';
import { ChevronDown, ChevronRight, Search as SearchIcon, Replace, X } from '../../icons';
import {
  clipLine,
  compileQuery,
  prepareDocs,
  scanPrepared,
  takeMatches,
  EMPTY_SCAN,
} from '../../lib/noteSearch';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { ViewShell, Empty } from './FavoritesView';

/**
 * In-sidebar search & replace across every note in the space. Mirrors
 * VS Code's Search panel:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ SEARCH                                    │
 *   │ 🔎 [query]                  [Aa] [ab] [.*] │
 *   │ ↪ [replace]            [Replace all]     │
 *   ├──────────────────────────────────────────┤
 *   │ N matches in M notes                      │
 *   │ ▾ Note title                              │
 *   │     12:  …line context…                   │
 *   │     45:  …another line…                   │
 *   │ ▾ Other note                              │
 *   │     03:  …context…                        │
 *   └──────────────────────────────────────────┘
 *
 * Matching is client-side against `notes[*].contentMd` (already in
 * memory from listNotes). What costs here is the DOM, not the scan:
 * against 470 real notes the scan runs in ~2 ms while `a` — 11k matching
 * lines — took ~2.9 s of blocked main thread to paint. So the number of
 * rows is capped (`PAGE`) and long lines are windowed, and the debounce
 * is there for the scan to grow into. Replace all writes back via PUT
 * /notes/:id in series, then forces a refresh of the AppContext notes
 * list so the panel and other consumers stay in sync.
 */
const DEBOUNCE_MS = 150;
const PAGE = 100;

export function SearchView({
  seed,
  focusNonce,
}: {
  seed?: { q: string; nonce: number };
  focusNonce?: number;
}) {
  const { api, notes, openNote, refreshAll } = useApp();
  const dialogs = useDialogs();

  const [query, setQuery] = useState(seed?.q ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const [replaceText, setReplaceText] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [replacing, setReplacing] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);

  const [limit, setLimit] = useState(PAGE);

  const { value: appliedQuery, pending, flush } = useDebouncedValue(query, DEBOUNCE_MS);

  const compiled = useMemo(
    () => compileQuery(appliedQuery, { matchCase, wholeWord, regex: useRegex }),
    [appliedQuery, matchCase, wholeWord, useRegex],
  );
  const reError = compiled && 'error' in compiled ? compiled.error : null;
  const validRe = compiled && 're' in compiled ? compiled.re : null;

  // Splitting every note's body only depends on the notes, so it stays out
  // of the per-search work.
  const docs = useMemo(() => prepareDocs(notes), [notes]);

  const { results, totalMatches } = useMemo(
    () => (validRe ? scanPrepared(docs, validRe) : EMPTY_SCAN),
    [docs, validRe],
  );

  const { groups: visibleGroups, shown } = useMemo(
    () => takeMatches(results, limit),
    [results, limit],
  );

  useEffect(() => setLimit(PAGE), [appliedQuery, matchCase, wholeWord, useRegex]);

  // Seed the query when arriving from a tag click ("see all notes with #tag").
  // The nonce bumps on every navigation so re-clicking the same tag re-applies.
  // Flushed, not debounced: the tag is a complete query, not a half-typed one.
  useEffect(() => {
    if (!seed) return;
    setQuery(seed.q);
    flush(seed.q);
  }, [seed?.nonce, seed?.q, flush]);

  // Cmd/Ctrl+F while the view is already open re-focuses the box and selects
  // what's in it, so the shortcut always starts a fresh search.
  useEffect(() => {
    if (focusNonce === undefined) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  async function replaceAll() {
    if (!validRe || !appliedQuery) return;
    const ok = await dialogs.confirm('Replace all?', {
      message: `${totalMatches} matches across ${results.length} notes will be replaced with "${replaceText}". This cannot be undone.`,
      danger: true,
    });
    if (!ok) return;
    setReplacing(true);
    setReplaceError(null);
    // With regex OFF the replacement is a literal string, but String.replace
    // still interprets `$` patterns ($&, $1, $$) in it — so "$&" would inject
    // the match instead of a literal "$&". Escape `$`→`$$` so the user's text
    // is inserted verbatim. With regex ON we honour those patterns on purpose.
    const replacement = useRegex ? replaceText : replaceText.replace(/\$/g, '$$$$');
    try {
      for (const group of results) {
        const note = notes.find((n) => n.id === group.noteId);
        if (!note) continue;
        validRe.lastIndex = 0;
        const newContent = note.contentMd.replace(validRe, replacement);
        if (newContent !== note.contentMd) {
          await api.updateNote(note.id, { contentMd: newContent });
        }
      }
    } catch (e) {
      // A failure mid-loop leaves a partial replacement — surface it instead
      // of swallowing the rejection, so the user knows to re-run / check.
      setReplaceError(
        `Replace stopped partway: ${e instanceof Error ? e.message : String(e)}. Some notes may already be updated.`,
      );
    } finally {
      // Always pull fresh notes/tags so the panel + the rest of the app
      // reflect whatever did land, with no page reload + no state loss.
      await refreshAll();
      setReplacing(false);
    }
  }

  function toggleGroup(id: string) {
    setCollapsed((s) => {
      const ns = new Set(s);
      ns.has(id) ? ns.delete(id) : ns.add(id);
      return ns;
    });
  }

  function highlight(rawLine: string): React.ReactNode {
    if (!validRe) return rawLine;
    const { text: line, clippedStart, clippedEnd } = clipLine(rawLine, validRe);
    const out: React.ReactNode[] = [];
    if (clippedStart) out.push('…');
    let last = 0;
    validRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = validRe.exec(line))) {
      if (m.index > last) out.push(line.slice(last, m.index));
      out.push(
        <mark key={`${m.index}-${m[0]}`} className="bg-yellow-400/30 text-ink rounded px-0.5">
          {m[0]}
        </mark>,
      );
      last = m.index + m[0].length;
      if (m[0].length === 0) validRe.lastIndex++; // guard against zero-width
    }
    if (last < line.length) out.push(line.slice(last));
    if (clippedEnd) out.push('…');
    return out;
  }

  return (
    <ViewShell title="Search" count={query ? totalMatches : undefined}>
      <div className="flex flex-col gap-2 min-h-0">
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setShowReplace((v) => !v)}
            aria-label={showReplace ? 'hide replace' : 'show replace'}
            title="Toggle replace"
            className="p-1 text-ink-muted hover:text-ink"
          >
            {showReplace ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <div className="relative flex-1">
            <SearchIcon
              size={12}
              aria-hidden
              className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none"
            />
            <input
              ref={inputRef}
              type="search"
              autoFocus
              aria-label="search query"
              placeholder="Search"
              value={query}
              onChange={(e) => {
                const next = e.target.value;
                setQuery(next);
                // Clearing the box has nothing to compute — go back to the
                // hint right away instead of flashing a skeleton first.
                if (next === '') flush('');
              }}
              className={`w-full text-xs pl-7 pr-2 py-1 rounded border bg-bg text-ink placeholder:text-ink-muted focus:outline-none focus:border-brand ${
                reError ? 'border-red-500/60' : 'border-line'
              }`}
            />
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0 pl-5">
          <OptionToggle
            active={matchCase}
            onClick={() => setMatchCase((v) => !v)}
            title="Match case — distinguishes Foo from foo"
            label="Aa"
          />
          <OptionToggle
            active={wholeWord}
            onClick={() => setWholeWord((v) => !v)}
            title="Whole word — matches only when the query is its own word, not a substring"
            label="ab|"
          />
          <OptionToggle
            active={useRegex}
            onClick={() => setUseRegex((v) => !v)}
            title="Regular expression — interprets the query as a JavaScript regex"
            label=".*"
          />
          {reError && (
            <span className="text-[10px] text-red-400 truncate" title={reError}>
              {reError}
            </span>
          )}
        </div>

        {showReplace && (
          <div className="flex items-center gap-1 shrink-0 pl-5">
            <div className="relative flex-1">
              <Replace
                size={12}
                aria-hidden
                className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none"
              />
              <input
                type="text"
                aria-label="replace text"
                placeholder="Replace"
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                className="w-full text-xs pl-7 pr-2 py-1 rounded border border-line bg-bg text-ink placeholder:text-ink-muted focus:outline-none focus:border-brand"
              />
            </div>
            <button
              type="button"
              onClick={replaceAll}
              disabled={!validRe || totalMatches === 0 || replacing || pending}
              title="Replace all matches"
              className="text-[11px] px-2 py-1 rounded bg-brand text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand/80"
            >
              {replacing ? 'Replacing…' : `Replace ${totalMatches > 0 ? `(${totalMatches})` : ''}`}
            </button>
          </div>
        )}

        {replaceError && (
          <p
            role="alert"
            className="text-[11px] text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2 shrink-0"
          >
            {replaceError}
          </p>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 pt-1 border-t border-line">
          {!query ? (
            <Empty>Type to search across all notes. Toggle the arrow on the left to reveal Replace.</Empty>
          ) : pending ? (
            <ResultsSkeleton />
          ) : results.length === 0 ? (
            <Empty>No matches.</Empty>
          ) : (
            <div className="flex flex-col gap-2 py-2">
              <div className="text-[11px] text-ink-muted px-1">
                {totalMatches} match{totalMatches === 1 ? '' : 'es'} in {results.length} note
                {results.length === 1 ? '' : 's'}
              </div>
              {visibleGroups.map((g) => {
                const open = !collapsed.has(g.noteId);
                const Chev = open ? ChevronDown : ChevronRight;
                return (
                  <div key={g.noteId} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.noteId)}
                      className="w-full flex items-center gap-1 px-1 py-0.5 text-xs text-ink-muted hover:text-ink"
                    >
                      <Chev size={11} className="shrink-0" />
                      <span className="font-medium text-ink truncate">{g.title}</span>
                      <span className="shrink-0">· {g.matches.length}</span>
                    </button>
                    {open && (
                      <div className="pl-5">
                        {g.matches.map((m, i) => (
                          <button
                            key={i}
                            onClick={() => openNote(g.noteId)}
                            className="block w-full text-left text-[11px] py-0.5 hover:bg-bg rounded text-ink-muted hover:text-ink"
                          >
                            <span className="text-ink-muted/60">{String(m.lineNo).padStart(3, ' ')}:</span>{' '}
                            <span className="whitespace-pre-wrap break-words">{highlight(m.line)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {shown < totalMatches && (
                <div className="flex items-center gap-2 px-1 pt-1 pb-2">
                  <span className="text-[11px] text-ink-muted">
                    Showing {shown} of {totalMatches}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLimit((n) => n + PAGE * 5)}
                    className="text-[11px] px-2 py-0.5 rounded border border-line text-ink-muted hover:text-ink hover:border-brand/40"
                  >
                    Show more
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </ViewShell>
  );
}

function ResultsSkeleton() {
  const groups = [
    ['w-2/5', ['w-11/12', 'w-3/4']],
    ['w-1/3', ['w-10/12', 'w-2/3', 'w-5/6']],
  ] as const;
  return (
    <div
      data-testid="search-skeleton"
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="flex flex-col gap-3 py-2 animate-pulse"
    >
      <span className="sr-only">Searching…</span>
      <div className="h-2.5 w-1/2 rounded bg-ink-muted/20 mx-1" />
      {groups.map(([title, lines], g) => (
        <div key={g} className="flex flex-col gap-1.5">
          <div className={`h-2.5 ${title} rounded bg-ink-muted/25 mx-1`} />
          <div className="pl-5 flex flex-col gap-1.5">
            {lines.map((w, i) => (
              <div key={i} className={`h-2 ${w} rounded bg-ink-muted/15`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function OptionToggle({
  active,
  onClick,
  title,
  label,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`inline-flex items-center justify-center w-6 h-6 rounded border text-[10px] font-mono leading-none ${
        active
          ? 'bg-brand text-white border-brand'
          : 'border-line text-ink-muted hover:text-ink hover:border-brand/40'
      }`}
    >
      {label}
    </button>
  );
}
