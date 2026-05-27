import { Button } from '../ui';
import { useT } from '../i18n';
import { Database, Menu, Network, Plus, Search, Settings } from '../icons';

/**
 * VS Code-like title/menu bar:
 *  - Hamburger (mobile only) to open the sidebar drawer.
 *  - Brand (Database icon + "Diluxite") that returns home.
 *  - Centered command-palette trigger with ⌘K hint.
 *  - Tight icon buttons on the right: graph, new note, settings.
 * Heights, padding and icon sizes are deliberately uniform.
 */
export function TopBar({
  onHome,
  onNew,
  onQuick,
  onGraph,
  onSettings,
  onToggleDock,
}: {
  onHome: () => void;
  onNew: () => void;
  onQuick: () => void;
  onGraph: () => void;
  onSettings: () => void;
  onToggleDock: () => void;
}) {
  const t = useT();
  return (
    <header
      data-testid="topbar"
      className="h-10 px-2 flex items-center gap-1 border-b border-line bg-bg-surface shrink-0 text-sm"
    >
      <IconBtn aria-label="toggle sidebar" title="Show / hide sidebar" onClick={onToggleDock} mdHidden>
        <Menu size={16} />
      </IconBtn>

      <button
        onClick={onHome}
        className="flex items-center gap-2 px-2 h-8 rounded hover:bg-bg shrink-0 text-ink"
        title="Diluxite — home"
      >
        <Database size={16} className="text-brand" />
        <span className="font-medium hidden sm:inline">Diluxite</span>
      </button>

      {/* Command palette trigger (estilo VS Code) */}
      <button
        onClick={onQuick}
        aria-label="Search"
        className="flex-1 max-w-xl mx-2 h-7 px-2 flex items-center gap-2 rounded border border-line bg-bg text-ink-muted hover:text-ink hover:border-brand/40 transition-colors"
      >
        <Search size={14} />
        <span className="flex-1 text-left text-xs">{t('topbar.search')}</span>
        <kbd className="hidden sm:inline text-[10px] px-1 py-0.5 rounded bg-bg-surface border border-line text-ink-muted">
          Ctrl K
        </kbd>
      </button>

      <IconBtn aria-label="graph" title={t('topbar.graph')} onClick={onGraph}>
        <Network size={16} />
      </IconBtn>
      <Button size="sm" onClick={onNew} title={t('topbar.newNote')}>
        <Plus size={14} />
        <span className="hidden sm:inline">{t('topbar.newNote').replace('+ ', '')}</span>
      </Button>
      <IconBtn aria-label="settings" title={t('topbar.settings')} onClick={onSettings}>
        <Settings size={16} />
      </IconBtn>
    </header>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  mdHidden,
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
  mdHidden?: boolean;
  ['aria-label']: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={rest['aria-label']}
      className={`w-8 h-8 inline-flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-bg ${
        mdHidden ? 'md:hidden' : ''
      }`}
    >
      {children}
    </button>
  );
}
