import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import { Button, useDialogs } from '../../ui';
import type { GithubConnection, GithubSyncReport, OrganizationWithRole } from '../../api';

/**
 * Admin → Connectors: where the organisation's content comes from.
 *
 * One connector so far, and the screen says the thing that matters about it:
 * **nobody pastes a token here**. An owner installs the App on the repositories
 * they choose, and what this instance stores is an installation id — not a
 * credential, and not one person's key that dies when they leave.
 */
export function ConnectorsTab({ org }: { org: OrganizationWithRole | null }) {
  const { api } = useApp();
  const dialogs = useDialogs();
  const [state, setState] = useState<GithubConnection | null>(null);
  const [reports, setReports] = useState<GithubSyncReport[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!org) return;
    try {
      setState(await api.githubConnection(org.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, org]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!org) return null;

  if (state && !state.configured) {
    return (
      <Section>
        <p className="text-sm text-ink-muted leading-relaxed">
          This installation has no GitHub App configured, so the connector is not
          offered. An operator sets <code>DILUXITE_GITHUB_APP_ID</code>,{' '}
          <code>DILUXITE_GITHUB_PRIVATE_KEY</code>,{' '}
          <code>DILUXITE_GITHUB_WEBHOOK_SECRET</code> and{' '}
          <code>DILUXITE_GITHUB_APP_SLUG</code> to enable it.
        </p>
      </Section>
    );
  }

  const inst = state?.installation ?? null;

  return (
    <Section>
      <p className="text-sm text-ink-muted leading-relaxed mb-3">
        Ingests the Markdown of the repositories you choose — decisions, ADRs,
        runbooks — so search and your AI can answer over them. <strong>You do
        not paste a token here.</strong> An owner installs the app on GitHub and
        picks the repositories; what is stored on this side is an installation
        id, which is not a credential and does not stop working when somebody
        leaves the company.
      </p>

      {error && (
        <p role="alert" className="text-xs text-danger-ink mb-2">
          {error}
        </p>
      )}

      {!inst ? (
        <a
          href={state?.installUrl}
          data-testid="github-install"
          className="inline-flex items-center px-3 py-1.5 rounded-md bg-brand text-white text-sm font-medium hover:bg-brand-hover"
        >
          Connect GitHub
        </a>
      ) : (
        <>
          <dl className="text-xs space-y-1 mb-3">
            <Line label="Account">{inst.accountLogin ?? inst.installationId}</Line>
            <Line label="Connected">{inst.connectedAt.slice(0, 10)}</Line>
            <Line label="Last sync">
              {inst.lastSyncAt ? inst.lastSyncAt.slice(0, 16).replace('T', ' ') : 'never'}
              {inst.lastSyncError && (
                <span className="text-danger-ink"> — {inst.lastSyncError}</span>
              )}
            </Line>
          </dl>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setReports(null);
                  try {
                    setReports((await api.syncGithub(org.id)).reports);
                    await load();
                    setError(null);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              Sync now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  const ok = await dialogs.confirm('Disconnect GitHub?', {
                    // Said plainly, because "disconnect" reads as "delete" to
                    // most people and this one does not delete anything.
                    message:
                      'Ingested notes stay where they are — they are your writing. Only the connection is removed; re-connecting re-reads everything.',
                  });
                  if (!ok) return;
                  setBusy(true);
                  try {
                    await api.disconnectGithub(org.id);
                    await load();
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              Disconnect
            </Button>
          </div>

          {reports && (
            <ul data-testid="sync-report" className="mt-3 text-xs space-y-1">
              {reports.length === 0 && <li className="text-ink-muted">No repositories granted.</li>}
              {reports.map((r) => (
                <li key={r.repo} className="text-ink-muted">
                  <span className="text-ink">{r.repo}</span> — {r.created} new · {r.updated} updated
                  · {r.unchanged} unchanged
                  {r.annotated > 0 && ` · ${r.annotated} marked as removed at source`}
                  {r.skipped.length > 0 && ` · skipped: ${r.skipped.join(', ')}`}
                  {r.truncated && ' · ⚠ tree truncated by GitHub, not everything was listed'}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded border border-line bg-bg-surface p-4 mb-4">
      <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-2">GitHub</div>
      {children}
    </section>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="text-ink-muted w-24 shrink-0">{label}</dt>
      <dd className="text-ink min-w-0">{children}</dd>
    </div>
  );
}
