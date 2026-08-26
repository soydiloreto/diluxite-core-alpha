import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from 'dockview-react';
import { useContextMenu } from '../ui';

/**
 * Dockview default tab + right-click context menu (VS Code parity). Common
 * actions on a tab strip: close one, close others, close to the right, close
 * all. Wraps DockviewDefaultTab so we keep the official styling / close
 * button / middle-click handling and only add the menu on top.
 */
export function CustomTab(props: IDockviewPanelHeaderProps) {
  const menu = useContextMenu();
  function onContextMenu(e: React.MouseEvent) {
    const all = props.api.group.panels;
    const idx = all.findIndex((p) => p.id === props.api.id);
    if (idx < 0) return;
    menu.open(e, [
      { label: 'Close', onSelect: () => props.api.close() },
      {
        label: 'Close Others',
        disabled: all.length < 2,
        onSelect: () => {
          for (const p of [...all]) if (p.id !== props.api.id) p.api.close();
        },
      },
      {
        label: 'Close to the Right',
        disabled: idx >= all.length - 1,
        onSelect: () => {
          for (const p of all.slice(idx + 1)) p.api.close();
        },
      },
      'separator',
      {
        label: 'Close All',
        onSelect: () => {
          for (const p of [...all]) p.api.close();
        },
      },
    ]);
  }
  return (
    // Stamp the dockview panel id on the tab so document-level handlers (e.g.
    // middle-click-to-close in App) can resolve the exact panel. Titles aren't
    // unique across notes, so resolving by id is the only safe way.
    <div onContextMenu={onContextMenu} className="contents" data-panel-id={props.api.id}>
      <DockviewDefaultTab {...props} />
      <menu.Menu />
    </div>
  );
}
