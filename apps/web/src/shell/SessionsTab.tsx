import { useEffect, useState } from 'react';
import type { ApiClient } from '../api';
import { Button } from '../ui';

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/**
 * Settings → Active sessions.
 *
 * Lists each active session for the signed-in user with device fingerprint
 * (UA + IP), last seen, and a Revoke button per row. "Sign out of all other
 * devices" wipes everything except the current cookie.
 */
export function SessionsTab({ api }: { api: ApiClient }) {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyOthers, setBusyOthers] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listActiveSessions();
      setRows(r.sessions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  async function revoke(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.revokeSession(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function revokeOthers() {
    setBusyOthers(true);
    setError(null);
    try {
      await api.revokeOtherSessions();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyOthers(false);
    }
  }

  return (
    <div data-testid="sessions-tab" className="flex flex-col gap-4 max-w-3xl">
      <header>
        <h3 className="text-lg font-semibold">Active sessions</h3>
        <p className="text-xs text-ink-muted mt-1">
          Every device that's currently signed in to your account. Revoke anything you don't
          recognise — that device is logged out immediately.
        </p>
      </header>

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
      ) : rows.length === 0 ? (
        <p data-testid="sessions-empty" className="text-sm text-ink-muted">
          No active sessions.
        </p>
      ) : (
        <>
          <table
            data-testid="sessions-table"
            className="w-full text-xs border border-line rounded overflow-hidden"
          >
            <thead className="bg-bg-soft text-ink-muted">
              <tr>
                <th className="text-left p-2">Device</th>
                <th className="text-left p-2">IP</th>
                <th className="text-left p-2">Last seen</th>
                <th className="text-left p-2">Expires</th>
                <th className="text-left p-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr
                  key={s.id}
                  data-testid={`sessions-row-${s.id}`}
                  className={`border-t border-line ${s.current ? 'bg-brand-soft/30' : ''}`}
                >
                  <td className="p-2 max-w-xs truncate" title={s.userAgent ?? ''}>
                    {s.userAgent ?? '—'}
                    {s.current && (
                      <span data-testid="sessions-current-marker" className="ml-1 text-brand">
                        (this device)
                      </span>
                    )}
                  </td>
                  <td className="p-2 font-mono">{s.ip ?? '—'}</td>
                  <td className="p-2">
                    {s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '—'}
                  </td>
                  <td className="p-2 text-ink-muted">
                    {new Date(s.expiresAt).toLocaleDateString()}
                  </td>
                  <td className="p-2 text-right">
                    {s.current ? (
                      <span className="text-ink-muted">—</span>
                    ) : (
                      <Button
                        data-testid={`sessions-revoke-${s.id}`}
                        variant="danger"
                        size="sm"
                        disabled={busyId === s.id}
                        onClick={() => revoke(s.id)}
                      >
                        {busyId === s.id ? 'Revoking…' : 'Revoke'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {rows.some((s) => !s.current) && (
            <Button
              data-testid="sessions-revoke-others"
              variant="danger"
              onClick={revokeOthers}
              disabled={busyOthers}
              className="self-start"
            >
              {busyOthers ? 'Signing out…' : 'Sign out of all other devices'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
