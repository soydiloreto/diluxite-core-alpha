import type { ReactNode } from 'react';
import { StatusBar } from '../ui';

/**
 * Shell de la aplicación (estilo Obsidian):
 * - aside izquierdo: navegación (LeftDock)
 * - main central: vista activa (Editor/Grafo/Vacío)
 * - status bar inferior: ⚙ + MCP + espacio + usuario
 * - modales superpuestos
 */
export function AppLayout({
  leftDock,
  main,
  status,
  modals,
}: {
  leftDock: ReactNode;
  main: ReactNode;
  status: ReactNode;
  modals?: ReactNode;
}) {
  return (
    <div className="h-full flex flex-col bg-bg text-ink">
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
