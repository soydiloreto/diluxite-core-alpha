import { useEffect, useRef, useState } from 'react';
import {
  Clock,
  Database,
  Folder,
  Network,
  Plus,
  Search,
  Settings,
  Star,
  User,
} from '../icons';

export type ActivityView =
  | 'explorer'
  | 'graph'
  | 'favorites'
  | 'recent'
  | 'search'
  | 'settings';

/**
 * Vertical Activity Bar (the VS Code spine on the far left).
 *
 * Layout, top → bottom:
 *  - Brand mark (returns to home).
 *  - Explorer (folders + notes tree).
 *  - Search → in-sidebar find & replace across all notes.
 *  - Graph view.
 *  - Favorites · Recent (sidebar swaps to show each).
 *  - + New note.
 *  - (spacer)
 *  - User account button.
 *  - Settings (gear).
 *
 * Each button is a 40-px square with a thin left brand-coloured indicator
 * for the active view (matches VS Code's "highlighted activity" pattern).
 */
export function ActivityBar({
  active,
  user,
  workspaceLabel,
  sidebarOpen,
  onToggleSidebar,
  onHome,
  onGraph,
  onView,
  onNew,
  onSettings,
  onAccount,
}: {
  active: ActivityView | null;
  user: { email: string } | null;
  workspaceLabel: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onHome: () => void;
  onGraph: () => void;
  onView: (v: 'favorites' | 'recent' | 'search') => void;
  onNew: () => void;
  onSettings: () => void;
  onAccount: (tab: 'about' | 'space') => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Click outside closes the account popover.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  return (
    <div
      data-testid="activity-bar"
      className="w-12 shrink-0 h-full flex flex-col items-center bg-bg-surface border-r border-line relative z-10"
    >
      <ActButton title="Diluxite — home" label="home" onClick={onHome}>
        <Database size={20} className="text-brand" />
      </ActButton>

      <Divider />

      <ActButton
        title="Explorer (folders + notes)"
        label="explorer"
        onClick={onToggleSidebar}
        active={sidebarOpen && active === 'explorer'}
      >
        <Folder size={20} />
      </ActButton>
      <ActButton
        title="Search & replace across all notes"
        label="search"
        onClick={() => onView('search')}
        active={active === 'search'}
      >
        <Search size={20} />
      </ActButton>
      <ActButton
        title="Graph view"
        label="graph"
        onClick={onGraph}
        active={active === 'graph'}
      >
        <Network size={20} />
      </ActButton>

      <Divider />

      <ActButton
        title="Favorites"
        label="favorites"
        onClick={() => onView('favorites')}
        active={active === 'favorites'}
      >
        <Star size={20} />
      </ActButton>
      <ActButton
        title="Recent notes"
        label="recent"
        onClick={() => onView('recent')}
        active={active === 'recent'}
      >
        <Clock size={20} />
      </ActButton>

      <Divider />

      <ActButton title="New note" label="new note" onClick={onNew}>
        <Plus size={20} />
      </ActButton>

      <div className="flex-1" />

      <div ref={ref} className="relative w-full flex justify-center">
        <ActButton
          title={user?.email ?? 'Account'}
          label="account"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <div className="w-6 h-6 rounded-full bg-brand-soft text-brand flex items-center justify-center text-[11px] font-medium border border-brand/40">
            {(user?.email ?? 'L').slice(0, 1).toUpperCase()}
          </div>
        </ActButton>
        {menuOpen && (
          <div
            role="menu"
            data-testid="account-menu"
            className="absolute left-12 bottom-0 w-72 rounded-md border border-line bg-bg-surface shadow-2xl p-3 flex flex-col gap-2 text-sm"
          >
            <div className="flex items-center gap-2 pb-2 border-b border-line">
              <div className="w-8 h-8 rounded-full bg-brand-soft text-brand flex items-center justify-center border border-brand/40">
                <User size={16} />
              </div>
              <div className="min-w-0">
                <div className="font-medium truncate text-ink">{user?.email ?? 'admin local'}</div>
                <div className="text-[11px] text-ink-muted">Local single-user mode</div>
              </div>
            </div>
            <button
              onClick={() => {
                setMenuOpen(false);
                onAccount('space');
              }}
              className="text-left px-2 py-1.5 rounded hover:bg-bg flex items-center gap-2 text-ink"
            >
              <Folder size={14} className="text-ink-muted" />
              <span className="flex-1 truncate">{workspaceLabel}</span>
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                onAccount('about');
              }}
              className="text-left px-2 py-1.5 rounded hover:bg-bg flex items-center gap-2 text-ink"
            >
              <Settings size={14} className="text-ink-muted" />
              Account details
            </button>
            <button
              disabled
              className="text-left px-2 py-1.5 rounded text-ink-muted cursor-not-allowed"
              title="Sign-out is available once Cloud / passkey auth is enabled"
            >
              Sign out (disabled)
            </button>
          </div>
        )}
      </div>

      <ActButton
        title="Settings"
        label="settings"
        onClick={onSettings}
        active={active === 'settings'}
      >
        <Settings size={20} />
      </ActButton>
    </div>
  );
}

function ActButton({
  children,
  onClick,
  title,
  label,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      className={`w-12 h-10 inline-flex items-center justify-center relative ${
        active ? 'text-ink' : 'text-ink-muted hover:text-ink'
      }`}
    >
      {/* Brand stripe on the left when active (VS Code pattern). */}
      {active && <span aria-hidden className="absolute left-0 top-1 bottom-1 w-0.5 bg-brand rounded-r" />}
      {children}
    </button>
  );
}

function Divider() {
  return <div className="w-6 h-px bg-line my-1" />;
}
