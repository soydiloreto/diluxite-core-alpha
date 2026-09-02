import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../AppContext';
import type { Note } from '../../api';
import { ViewShell, Empty } from './FavoritesView';
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  FilePlus,
  Pencil,
  Search as SearchIcon,
} from '../../icons';

/**
 * Sidebar view: chronological timeline of recent activity.
 *
 * Each note contributes one entry — `created` if its updatedAt sits
 * within the indexing window of createdAt, `edited` otherwise. Entries
 * are bucketed by calendar day.
 *
 * Affordances:
 *  - Header search filters by note title.
 *  - From / To date inputs (HTML5 native — click to open the picker).
 *    Defaults to the actual range of the workspace activity on first
 *    mount so the user sees "the whole picture" instead of empty
 *    placeholders.
 *  - Expand-all / Collapse-all icons in the header.
 *  - Days collapse / expand independently — single source of truth
 *    (a Set of collapsed keys), so the all-ops stay consistent with
 *    individual toggles.
 *
 * Limitation acknowledged at the bottom: folder operations and
 * deletes aren't represented because we don't have a persistent
 * activity log yet.
 */
type ActivityKind = 'created' | 'edited';
type Activity = { kind: ActivityKind; at: Date; note: Note };

const INDEX_WINDOW_MS = 5_000;

function activityOf(n: Note): Activity | null {
  if (!n.createdAt || !n.updatedAt) return null;
  const created = new Date(n.createdAt);
  const updated = new Date(n.updatedAt);
  if (Number.isNaN(created.getTime()) || Number.isNaN(updated.getTime())) return null;
  if (updated.getTime() - created.getTime() < INDEX_WINDOW_MS) {
    return { kind: 'created', at: created, note: n };
  }
  return { kind: 'edited', at: updated, note: n };
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Parse a "yyyy-mm-dd" string (as emitted by `<input type="date">`) into a
 * Date at local midnight. We avoid `new Date(s)` because it interprets the
 * bare string as UTC, which causes the from/to filter to drop the current
 * day in any TZ west of UTC (the timestamp lands on the previous local day).
 */
function parseDateInput(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// `<input type="date">` consumes the same "yyyy-mm-dd" we use for grouping —
// `dayKey` is the single source of truth for that format.

function labelForDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isSameDay(date, today)) return 'Today';
  if (isSameDay(date, yesterday)) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  }).format(date);
}

