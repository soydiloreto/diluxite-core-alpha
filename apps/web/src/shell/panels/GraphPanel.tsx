import type { IDockviewPanelProps } from 'dockview-react';
import { useApp } from '../AppContext';
import { GraphView } from '../../components/GraphView';

export function GraphPanel(_props: IDockviewPanelProps) {
  const { api, spaceId, openNote } = useApp();
  return (
    <div className="h-full bg-bg">
      <GraphView api={api} spaceId={spaceId} onOpen={openNote} />
    </div>
  );
}
