import { Button, IconButton } from '../ui';
import { useT } from '../i18n';

export function TopBar({
  onHome,
  onNew,
  onQuick,
  onGraph,
  onSettings,
}: {
  onHome: () => void;
  onNew: () => void;
  onQuick: () => void;
  onGraph: () => void;
  onSettings: () => void;
}) {
  const t = useT();
  return (
    <header
      data-testid="topbar"
      className="h-12 px-4 flex items-center gap-3 border-b border-line bg-bg-surface shrink-0"
    >
      <button
        onClick={onHome}
        className="flex items-center gap-2 text-ink hover:opacity-80"
        title="Diluxite"
      >
        <span className="text-xl leading-none">🪨</span>
        <span className="text-base font-semibold">Diluxite</span>
      </button>
      <span className="flex-1" />
      <Button size="sm" variant="secondary" onClick={onQuick} title="Quick switcher (Ctrl/Cmd+K)">
        {t('topbar.search')}
      </Button>
      <Button size="sm" variant="secondary" onClick={onGraph} title="Open graph">
        {t('topbar.graph')}
      </Button>
      <Button size="sm" onClick={onNew}>
        {t('topbar.newNote')}
      </Button>
      <IconButton aria-label="settings" title={t('topbar.settings')} onClick={onSettings}>
        ⚙
      </IconButton>
    </header>
  );
}
