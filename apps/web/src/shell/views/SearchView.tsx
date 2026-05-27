import { useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { useDialogs } from '../../ui';
import { ChevronDown, ChevronRight, Search as SearchIcon, Replace, X } from '../../icons';
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
 * memory from listNotes). With 500 notes a re-filter per keystroke
 * runs in under ~20 ms locally so we don't need a debounce. Replace
 * all writes back via PUT /notes/:id in series, then forces a refresh
 * of the AppContext notes list so the panel and other consumers stay
 * in sync.
 */
type Match = { lineNo: number; line: string };
type ResultGroup = { noteId: string; title: string; matches: Match[] };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeRegExp(query: string, opts: { matchCase: boolean; wholeWord: boolean; regex: boolean }): RegExp | { error: string } | null {
  if (!query) return null;
  try {
    const raw = opts.regex ? query : escapeRegExp(query);
    const pattern = opts.wholeWord ? `\\b${raw}\\b` : raw;
    return new RegExp(pattern, opts.matchCase ? 'g' : 'gi');
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Invalid pattern' };
  }
}

export function SearchView() {
  const { api, notes, openNote, refreshAll } = useApp();
  const dialogs = useDialogs();

  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [replacing, setReplacing] = useState(false);

  const re = useMemo(
    () => makeRegExp(query, { matchCase, wholeWord, regex: useRegex }),
    [query, matchCase, wholeWord, useRegex],
  );
  const reError = re && 'error' in re ? re.error : null;
  const validRe = re && !('error' in re) ? re : null;

  const { results, totalMatches } = useMemo(() => {
    if (!validRe || !query) return { results: [] as ResultGroup[], totalMatches: 0 };
    const out: ResultGroup[] = [];
    let total = 0;
    for (const n of notes) {
      const lines = n.contentMd.split('\n');
      const matches: Match[] = [];
      for (let i = 0; i < lines.length; i++) {
        validRe.lastIndex = 0;
        if (validRe.test(lines[i])) matches.push({ lineNo: i + 1, line: lines[i] });
      }
      if (matches.length > 0) {
        out.push({ noteId: n.id, title: n.title, matches });
        total += matches.length;
      }
    }
    return { results: out, totalMatches: total };
  }, [validRe, query, notes]);

  async function replaceAll() {
    if (!validRe || !query) return;
    const ok = await dialogs.confirm('Replace all?', {
      message: `${totalMatches} matches across ${results.length} notes will be replaced with "${replaceText}". This cannot be undone.`,
      danger: true,
    });
    if (!ok) return;
    setReplacing(true);
    try {
      for (const group of results) {
        const note = notes.find((n) => n.id === group.noteId);
        if (!note) continue;
        validRe.lastIndex = 0;
        const newContent = note.contentMd.replace(validRe, replaceText);
        if (newContent !== note.contentMd) {
          await api.updateNote(note.id, { contentMd: newContent });
        }
      }
      // Pull fresh notes/tags so the panel + the rest of the app reflect
      // the new content immediately, with no page reload + no state loss.
      await refreshAll();
    } finally {
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

  function highlight(line: string): React.ReactNode {
    if (!validRe) return line;
    const out: React.ReactNode[] = [];
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
              type="search"
              autoFocus
              aria-label="search query"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
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
              disabled={!validRe || totalMatches === 0 || replacing}
              title="Replace all matches"
              className="text-[11px] px-2 py-1 rounded bg-brand text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand/80"
            >
              {replacing ? 'Replacing…' : `Replace ${totalMatches > 0 ? `(${totalMatches})` : ''}`}
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 pt-1 border-t border-line">
          {!query ? (
            <Empty>Type to search across all notes. Toggle the arrow on the left to reveal Replace.</Empty>
          ) : results.length === 0 ? (
            <Empty>No matches.</Empty>
          ) : (
            <div className="flex flex-col gap-2 py-2">
              <div className="text-[11px] text-ink-muted px-1">
                {totalMatches} match{totalMatches === 1 ? '' : 'es'} in {results.length} note
                {results.length === 1 ? '' : 's'}
              </div>
              {results.map((g) => {
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
            </div>
          )}
        </div>
      </div>
    </ViewShell>
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
