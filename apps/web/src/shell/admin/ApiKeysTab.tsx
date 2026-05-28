import { useCallback, useEffect, useState } from 'react';
import type { TokenInfo } from '../../api';
import { useApp } from '../AppContext';
import { Button, Field, Input, useDialogs } from '../../ui';
import { Plug, Plus, Trash2 } from '../../icons';

/**
 * Admin · API keys — list active MCP tokens, mint new ones, revoke. The
 * Core edition's tokens are per-user (not per-org yet); we still surface
 * them in the admin console so the workspace lead has one place for
 * everything.
 */
export function ApiKeysTab() {
  const { api } = useApp();
  const dialogs = useDialogs();
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setTokens(await api.listTokens());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function mint() {
    setBusy(true);
    setMinted(null);
    setError(null);
    try {
      const t = await api.mintToken(newName.trim() || 'MCP token');
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
      message: 'The MCP client using this token will immediately lose access.',
      danger: true,
      okLabel: 'Revoke',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.revokeToken(t.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const mcpUrl = `${window.location.origin}/mcp`;

  return (
    <div className="max-w-3xl flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold flex items-center gap-2 text-ink">
          <Plug size={16} className="text-brand" /> API keys & MCP
        </h2>
        <p className="text-xs text-ink-muted mt-1">
          One token = one IA client. Endpoint:{' '}
          <code className="px-1 py-0.5 rounded bg-bg-surface border border-line text-[10px]">
            {mcpUrl}
          </code>
        </p>
      </header>

      <section className="rounded-md border border-line bg-bg-surface p-3 flex items-end gap-2">
        <Field label="Mint new token" className="flex-1">
          <Input
            aria-label="new token name"
            placeholder="e.g. Claude desktop, Copilot at home"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void mint();
            }}
          />
        </Field>
        <Button onClick={mint} disabled={busy}>
          <Plus size={14} /> Mint
        </Button>
      </section>

      {minted && (
        <p
          data-testid="minted-token"
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
              <th className="text-left px-3 py-2 w-40">Created</th>
              <th className="text-right px-3 py-2 w-24">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={3} className="text-center text-ink-muted py-6 text-xs">
                  Loading…
                </td>
              </tr>
            ) : tokens.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-center text-ink-muted py-6 text-xs">
                  No active tokens.
                </td>
              </tr>
            ) : (
              tokens.map((t) => (
                <tr key={t.id} className="border-t border-line">
                  <td className="px-3 py-2 truncate">{t.name}</td>
                  <td className="px-3 py-2 text-xs text-ink-muted">
                    {t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => void revoke(t)}
                      aria-label={`revoke ${t.name}`}
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
    </div>
  );
}
