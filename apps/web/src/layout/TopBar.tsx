import { Button, IconButton } from '../ui';

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
        ⌘K Search
      </Button>
      <Button size="sm" variant="secondary" onClick={onGraph} title="Open graph">
        🕸 Graph
      </Button>
      <Button size="sm" onClick={onNew}>
        + New note
      </Button>
      <IconButton aria-label="settings" title="Settings" onClick={onSettings}>
        ⚙
      </IconButton>
    </header>
  );
}
