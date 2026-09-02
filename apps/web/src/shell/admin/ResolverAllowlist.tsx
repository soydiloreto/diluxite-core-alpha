import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import { Button } from '../../ui';
import type { AllowedHost } from '../../api';

/**
 * Admin → AI: which hosts a note's resolver may call.
 *
 * THE TRUST BOUNDARY, and the screen says so. A note declares where to ask for
 * a live value, and without this list nothing is called: a note is user input,
 * and letting it choose the addresses the server reaches is a server-side
 * request forgery with a nice syntax.
 *
 * The split it enforces is the whole design: the NOTE says where, the OPERATOR
 * says which hosts and how to authenticate — so a credential never lives in a
 * note, where anybody who can read the note can read it too.
 */
export function ResolverAllowlist({ orgId }: { orgId: string }) {
  const { api } = useApp();
  const [hosts, setHosts] = useState<AllowedHost[]>([]);
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHosts(await api.resolverAllowlist(orgId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded border border-line bg-bg-surface p-4 mb-4">
      <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-2">
        Live sources — allowed hosts
      </div>
      <p className="text-xs text-ink-muted mb-3 leading-relaxed">
        A note can declare where to fetch a live value (a metric, a ticket
        status). Nothing is called unless its host is on this list. The note
        says <em>where</em>; you say <em>which hosts</em> and{' '}
        <em>how to authenticate</em>, so a credential never sits inside a note.
      </p>

      {hosts.length > 0 && (
        <ul className="mb-3 divide-y divide-line border border-line rounded">
          {hosts.map((h) => (
            <li key={h.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
              <span className="font-mono text-ink">{h.host}</span>
              {h.hasToken && (
                <span className="text-[10px] text-ink-muted border border-line rounded px-1">
                  token
                </span>
              )}
              <span className="text-ink-muted flex-1 truncate">{h.note}</span>
              <button
                onClick={() => void run(() => api.revokeResolverHost(orgId, h.id))}
                disabled={busy}
                aria-label={`revoke ${h.host}`}
                className="text-ink-muted hover:text-ink"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 max-w-md">
        <label className="text-xs text-ink-muted">
          Host
          <input
            aria-label="Host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="metrics.example  ·  or metrics.example:8443"
            className="mt-0.5 w-full text-sm bg-bg border border-line rounded px-2 py-1 text-ink"
          />
        </label>
        <label className="text-xs text-ink-muted">
          Token (optional)
          <input
            aria-label="Token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="mt-0.5 w-full text-sm bg-bg border border-line rounded px-2 py-1 text-ink"
          />
        </label>
        <label className="text-xs text-ink-muted">
          What it is
          <input
            aria-label="What it is"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="our metrics API"
            className="mt-0.5 w-full text-sm bg-bg border border-line rounded px-2 py-1 text-ink"
          />
        </label>
      </div>

      {error && (
        <p role="alert" className="text-xs text-danger-ink mt-2">
          {error}
        </p>
      )}

      <div className="mt-3">
        <Button
          size="sm"
          disabled={busy || !host.trim()}
          onClick={() =>
            void run(async () => {
              await api.allowResolverHost(orgId, {
                host,
                ...(token ? { token } : {}),
                ...(note ? { note } : {}),
              });
              setHost('');
              setToken('');
              setNote('');
            })
          }
        >
          Allow this host
        </Button>
      </div>
    </section>
  );
}
