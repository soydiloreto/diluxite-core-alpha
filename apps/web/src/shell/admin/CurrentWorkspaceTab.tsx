import { useEffect, useState } from 'react';
import type { Stats } from '../../api';
import { useApp } from '../AppContext';
import { Button } from '../../ui';

/**
 * Admin → Current workspace — stats + export del workspace activo (`spaceId`
 * del AppContext). Si no hay workspace seleccionado, muestra placeholder.
 *
 * Es operación admin (no preferencia del user), por eso vive acá y no en
 * Settings del modal.
 *
 * El export baja un ZIP de Markdown: cada nota como archivo, en su carpeta,
 * con el cuerpo tal cual — wikilinks y `#tags` incluidos — y la metadata que
 * el cuerpo no puede llevar en frontmatter YAML. Obsidian, VS Code y `grep`
 * lo leen sin importador. Antes bajaba un JSON de los objetos de la API
 * armado en el browser: una forma que solo entiende Diluxite, y que además
 * tenía que entrar en la memoria de una pestaña.
 */
export function CurrentWorkspaceTab() {
  const { api, spaceId } = useApp();
  const [stats, setStats] = useState<Stats | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    setExporting(true);
    try {
      const { blob, filename } = await api.exportZip(spaceId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      // Without this the blob stays alive for the life of the document — a
      // whole workspace held in memory after the download already happened.
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
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

      <div className="flex flex-col gap-2">
        <Button data-testid="space-export" onClick={() => void exportNotes()} disabled={exporting}>
          {exporting ? 'Preparing…' : 'Export workspace as Markdown (.zip)'}
        </Button>
        <p className="text-xs text-ink-muted">
          One <code>.md</code> per note, in its folder, with the body untouched. Trashed notes stay
          in Trash.
        </p>
        {error && (
          <p role="alert" className="text-xs text-danger-ink">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
