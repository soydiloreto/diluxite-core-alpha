import { DockviewReact } from 'dockview-react';
import type { DockviewApi, DockviewReadyEvent, IDockviewPanelProps } from 'dockview-react';
import { NotePanel } from './panels/NotePanel';
import { WelcomePanel } from './panels/WelcomePanel';
import { GraphPanel } from './panels/GraphPanel';
import { CustomTab } from './CustomTab';

/**
 * Editor area: a Dockview grid of tabs / groups.
 *
 * Dockview's root element sizes to its parent. We deliberately wrap it in a
 * `absolute inset-0` container so the parent only has to be `relative` with a
 * defined size and the dock always fills exactly that box (no overflow into
 * the page, no 0-height collapse).
 */

const components: Record<string, React.FC<IDockviewPanelProps>> = {
  welcome: WelcomePanel as unknown as React.FC<IDockviewPanelProps>,
  note: NotePanel as unknown as React.FC<IDockviewPanelProps>,
  graph: GraphPanel as unknown as React.FC<IDockviewPanelProps>,
};

export function DockShell({ onReady }: { onReady: (api: DockviewApi) => void }) {
  return (
    <div className="absolute inset-0">
      <DockviewReact
        components={components}
        defaultTabComponent={CustomTab}
        onReady={(e: DockviewReadyEvent) => onReady(e.api)}
        className="dockview-theme-abyss diluxite-dock"
      />
    </div>
  );
}
