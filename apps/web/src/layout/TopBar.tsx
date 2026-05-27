import { Button, IconButton } from '../ui';
import { useT } from '../i18n';

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
      className="h-12 px-3 flex items-center gap-2 border-b border-line bg-bg-surface shrink-0"
    >
      <IconButton
        aria-label="toggle sidebar"
        title="Show / hide sidebar"
        onClick={onToggleDock}
        className="md:hidden"
      >
        ≡
      </IconButton>
      <button
        onClick={onHome}
        className="flex items-center gap-2 text-ink hover:opacity-80 shrink-0"
        title="Diluxite"
      >
        <span className="text-xl leading-none">🪨</span>
        <span className="text-base font-semibold hidden sm:inline">Diluxite</span>
      </button>

      {/* Command palette / search trigger (estilo VS Code) */}
      <button
        onClick={onQuick}
        aria-label="Search"
        className="flex-1 max-w-2xl mx-2 h-8 px-3 flex items-center gap-2 rounded-md border border-line bg-bg text-sm text-ink-muted hover:text-ink hover:bg-bg-surface transition-colors"
      >
        <span className="text-base">🔎</span>
        <span className="flex-1 text-left">{t('topbar.search')}</span>
        <kbd className="hidden sm:inline text-[10px] px-1.5 py-0.5 rounded bg-bg-surface border border-line">
          Ctrl K
        </kbd>
      </button>

      <Button size="sm" variant="secondary" onClick={onGraph} title="Open graph" className="hidden sm:inline-flex">
        {t('topbar.graph')}
      </Button>
      <Button size="sm" onClick={onNew}>
        <span className="hidden sm:inline">{t('topbar.newNote')}</span>
        <span className="sm:hidden">+</span>
      </Button>
      <IconButton aria-label="settings" title={t('topbar.settings')} onClick={onSettings}>
        ⚙
      </IconButton>
    </header>
  );
}
