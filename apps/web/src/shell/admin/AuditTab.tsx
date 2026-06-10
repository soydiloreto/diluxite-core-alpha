import { useEffect, useState } from 'react';
import type { ApiClient, AuditEvent, OrganizationWithRole } from '../../api';

/**
 * Admin → Audit log.
 *
 * Shows the org's audit events newest-first. Filters by action prefix to keep
 * the noise floor down — typing `auth.` collapses the view to logins.
 *
 * Members see only their own events (the API enforces it); admins see the
 * whole org. There is no client-side privilege escalation guard — the API
 * decides what comes back.
 *
 * Pagination: the "Load more" button paginates via the `beforeId` cursor on
 * the current oldest event. We don't pre-fetch — the user clicks to see more.
 */
export function AuditTab({
  api,
  org,
}: {
  api: ApiClient;
  org: OrganizationWithRole;
}) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    // Debounce the per-keystroke filter (~250ms) so typing "admin." fires one
    // request, not six. `cancelled` also guards against a stale response
    // (slow request for an earlier filter) overwriting a newer one.
    let cancelled = false;
    const handle = setTimeout(() => {
      setLoading(true);
      setError(null);
      api
        .listAuditEvents(org.id, { action: action || undefined })
        .then((r) => {
          if (cancelled) return;
          setEvents(r.events);
          setTotal(r.total);
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [api, org.id, action]);

  async function loadMore() {
    if (events.length === 0) return;
    const last = events[events.length - 1];
    setLoadingMore(true);
    try {
      const r = await api.listAuditEvents(org.id, {
        action: action || undefined,
        beforeId: last.id,
      });
      setEvents((prev) => [...prev, ...r.events]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div data-testid="audit-tab" className="flex flex-col gap-4">
      <header>
        <h3 className="text-lg font-semibold">Audit log</h3>
        <p className="text-xs text-ink-muted mt-1">
          Append-only record of security and admin actions. Members see their own activity;
          admins see everything in the org. Sorted newest first.
        </p>
      </header>

      <div className="flex items-end gap-2 flex-wrap">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-ink-muted">Filter by action prefix</span>
          <input
            data-testid="audit-action-filter"
            type="text"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="auth. / admin. / ..."
            className="border border-line bg-bg text-ink rounded px-2 py-1 text-sm w-64"
          />
        </label>
        <p className="text-xs text-ink-muted">
          Showing {events.length} of {total}
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2"
        >
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : events.length === 0 ? (
        <p data-testid="audit-empty" className="text-sm text-ink-muted">
          No events match the current filter.
        </p>
      ) : (
        <table
          data-testid="audit-table"
          className="w-full text-xs border border-line rounded overflow-hidden"
        >
          <thead className="bg-bg-soft text-ink-muted">
            <tr>
              <th className="text-left p-2">At</th>
              <th className="text-left p-2">Actor</th>
              <th className="text-left p-2">Action</th>
              <th className="text-left p-2">IP</th>
              <th className="text-left p-2">Detail</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} data-testid={`audit-row-${e.id}`} className="border-t border-line">
                <td className="p-2 whitespace-nowrap font-mono">
                  {new Date(e.at).toLocaleString()}
                </td>
                <td className="p-2 font-mono">{e.actorId ?? <span className="text-ink-muted">—</span>}</td>
                <td className="p-2 font-mono">{e.action}</td>
                <td className="p-2 font-mono">{e.ip ?? <span className="text-ink-muted">—</span>}</td>
                <td className="p-2 font-mono whitespace-pre-wrap break-all max-w-md">
                  {Object.keys(e.metadata).length > 0 ? JSON.stringify(e.metadata) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {events.length > 0 && events.length < total && (
        <button
          data-testid="audit-load-more"
          onClick={loadMore}
          disabled={loadingMore}
          className="self-start text-xs border border-line rounded px-3 py-1.5 hover:bg-bg-soft disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
