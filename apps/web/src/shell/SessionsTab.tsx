import { useEffect, useState, type FormEvent } from 'react';
import type { ApiClient } from '../api';
import { Button, Field, Input } from '../ui';

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
    // Deliberately only re-fetch when the api client itself swaps; `refresh` is
    // a stable identity within this component scope (no closure over changing state).
    refresh();
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
    <div data-testid="sessions-tab" className="flex flex-col gap-6 max-w-3xl">
      <ChangePasswordSection api={api} />

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

/**
 * Change-password section. Sits inside the Sessions tab because the two are
 * tightly coupled: a successful password change revokes every OTHER session,
 * which is exactly the action a user would expect after rotating a password.
 */
function ChangePasswordSection({ api }: { api: ApiClient }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (next !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    if (next.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.changePassword(current, next);
      setSuccess(
        r.otherSessionsRevoked > 0
          ? `Password updated — signed out ${r.otherSessionsRevoked} other device(s).`
          : 'Password updated.',
      );
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="password-section" className="flex flex-col gap-3">
      <header>
        <h3 className="text-lg font-semibold">Change password</h3>
        <p className="text-xs text-ink-muted mt-1">
          Updating your password signs you out of every OTHER device. This one stays.
        </p>
      </header>
      <form onSubmit={submit} className="flex flex-col gap-2 max-w-md">
        <Field label="Current password">
          <Input
            data-testid="password-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="New password (min 8 characters)">
          <Input
            data-testid="password-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="Confirm new password">
          <Input
            data-testid="password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
          />
        </Field>
        {error && (
          <p
            role="alert"
            className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2"
          >
            {error}
          </p>
        )}
        {success && (
          <p
            data-testid="password-success"
            className="text-xs text-ink border border-brand bg-brand-soft/30 rounded p-2"
          >
            {success}
          </p>
        )}
        <Button
          data-testid="password-submit"
          type="submit"
          disabled={busy || !current || next.length < 8}
          className="self-start"
        >
          {busy ? 'Updating…' : 'Change password'}
        </Button>
      </form>
    </section>
  );
}
