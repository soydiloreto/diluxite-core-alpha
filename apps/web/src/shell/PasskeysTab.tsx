import { useCallback, useEffect, useState } from 'react';
import type { PasskeyInfo } from '../api';
import { useApp } from './AppContext';
import { Button, Field, Input, useDialogs } from '../ui';
import { Plug, Plus, Trash2 } from '../icons';

/**
 * Settings · Passkeys — register / list / revoke WebAuthn credentials for
 * the current user. Server-mode only; in local mode this tab will simply
 * show an empty list (the API endpoint returns 404 and the catch sets
 * an "unavailable" message instead of an error toast).
 */
export function PasskeysTab() {
  const { api } = useApp();
  const dialogs = useDialogs();
  const [list, setList] = useState<PasskeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setList(await api.listPasskeys());
      setAvailable(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/\b404\b/.test(msg)) {
        setAvailable(false);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function register() {
    if (!available) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await api.registerPasskey(label.trim() || 'passkey');
      setSuccess('Passkey registered — try it on next sign-in.');
      setLabel('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(p: PasskeyInfo) {
    const ok = await dialogs.confirm(`Remove "${p.label}"?`, {
      message: 'This passkey will no longer be accepted for sign-in.',
      danger: true,
      okLabel: 'Remove',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.revokePasskey(p.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="passkeys-tab" className="max-w-2xl flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold flex items-center gap-2 text-ink">
          <Plug size={16} className="text-brand" /> Passkeys
        </h2>
        <p className="text-xs text-ink-muted mt-1">
          Sign in without a password. Add one per device (laptop, phone, security key).
        </p>
      </header>

      {!available ? (
        <p className="text-xs text-ink-muted border border-line rounded p-3">
          Passkeys are only available in <strong>server mode</strong>. Your install runs in
          local single-user mode, where there is no login.
        </p>
      ) : (
        <>
          <section className="rounded-md border border-line bg-bg-surface p-3 flex items-end gap-2">
            <Field label="Add this device" className="flex-1">
              <Input
                aria-label="passkey label"
                placeholder="e.g. iPhone 17, Work MacBook, YubiKey"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            <Button onClick={register} disabled={busy}>
              <Plus size={14} /> Add passkey
            </Button>
          </section>

          {success && (
            <p className="text-xs p-2 rounded border border-brand bg-brand-soft text-ink">
              {success}
            </p>
          )}
          {error && (
            <p className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2">
              {error}
            </p>
          )}

          <div className="rounded-md border border-line overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-bg-surface text-[11px] uppercase tracking-wider text-ink-muted">
                <tr>
                  <th className="text-left px-3 py-2">Label</th>
                  <th className="text-left px-3 py-2 w-32">Type</th>
                  <th className="text-left px-3 py-2 w-40">Last used</th>
                  <th className="text-right px-3 py-2 w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={4} className="text-center text-ink-muted py-6 text-xs">
                      Loading…
                    </td>
                  </tr>
                ) : list.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center text-ink-muted py-6 text-xs">
                      No passkeys yet.
                    </td>
                  </tr>
                ) : (
                  list.map((p) => (
                    <tr key={p.id} className="border-t border-line">
                      <td className="px-3 py-2 truncate">{p.label}</td>
                      <td className="px-3 py-2 text-xs text-ink-muted">{p.deviceType ?? '—'}</td>
                      <td className="px-3 py-2 text-xs text-ink-muted">
                        {p.lastUsedAt ? new Date(p.lastUsedAt).toLocaleString() : 'never'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => void revoke(p)}
                          aria-label={`revoke ${p.label}`}
                          disabled={busy}
                          className="p-1 text-ink-muted hover:text-red-400 rounded"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
