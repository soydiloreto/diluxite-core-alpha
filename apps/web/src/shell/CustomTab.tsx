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
        label: 'Close others',
        disabled: all.length < 2,
        onSelect: () => {
          for (const p of [...all]) if (p.id !== props.api.id) p.api.close();
        },
      },
      {
        label: 'Close to the right',
        disabled: idx >= all.length - 1,
        onSelect: () => {
          for (const p of all.slice(idx + 1)) p.api.close();
        },
      },
      'separator',
      {
        label: 'Close all',
        onSelect: () => {
          for (const p of [...all]) p.api.close();
        },
      },
    ]);
  }
  return (
    <div onContextMenu={onContextMenu} className="contents">
      <DockviewDefaultTab {...props} />
      <menu.Menu />
    </div>
  );
}
