import { useState, type ChangeEvent, type DragEvent } from 'react';
import type { ApiClient, CsvImportResult } from '../../api';
import { Button } from '../../ui';

/**
 * UI para bulk-importar usuarios desde un CSV. Flow:
 *
 *   1. Admin arrastra/elige un archivo (o pega contenido).
 *   2. Click "Preview" → server hace dry-run → tabla con rows + errors.
 *   3. Si OK, click "Apply" → server hace el upsert real, reporta counts.
 *
 * Diseñado para sentirse seguro: NUNCA aplica sin un dry-run antes. La
 * confirmación es explícita.
 */
export function UsersImportCsv({
  api,
  orgId,
  onImported,
}: {
  api: ApiClient;
  orgId: string;
  /** Notify the parent so the user list re-fetches after a successful apply. */
  onImported?: () => void;
}) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<CsvImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [appliedResult, setAppliedResult] = useState<CsvImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  async function readFile(file: File) {
    const text = await file.text();
    setCsv(text);
    setPreview(null);
    setAppliedResult(null);
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void readFile(file);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void readFile(file);
  }

  async function doPreview() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.importUsersCsv(orgId, csv, { dryRun: true });
      setPreview(r);
      setAppliedResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doApply() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.importUsersCsv(orgId, csv, { dryRun: false });
      setAppliedResult(r);
      onImported?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="users-import-csv" className="flex flex-col gap-3 max-w-3xl">
      <h3 className="text-lg font-semibold">Import users from CSV</h3>
      <p className="text-sm text-ink-muted">
        Upload a CSV with columns <code>email</code>, <code>first_name</code>,
        <code> last_name</code>, <code>role</code>. Only <code>email</code> is
        required. Existing users get patched; new ones are created with
        provider <code>csv_import</code>.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`border-2 border-dashed rounded-md p-4 text-center text-sm ${
          dragging ? 'border-brand bg-brand-soft/30' : 'border-line bg-bg'
        }`}
        data-testid="csv-dropzone"
      >
        {csv ? (
          <span className="text-ink-muted">
            Loaded {csv.length} chars. Drop another file to replace.
          </span>
        ) : (
          <span className="text-ink-muted">
            Drag your CSV here, or use the picker below
          </span>
        )}
      </div>
      <input
        type="file"
        accept=".csv,text/csv,text/plain"
        onChange={onPick}
        aria-label="csv file"
      />
      <textarea
        aria-label="csv text"
        placeholder="…or paste CSV content here"
        value={csv}
        onChange={(e) => {
          setCsv(e.target.value);
          // Editing the CSV invalidates any prior dry-run: clear the preview
          // (which hides Apply) + the applied result, forcing a re-Preview so
          // we never Apply content the server never dry-ran.
          setPreview(null);
          setAppliedResult(null);
        }}
        rows={6}
        className="font-mono text-xs border border-line rounded p-2 bg-bg text-ink"
      />

      <div className="flex gap-2">
        <Button onClick={doPreview} disabled={busy || !csv.trim()}>
          {busy ? 'Working…' : 'Preview'}
        </Button>
        {preview && !appliedResult && preview.rows.length > 0 && (
          <Button
            variant="primary"
            onClick={doApply}
            disabled={busy}
            data-testid="apply-import"
          >
            Apply ({preview.rows.length} rows)
          </Button>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2">
          {error}
        </p>
      )}

      {preview && (
        <section data-testid="preview-section" className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">
            Preview — separator <code>{preview.separator}</code> · {preview.rows.length} rows ·{' '}
            {preview.errors.length} errors
          </h4>
          {preview.errors.length > 0 && (
            <details
              data-testid="preview-errors"
              className="border border-red-500/30 bg-red-500/10 rounded p-2 text-xs"
            >
              <summary className="cursor-pointer">{preview.errors.length} parse errors — review them before applying</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {preview.errors.map((e, i) => (
                  <li key={i}>
                    <span className="font-mono text-ink-muted">L{e.line}</span>{' '}
                    {e.message} —{' '}
                    <span className="text-ink-muted">{e.raw}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {preview.rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border border-line">
                <thead className="bg-bg-surface">
                  <tr>
                    <th className="text-left px-2 py-1">Email</th>
                    <th className="text-left px-2 py-1">First name</th>
                    <th className="text-left px-2 py-1">Last name</th>
                    <th className="text-left px-2 py-1">Role</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 100).map((r) => (
                    <tr key={r.email} className="border-t border-line">
                      <td className="px-2 py-1">{r.email}</td>
                      <td className="px-2 py-1">{r.firstName ?? '—'}</td>
                      <td className="px-2 py-1">{r.lastName ?? '—'}</td>
                      <td className="px-2 py-1">{r.role ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.rows.length > 100 && (
                <p className="text-[11px] text-ink-muted mt-1">
                  Showing first 100. {preview.rows.length - 100} more will be imported.
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {appliedResult && (
        <p
          data-testid="apply-result"
          className="text-sm border border-brand bg-brand-soft rounded p-3"
        >
          ✅ Done. Created: <strong>{appliedResult.created}</strong>. Updated:{' '}
          <strong>{appliedResult.updated}</strong>.
        </p>
      )}
    </div>
  );
}
