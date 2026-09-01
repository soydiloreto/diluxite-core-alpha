import { useEffect, useRef, useState } from 'react';
import type { Stats } from '../../api';
import { useApp } from '../AppContext';
import { Button, useDialogs } from '../../ui';

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
  const { api, spaceId, refreshAll } = useApp();
  const dialogs = useDialogs();
  const [stats, setStats] = useState<Stats | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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

  /**
   * The file, base64'd.
   *
   * Through `FileReader` rather than spreading the bytes into `String
   * .fromCharCode`: a vault of a few megabytes is a few million arguments,
   * and that throws a stack overflow on the file sizes this is FOR.
   */
  function toBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('could not read the file'));
      reader.onload = () => {
        const url = String(reader.result);
        resolve(url.slice(url.indexOf(',') + 1));
      };
      reader.readAsDataURL(file);
    });
  }

  async function importNotes(file: File) {
    if (!spaceId) return;
    setError(null);
    setImported(null);
    setImporting(true);
    try {
      const zipBase64 = await toBase64(file);
      // Dry run first, always. An import is the one operation where finding
      // out what it did afterwards is expensive, so the confirmation states
      // the real numbers rather than "are you sure?".
      const plan = await api.importZip(spaceId, zipBase64, { dryRun: true });
      const count = plan.notes?.length ?? 0;
      if (count === 0) {
        setError('No notes found in that file.');
        return;
      }
      const detail = [`${count} notes will be created (detected: ${plan.format}).`];
      if (plan.skipped.length > 0) {
        detail.push(`${plan.skipped.length} files will be skipped (attachments and settings).`);
      }
      detail.push('Nothing already here is overwritten: a title that exists is left alone.');
      const ok = await dialogs.confirm(`Import ${file.name}?`, {
        message: detail.join(' '),
        okLabel: 'Import',
      });
      if (!ok) return;
      const done = await api.importZip(spaceId, zipBase64);
      setImported(`${done.created ?? 0} notes imported · ${done.skipped.length} skipped`);
      await refreshAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
      // So picking the SAME file again still fires a change event.
      if (fileRef.current) fileRef.current.value = '';
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
        <input
          ref={fileRef}
          type="file"
          accept=".zip"
          className="hidden"
          data-testid="space-import-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importNotes(file);
          }}
        />
        <Button
          data-testid="space-import"
          onClick={() => fileRef.current?.click()}
          disabled={importing}
        >
          {importing ? 'Reading…' : 'Import a vault (.zip)'}
        </Button>
        <p className="text-xs text-ink-muted">
          Obsidian, Notion or any folder of Markdown. Folders become folders, wikilinks and{' '}
          <code>#tags</code> come across as they are. Attachments are not imported yet, and a note
          whose title already exists here is left untouched.
        </p>
        {imported && (
          <p className="text-xs text-ink" data-testid="space-import-result">
            {imported}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger-ink">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
