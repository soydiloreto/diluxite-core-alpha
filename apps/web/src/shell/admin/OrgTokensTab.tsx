import { useCallback, useEffect, useState } from 'react';
import type { OrganizationWithRole, TokenInfo, TokenScope } from '../../api';
import { useApp } from '../AppContext';
import { Button, Field, Input, useDialogs } from '../../ui';
import { Plug, Plus, Trash2 } from '../../icons';

/**
 * Admin · Org tokens — org-scoped service tokens with granular scopes.
 *
 * Different from "My tokens" in Settings:
 *  - These belong to the org, not to any single user. They survive when the
 *    user that minted them leaves.
 *  - They REQUIRE at least one explicit scope (read|write|admin). An empty
 *    scopes array would degrade to "full org access", which is what user
 *    tokens implicitly do — defeats the purpose.
 *  - Only org admins / super_admins can mint, list, or revoke them.
 */

const SCOPE_LABELS: Record<'read' | 'write' | 'admin', string> = {
  read: 'Read',
  write: 'Write',
  admin: 'Admin',
};

export function OrgTokensTab({ org }: { org: OrganizationWithRole }) {
  const { api } = useApp();
  const dialogs = useDialogs();
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newScopes, setNewScopes] = useState<Set<'read' | 'write' | 'admin'>>(
    () => new Set(['read']),
  );
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = org.role === 'super_admin' || org.role === 'admin';

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setTokens(await api.listOrgTokens(org.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, org.id]);
  useEffect(() => {
    void reload();
  }, [reload]);

  function toggleScope(s: 'read' | 'write' | 'admin') {
    setNewScopes((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  }

  async function mint() {
    if (newScopes.size === 0) {
      setError('Pick at least one scope.');
      return;
    }
    setBusy(true);
    setMinted(null);
    setError(null);
    try {
      const t = await api.mintOrgToken(
        org.id,
        newName.trim() || 'service token',
        Array.from(newScopes) as TokenScope[],
      );
      setMinted(t.token);
      setNewName('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: TokenInfo) {
    const ok = await dialogs.confirm(`Revoke "${t.name}"?`, {
      message: 'Any service using this token will immediately lose access.',
      danger: true,
      okLabel: 'Revoke',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.revokeOrgToken(org.id, t.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="org-tokens-tab" className="max-w-3xl flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold flex items-center gap-2 text-ink">
          <Plug size={16} className="text-brand" /> Org tokens
        </h2>
        <p className="text-xs text-ink-muted mt-1">
          Service tokens scoped to <strong>{org.name}</strong>. Survive when their creator leaves.
          Pick the narrowest scope that works.
        </p>
      </header>

      {!canManage ? (
        <p className="text-xs text-ink-muted border border-line rounded p-3">
          You need admin or super_admin role to manage org tokens.
        </p>
      ) : (
        <section className="rounded-md border border-line bg-bg-surface p-3 flex flex-col gap-3">
          <Field label="Mint new org token">
            <Input
              aria-label="new org token name"
              placeholder="e.g. CI bot, reporting service"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void mint();
              }}
            />
          </Field>
          <fieldset className="flex items-center gap-3 flex-wrap">
            <legend className="text-[11px] uppercase tracking-wide text-ink-muted mr-1">
              Scopes
            </legend>
            {(['read', 'write', 'admin'] as const).map((s) => (
              <label key={s} className="flex items-center gap-1.5 text-xs text-ink">
                <input
                  type="checkbox"
                  checked={newScopes.has(s)}
                  onChange={() => toggleScope(s)}
                  aria-label={`scope ${s}`}
                />
                {SCOPE_LABELS[s]}
              </label>
            ))}
          </fieldset>
          <div className="flex justify-end">
            <Button onClick={mint} disabled={busy}>
              <Plus size={14} /> Mint
            </Button>
          </div>
        </section>
      )}

      {minted && (
        <p
          data-testid="minted-org-token"
          className="text-xs p-3 rounded border border-brand bg-brand-soft text-ink"
        >
          Copy now — it will not be shown again:{' '}
          <code className="break-all">{minted}</code>
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
              <th className="text-left px-3 py-2">Name</th>
              <th className="text-left px-3 py-2">Scopes</th>
              <th className="text-left px-3 py-2 w-40">Created</th>
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
            ) : tokens.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center text-ink-muted py-6 text-xs">
                  No active org tokens.
                </td>
              </tr>
            ) : (
              tokens.map((t) => (
                <tr key={t.id} className="border-t border-line">
                  <td className="px-3 py-2 truncate">{t.name}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1 flex-wrap">
                      {(t.scopes ?? []).map((s) => (
                        <span
                          key={s}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-bg-surface border border-line text-ink-muted"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-muted">
                    {t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canManage ? (
                      <button
                        onClick={() => void revoke(t)}
                        aria-label={`revoke ${t.name}`}
                        disabled={busy}
                        className="p-1 text-ink-muted hover:text-red-400 rounded"
                      >
                        <Trash2 size={13} />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
