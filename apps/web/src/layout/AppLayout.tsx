import type { ReactNode } from 'react';
import { StatusBar } from '../ui';

/**
 * App shell (Obsidian-style):
 *   topbar    — brand + global actions
 *   leftDock  — navigation (notes tree, tags, recents, favorites)
 *   main      — active view (Editor / Graph / EmptyState)
 *   status    — bottom bar (settings, MCP, space, user)
 */
export function AppLayout({
  topBar,
  leftDock,
  main,
  status,
  modals,
}: {
  topBar?: ReactNode;
  leftDock: ReactNode;
  main: ReactNode;
  status: ReactNode;
  modals?: ReactNode;
}) {
  return (
    <div className="h-full flex flex-col bg-bg text-ink">
      {topBar}
      <div className="flex-1 min-h-0 flex">
        <aside
          data-testid="left-dock"
          className="w-72 shrink-0 border-r border-line bg-bg-surface overflow-y-auto p-3 flex flex-col gap-3"
        >
          {leftDock}
        </aside>
        <main data-testid="main" className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {main}
        </main>
      </div>
      <StatusBar>{status}</StatusBar>
      {modals}
    </div>
  );
}
