import { useEffect, useState } from 'react';
import type { ApiClient, Stats } from '../../api';
import { useApp } from '../AppContext';
import { Button } from '../../ui';

/**
 * Admin → Current workspace — stats + export del workspace activo (`spaceId`
 * del AppContext). Si no hay workspace seleccionado, muestra placeholder.
 *
 * El export descarga un JSON con todas las notas del workspace. Conceptualmente
 * es operación admin (no preferencia del user), por eso vive acá y no en
 * Settings del modal.
 */
export function CurrentWorkspaceTab() {
  const { api, spaceId } = useApp();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    if (!spaceId) return;
    let cancelled = false;
    api
      .stats(spaceId)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      // Non-critical stats — render falls back to zeros; don't leak an
      // unhandled rejection (and ignore a stale response after a space switch).
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, spaceId]);

  async function exportNotes() {
    if (!spaceId) return;
    const notes = await (api as ApiClient).listNotes(spaceId);
    const blob = new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'diluxite-export.json';
    a.click();
  }

  if (!spaceId) {
    return (
      <div data-testid="admin-current-workspace-tab" className="max-w-xl">
        <h2 className="text-lg font-semibold mb-2">Current workspace</h2>
        <p className="text-sm text-ink-muted">
          No workspace selected. Open one from the explorer to see its stats here.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="admin-current-workspace-tab" className="flex flex-col gap-4 max-w-xl">
      <header>
        <h2 className="text-lg font-semibold">Current workspace</h2>
        <p className="text-xs text-ink-muted mt-1">
          Stats e export del workspace activo. Para gestionar todos los workspaces
          de la organización, ir a la sección <strong>Workspaces</strong>.
        </p>
      </header>

      <section className="rounded border border-line bg-bg-surface p-4">
        <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-2">Stats</div>
        <p className="text-sm text-ink" data-testid="space-stats">
          {stats?.notes ?? 0} notas · {stats?.tags ?? 0} tags · {stats?.links ?? 0} links
        </p>
      </section>

      <div>
        <Button data-testid="space-export" onClick={exportNotes}>
          Export workspace as JSON
        </Button>
      </div>
    </div>
  );
}
