import { useEffect, useState, type ReactNode } from 'react';
import { StatusBar } from '../ui';

/**
 * App shell (VS Code style):
 *   topbar    — brand + command palette + actions (always visible)
 *   aside     — left dock (resizable on desktop, drawer on mobile)
 *   main      — active view (tabs + editor / graph / empty)
 *   status    — bottom bar
 */
export function AppLayout({
  topBar,
  leftDock,
  main,
  status,
  modals,
  sidebarWidth = 288,
  onResizeSidebar,
  mobileDockOpen,
  onCloseMobileDock,
}: {
  topBar?: ReactNode;
  leftDock: ReactNode;
  main: ReactNode;
  status: ReactNode;
  modals?: ReactNode;
  sidebarWidth?: number;
  onResizeSidebar?: (w: number) => void;
  mobileDockOpen?: boolean;
  onCloseMobileDock?: () => void;
}) {
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    if (!resizing) return;
    function onMove(e: MouseEvent) {
      const w = Math.max(200, Math.min(560, e.clientX));
      onResizeSidebar?.(w);
    }
    function onUp() {
      setResizing(false);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing, onResizeSidebar]);

  return (
    <div className="h-full flex flex-col bg-bg text-ink">
      {topBar}
      <div className="flex-1 min-h-0 flex relative">
        {mobileDockOpen && (
          <button
            aria-label="close drawer"
            onClick={onCloseMobileDock}
            className="fixed inset-0 z-20 bg-black/40 md:hidden"
          />
        )}
        <aside
          data-testid="left-dock"
          style={{ width: sidebarWidth }}
          className={`shrink-0 border-r border-line bg-bg-surface overflow-y-auto p-3
            ${mobileDockOpen ? 'fixed inset-y-0 left-0 z-30' : 'hidden md:block md:relative'}`}
        >
          {leftDock}
        </aside>
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            setResizing(true);
          }}
          className="hidden md:block absolute top-0 z-10 w-1.5 h-full cursor-col-resize hover:bg-brand/40 transition-colors"
          style={{ left: sidebarWidth - 3 }}
          aria-label="resize sidebar"
          role="separator"
          data-testid="sidebar-resize"
        />
        <main data-testid="main" className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {main}
        </main>
      </div>
      <StatusBar>{status}</StatusBar>
      {modals}
    </div>
  );
}
