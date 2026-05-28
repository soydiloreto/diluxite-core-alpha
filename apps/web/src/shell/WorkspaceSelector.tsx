import { useEffect, useRef, useState } from 'react';
import type { Space } from '../api';
import { Folder, ChevronDown, CheckIcon } from '../icons';

/**
 * Compact workspace dropdown rendered in the TopBar. Lists every workspace
 * the user can access (across orgs) and switches the active one on select.
 * Click-outside / Escape closes the menu.
 */
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
  const ref = useRef<HTMLDivElement>(null);

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

  const active = workspaces.find((w) => w.id === activeId) ?? null;

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
          <ul className="max-h-[60vh] overflow-y-auto py-1">
            {workspaces.length === 0 && (
              <li className="px-3 py-2 text-xs text-ink-muted">No workspaces yet.</li>
            )}
            {workspaces.map((w) => (
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
