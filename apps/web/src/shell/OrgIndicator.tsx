import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrganizationWithRole } from '../api';
import { Building2, CheckIcon, ChevronDown, Plus, Search } from '../icons';

const FILTER_THRESHOLD = 12;
const RENDER_CAP = 200;

const ROLE_LABEL: Record<OrganizationWithRole['role'], string> = {
  super_admin: 'super admin',
  admin: 'admin',
  member: 'member',
};

/**
 * Right-aligned org indicator + switcher in the TopBar.
 *
 *  - Local mode, single org: compact read-only chip (icon + name + role).
 *  - Multi-org users OR server mode: chip becomes a button. The dropdown
 *    lists every org (with the active one highlighted) and, in server mode,
 *    a "+ New organization" footer that opens the create dialog. The chosen
 *    org is what every other UI piece (workspace selector, admin console)
 *    scopes itself to.
 *
 * The chip is sized so it sits comfortably next to the notifications bell.
 */
export function OrgIndicator({
  orgs,
  currentOrgId,
  authMode,
  onPick,
  onCreate,
}: {
  orgs: OrganizationWithRole[];
  currentOrgId: string | null;
  authMode: 'local' | 'server';
  onPick: (orgId: string) => void;
  onCreate?: () => void;
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

  useEffect(() => {
    if (!open) {
      setFilter('');
      return;
    }
    if (orgs.length > FILTER_THRESHOLD) {
      queueMicrotask(() => filterRef.current?.focus());
    }
  }, [open, orgs.length]);

  if (orgs.length === 0) return null;
  const current = orgs.find((o) => o.id === currentOrgId) ?? orgs[0];

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return orgs;
    return orgs.filter((o) => o.name.toLowerCase().includes(q));
  }, [orgs, filter]);
  const shownOrgs = filtered.slice(0, RENDER_CAP);
  const overflowOrgs = filtered.length - shownOrgs.length;
  const canCreate = authMode === 'server' && !!onCreate;
  // The dropdown is interactive when there's something to do: pick another
  // org or create a new one. Local single-org users stay with the read-only chip.
  const interactive = orgs.length > 1 || canCreate;

  const chipBase =
    'h-7 px-2 flex items-center gap-1.5 rounded border border-line bg-bg text-xs';
  return (
    <div ref={ref} className="relative" data-testid="org-indicator">
      <button
        type="button"
        onClick={() => interactive && setOpen((v) => !v)}
        aria-haspopup={interactive ? 'menu' : undefined}
        aria-expanded={interactive ? open : undefined}
        aria-label="organization"
        title={`You are ${ROLE_LABEL[current.role]} of ${current.name}`}
        disabled={!interactive}
        className={`${chipBase} ${
          interactive ? 'hover:border-brand/40 text-ink' : 'text-ink cursor-default opacity-90'
        }`}
      >
        <Building2 size={12} className="text-brand shrink-0" />
        <span className="max-w-[140px] truncate font-medium">{current.name}</span>
        <span className="text-[10px] text-ink-muted uppercase tracking-wide hidden sm:inline">
          {ROLE_LABEL[current.role]}
        </span>
        {interactive && <ChevronDown size={12} className="text-ink-muted" />}
      </button>
      {open && interactive && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 min-w-[240px] max-w-[320px] rounded-md border border-line bg-bg-surface shadow-2xl z-30 overflow-hidden"
        >
          {orgs.length > 1 && (
            <>
              <div className="text-[10px] uppercase tracking-wider text-ink-muted px-3 pt-2 pb-1">
                Switch organization ({orgs.length})
              </div>
              {orgs.length > FILTER_THRESHOLD && (
                <div className="px-2 pb-1">
                  <div className="flex items-center gap-1.5 h-7 px-2 rounded border border-line bg-bg">
                    <Search size={11} className="text-ink-muted shrink-0" />
                    <input
                      ref={filterRef}
                      type="text"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Filter…"
                      aria-label="filter organizations"
                      className="flex-1 min-w-0 bg-transparent text-xs outline-none text-ink placeholder:text-ink-muted"
                    />
                  </div>
                </div>
              )}
              <ul className="max-h-[60vh] overflow-y-auto py-1">
                {filtered.length === 0 && (
                  <li className="px-3 py-2 text-xs text-ink-muted">No matches.</li>
                )}
                {shownOrgs.map((o) => (
                  <li key={o.id}>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setOpen(false);
                        onPick(o.id);
                      }}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left ${
                        o.id === current.id ? 'bg-brand/10 text-ink' : 'text-ink hover:bg-bg'
                      }`}
                    >
                      <Building2 size={12} className="text-ink-muted shrink-0" />
                      <span className="flex-1 truncate">{o.name}</span>
                      <span className="text-[10px] text-ink-muted uppercase tracking-wide">
                        {ROLE_LABEL[o.role]}
                      </span>
                      {o.id === current.id && <CheckIcon size={12} className="text-brand" />}
                    </button>
                  </li>
                ))}
                {overflowOrgs > 0 && (
                  <li
                    className="px-3 py-1.5 text-[11px] text-ink-muted italic"
                    data-testid="overflow-hint"
                  >
                    +{overflowOrgs} más — refiná el filtro para encontrarlas.
                  </li>
                )}
              </ul>
            </>
          )}
          {canCreate && (
            <div className={orgs.length > 1 ? 'border-t border-line' : ''}>
              <button
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onCreate?.();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-ink hover:bg-bg"
                data-testid="org-indicator-create"
              >
                <Plus size={12} className="text-brand shrink-0" />
                <span className="flex-1">New organization</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
