import { useEffect, useRef, type ReactNode } from 'react';
import { DockviewReact } from 'dockview-react';
import type { DockviewApi, DockviewReadyEvent, IDockviewPanelProps } from 'dockview-react';
import { NotePanel } from './panels/NotePanel';
import { WelcomePanel } from './panels/WelcomePanel';
import { GraphPanel } from './panels/GraphPanel';

/**
 * The editor area: a dockview grid of tabs and groups. The shell owns the
 * `DockviewApi` and exposes it via `onReady` so the parent can drive panel
 * creation imperatively (open note → addPanel, deleted → removePanel, etc.).
 *
 * Components are registered as Dockview "componentName" → React FC, with
 * params typed per panel. The dock handles drag-to-reorder, drag-to-split,
 * resize, and tab-close natively.
 */

// Dockview's `components` map expects each entry to be `FC<IDockviewPanelProps>`
// (i.e. params: any). Each panel narrows its own `params` shape internally;
// we cast on the way in so the registry stays a plain map.
const components: Record<string, React.FC<IDockviewPanelProps>> = {
  welcome: WelcomePanel as unknown as React.FC<IDockviewPanelProps>,
  note: NotePanel as unknown as React.FC<IDockviewPanelProps>,
  graph: GraphPanel as unknown as React.FC<IDockviewPanelProps>,
};

export function DockShell({
  onReady,
  watermark,
}: {
  onReady: (api: DockviewApi) => void;
  watermark?: ReactNode;
}) {
  const wmRef = useRef(watermark);
  wmRef.current = watermark;

  useEffect(() => {
    // ensures we never have a stale closure on the ready handler
  }, [onReady]);

  return (
    <DockviewReact
      components={components}
      onReady={(e: DockviewReadyEvent) => onReady(e.api)}
      className="dockview-theme-abyss diluxite-dock"
    />
  );
}
