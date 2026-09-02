import { useEffect, useRef, useState } from 'react';
import {
  Clock,
  Database,
  Folder,
  Info,
  Network,
  Plus,
  Search,
  Settings,
  Shield,
  Star,
  Trash2,
  Archive,
  CheckIcon,
  User,
} from '../icons';

export type ActivityView =
  | 'explorer'
  | 'graph'
  | 'favorites'
  | 'recent'
  | 'search'
  | 'trash'
  | 'archive'
  | 'review'
  | 'admin'
  | 'settings';

/**
 * Vertical Activity Bar (the VS Code spine on the far left).
 *
 * Layout, top → bottom:
 *  - Brand mark (returns to home).
 *  - Explorer (folders + notes tree).
 *  - Search → in-sidebar find & replace across all notes.
 *  - Graph view.
 *  - Favorites · Recent · Archive · Trash (sidebar swaps to show each).
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
  channel,
  sidebarOpen,
  showAdmin,
  onToggleSidebar,
  onHome,
  onGraph,
  onView,
  onNew,
  onAdmin,
  onSettings,
  onAccount,
}: {
  active: ActivityView | null;
  user: { email: string } | null;
  /** Release channel inferred from the running version (`next` if pre-release). */
  channel: 'next' | 'latest' | null;
  sidebarOpen: boolean;
  /** Render the Admin button (true when the user is org admin / org_admin somewhere). */
  showAdmin: boolean;
  onToggleSidebar: () => void;
  onHome: () => void;
  onGraph: () => void;
  onView: (v: 'favorites' | 'recent' | 'search' | 'trash' | 'archive' | 'review') => void;
  onNew: () => void;
  onAdmin: () => void;
  onSettings: () => void;
  /** Open the SettingsModal at a specific tab. Used from the avatar popover. */
  onAccount: (tab: 'about' | 'appearance' | 'editor' | 'mcp' | 'security') => void;
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
      <ActButton
        title="Review (confirm what the memory leans on)"
        label="review"
        onClick={() => onView('review')}
        active={active === 'review'}
      >
        <CheckIcon size={20} />
      </ActButton>
      <ActButton
        title="Archive (out of the tree, still searchable)"
        label="archive"
        onClick={() => onView('archive')}
        active={active === 'archive'}
      >
        <Archive size={20} />
      </ActButton>
      <ActButton
        title="Trash (recently deleted)"
        label="trash"
        onClick={() => onView('trash')}
        active={active === 'trash'}
      >
        <Trash2 size={20} />
      </ActButton>

      <Divider />

      <ActButton title="New note" label="new note" onClick={onNew}>
        <Plus size={20} />
      </ActButton>

      <div className="flex-1" />

      {showAdmin && (
        <ActButton
          title="Admin console (organization + members + workspaces)"
          label="admin"
          onClick={onAdmin}
          active={active === 'admin'}
        >
          <Shield size={20} />
        </ActButton>
      )}

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
            {/* Single Settings entry. The previous version exposed six
                near-identical buttons here (one per modal tab) which felt
                duplicated to users and made the popover noisy. The deep-link
                to specific tabs (e.g. `openSettings('mcp')`) still works
                from contextual surfaces — Welcome panel, ActivityBar gear
                button — where the user already knows what they want. */}
            <div className="border-t border-line my-1" />
            <button
              data-testid="account-menu-settings"
              onClick={() => {
                setMenuOpen(false);
                onSettings();
              }}
              className="text-left px-2 py-1.5 rounded hover:bg-bg flex items-center gap-2 text-ink"
            >
              <Settings size={14} className="text-ink-muted" />
              Settings
            </button>
            <button
              data-testid="account-menu-about"
              onClick={() => {
                setMenuOpen(false);
                onAccount('about');
              }}
              className="text-left px-2 py-1.5 rounded hover:bg-bg flex items-center gap-2 text-ink"
            >
              <Info size={14} className="text-ink-muted" />
              <span className="flex-1">About</span>
              {channel && (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-brand-soft text-brand">
                  {channel}
                </span>
              )}
            </button>
            <div className="border-t border-line my-1" />

            <button
              disabled
              className="text-left px-2 py-1.5 rounded text-ink-muted cursor-not-allowed"
              title="Sign-out is available once server mode is enabled"
            >
              Sign out (disabled)
            </button>
          </div>
        )}
      </div>
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
