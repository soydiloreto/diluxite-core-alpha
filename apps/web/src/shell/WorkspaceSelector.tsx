import { useEffect, useMemo, useRef, useState } from 'react';
import type { Space } from '../api';
import { Folder, ChevronDown, CheckIcon, Search } from '../icons';

/**
 * Compact workspace dropdown rendered in the TopBar. Lists every workspace
 * the user can access (across orgs) and switches the active one on select.
 * Click-outside / Escape closes the menu.
 *
 * Scales to "the user has hundreds of workspaces": an inline filter input
 * appears when the list has more than `FILTER_THRESHOLD` items, and the
 * list itself is capped at `RENDER_CAP` rendered items at once (extra ones
 * are hinted with a "+N más" footer). Both numbers are picked
 * conservatively for alpha; if real-world usage shows pain we can swap
 * the render path to react-virtuoso behind the same component contract.
 */
const FILTER_THRESHOLD = 12;
const RENDER_CAP = 200;

export function WorkspaceSelector({
  workspaces,
  activeId,
  onPick,
  onManage,
}: {
  workspaces: Space[];
  activeId: string | null;
  onPick: (spaceId: string) => void;
  onManage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Reset the filter when closing so reopen doesn't leak stale state, and
  // focus the filter input on open if we're past the threshold (mouse +
  // keyboard converge).
  useEffect(() => {
    if (!open) {
      setFilter('');
      return;
    }
    if (workspaces.length > FILTER_THRESHOLD) {
      queueMicrotask(() => filterRef.current?.focus());
    }
  }, [open, workspaces.length]);

  const active = workspaces.find((w) => w.id === activeId) ?? null;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter((w) => w.name.toLowerCase().includes(q));
  }, [workspaces, filter]);

  const shown = filtered.slice(0, RENDER_CAP);
  const overflow = filtered.length - shown.length;

  return (
    <div ref={ref} className="relative" data-testid="workspace-selector">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="workspace selector"
        className="flex items-center gap-1.5 h-7 px-2 rounded border border-line bg-bg hover:border-brand/40 text-xs text-ink"
      >
        <Folder size={12} className="text-ink-muted" />
        <span className="max-w-[180px] truncate">{active?.name ?? 'No workspace'}</span>
        <ChevronDown size={12} className="text-ink-muted" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 min-w-[240px] max-w-[320px] rounded-md border border-line bg-bg-surface shadow-2xl z-30 overflow-hidden"
        >
          <div className="text-[10px] uppercase tracking-wider text-ink-muted px-3 pt-2 pb-1">
            Workspaces ({workspaces.length})
          </div>
          {workspaces.length > FILTER_THRESHOLD && (
            <div className="px-2 pb-1">
              <div className="flex items-center gap-1.5 h-7 px-2 rounded border border-line bg-bg">
                <Search size={11} className="text-ink-muted shrink-0" />
                <input
                  ref={filterRef}
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter…"
                  aria-label="filter workspaces"
                  className="flex-1 min-w-0 bg-transparent text-xs outline-none text-ink placeholder:text-ink-muted"
                />
              </div>
            </div>
          )}
          <ul className="max-h-[60vh] overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-ink-muted">
                {workspaces.length === 0 ? 'No workspaces yet.' : 'No matches.'}
              </li>
            )}
            {shown.map((w) => (
              <li key={w.id}>
                <button
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onPick(w.id);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left ${
                    w.id === activeId ? 'bg-brand/10 text-ink' : 'text-ink hover:bg-bg'
                  }`}
                >
                  <Folder size={12} className="text-ink-muted shrink-0" />
                  <span className="flex-1 truncate">{w.name}</span>
                  {w.id === activeId && <CheckIcon size={12} className="text-brand" />}
                </button>
              </li>
            ))}
            {overflow > 0 && (
              <li
                className="px-3 py-1.5 text-[11px] text-ink-muted italic"
                data-testid="overflow-hint"
              >
                +{overflow} más — refiná el filtro para encontrarlas.
              </li>
            )}
          </ul>
          {onManage && (
            <button
              onClick={() => {
                setOpen(false);
                onManage();
              }}
              className="w-full text-left text-[11px] text-ink-muted hover:text-ink hover:bg-bg px-3 py-2 border-t border-line"
            >
              Manage workspaces…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