function formatTime(d: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

export function RecentView() {
  const { notes, openNote } = useApp();
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Single source of truth: which day keys the user has explicitly collapsed.
  // Empty set ⇒ everything open. Expand-all clears it. Collapse-all fills it
  // with every day except today (we keep "today" visible because hiding the
  // most useful section by default isn't useful).
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(() => new Set());
  const todayKey = useMemo(() => dayKey(new Date()), []);
  const dateDefaultedRef = useRef(false);
  // The newest day we auto-seeded `to` with. Used to extend the upper bound as
  // newer activity arrives, but only while the user hasn't narrowed it.
  const autoToRef = useRef<string | null>(null);

  // All activities computed from the notes list — used both for defaults
  // (find the actual oldest / newest event) and for the filtered list below.
  const allActivities = useMemo(() => {
    const out: Activity[] = [];
    for (const n of notes) {
      // Same rule as the tree: archived notes are out of the recents.
      if (n.archivedAt) continue;
      const a = activityOf(n);
      if (a) out.push(a);
    }
    out.sort((x, y) => y.at.getTime() - x.at.getTime());
    return out;
  }, [notes]);

  // Seed the date inputs on the first mount that has data so the user
  // sees the actual range of their workspace instead of empty placeholders.
  useEffect(() => {
    if (allActivities.length === 0) return;
    // allActivities is sorted desc, so [0] is the newest day.
    const newest = dayKey(allActivities[0].at);
    if (!dateDefaultedRef.current) {
      const oldest = dayKey(allActivities[allActivities.length - 1].at);
      setFrom(oldest);
      setTo(newest);
      autoToRef.current = newest;
      dateDefaultedRef.current = true;
      return;
    }
    // Activity newer than the seeded upper bound just appeared (e.g. the user
    // created a note after opening this view). Extend `to` so it stays visible
    // — but only while the user hasn't manually narrowed the upper bound,
    // which we detect by comparing against the last value we set ourselves.
    setTo((prev) => {
      if (prev === autoToRef.current && newest > prev) {
        autoToRef.current = newest;
        return newest;
      }
      return prev;
    });
  }, [allActivities]);

  const filteredActivities = useMemo(() => {
    const q = query.trim().toLowerCase();
    // parseDateInput returns local-midnight (already a "start of day"); using
    // `new Date(from)` would interpret the string as UTC and shift the boundary.
    const fromDate = from ? parseDateInput(from) : null;
    const toDate = to ? parseDateInput(to) : null;
    const out: Activity[] = [];
    for (const a of allActivities) {
      if (q && !a.note.title.toLowerCase().includes(q)) continue;
      const day = startOfDay(a.at);
      if (fromDate && day < fromDate) continue;
      if (toDate && day > toDate) continue;
      out.push(a);
    }
    return out;
  }, [allActivities, query, from, to]);

  const dayGroups = useMemo(() => {
    const map = new Map<string, Activity[]>();
    for (const a of filteredActivities) {
      const k = dayKey(a.at);
      const arr = map.get(k);
      if (arr) arr.push(a);
      else map.set(k, [a]);
    }
    return Array.from(map.entries());
  }, [filteredActivities]);

  const isOpen = (key: string) => !collapsedDays.has(key);

  function toggleDay(key: string) {
    setCollapsedDays((s) => {
      const ns = new Set(s);
      if (ns.has(key)) ns.delete(key);
      else ns.add(key);
      return ns;
    });
  }

  function expandAll() {
    setCollapsedDays(new Set());
  }

  function collapseAll() {
    const all = new Set<string>();
    for (const [key] of dayGroups) {
      if (key !== todayKey) all.add(key);
    }
    setCollapsedDays(all);
  }

  const filtersActive = !!(
    query.trim() ||
    (from && allActivities.length > 0 && from !== dayKey(allActivities[allActivities.length - 1].at)) ||
    (to && allActivities.length > 0 && to !== dayKey(allActivities[0].at))
  );

  function clearFilters() {
    setQuery('');
    if (allActivities.length > 0) {
      const sortedAsc = [...allActivities].reverse();
      setFrom(dayKey(sortedAsc[0].at));
      setTo(dayKey(sortedAsc[sortedAsc.length - 1].at));
    } else {
      setFrom('');
      setTo('');
    }
  }

  return (
    <ViewShell title="Timeline" count={filteredActivities.length}>
      <div className="flex flex-col gap-2 min-h-0">
        <div className="relative shrink-0">
          <SearchIcon
            size={12}
            aria-hidden
            className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none"
          />
          <input
            type="search"
            aria-label="filter timeline by title"
            placeholder="Filter notes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full text-xs pl-7 pr-2 py-1 rounded border border-line bg-bg text-ink placeholder:text-ink-muted focus:outline-none focus:border-brand"
          />
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-ink-muted shrink-0">
          <CalendarDays size={11} className="shrink-0" aria-hidden />
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="from date"
            title="From date"
            max={to || undefined}
            className="flex-1 min-w-0 text-[11px] px-1.5 py-0.5 rounded border border-line bg-bg text-ink focus:outline-none focus:border-brand"
          />
          <span aria-hidden className="text-ink-muted">→</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            aria-label="to date"
            title="To date"
            min={from || undefined}
            className="flex-1 min-w-0 text-[11px] px-1.5 py-0.5 rounded border border-line bg-bg text-ink focus:outline-none focus:border-brand"
          />
        </div>

        <div className="flex items-center justify-between gap-1 shrink-0 text-[11px] text-ink-muted">
          <span>
            {filtersActive
              ? `${filteredActivities.length} matching`
              : `${filteredActivities.length} events`}
            {filtersActive && (
              <button onClick={clearFilters} className="ml-1.5 text-brand hover:underline">
                Clear
              </button>
            )}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={expandAll}
              title="Expand all days"
              aria-label="expand all days"
              className="p-1 rounded hover:bg-bg text-ink-muted hover:text-ink"
            >
              <ChevronsUpDown size={12} />
            </button>
            <button
              onClick={collapseAll}
              title="Collapse all days (today stays open)"
              aria-label="collapse all days"
              className="p-1 rounded hover:bg-bg text-ink-muted hover:text-ink"
            >
              <ChevronsDownUp size={12} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 border-t border-line">
          {dayGroups.length === 0 ? (
            <Empty>
              {filtersActive ? 'No events match the filters.' : 'No activity yet — create or edit a note.'}
            </Empty>
          ) : (
            <div className="flex flex-col py-2">
              {dayGroups.map(([key, events]) => {
                const open = isOpen(key);
                const Chev = open ? ChevronDown : ChevronRight;
                return (
                  <section key={key} className="min-w-0">
                    <button
                      onClick={() => toggleDay(key)}
                      className="w-full flex items-center gap-1 px-1 py-1 text-[11px] text-ink-muted hover:text-ink"
                    >
                      <Chev size={11} className="shrink-0" />
                      <span className="font-medium text-ink truncate">{labelForDay(key)}</span>
                      <span className="shrink-0">· {events.length}</span>
                    </button>
                    {open && (
                      <div className="pl-3 flex flex-col">
                        {events.map((a, i) => (
                          <button
                            key={`${a.note.id}-${i}`}
                            onClick={() => openNote(a.note.id)}
                            title={`${a.kind === 'created' ? 'Created' : 'Edited'} ${a.at.toLocaleString()}`}
                            className="flex items-center gap-1.5 px-1 py-0.5 text-xs rounded hover:bg-bg text-ink min-w-0"
                          >
                            <span className="font-mono text-[10px] text-ink-muted shrink-0">
                              {formatTime(a.at)}
                            </span>
                            {a.kind === 'created' ? (
                              <FilePlus size={11} className="text-emerald-400 shrink-0" />
                            ) : (
                              <Pencil size={11} className="text-brand shrink-0" />
                            )}
                            <span className="flex-1 min-w-0 truncate text-left">{a.note.title}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
              <div className="px-2 py-2 text-[10px] text-ink-muted flex items-center gap-1 border-t border-line mt-2">
                <Clock size={10} className="shrink-0" />
                Derived from note timestamps. Folder &amp; bulk events arrive once we ship the audit log.
              </div>
            </div>
          )}
        </div>
      </div>
    </ViewShell>
  );
}
