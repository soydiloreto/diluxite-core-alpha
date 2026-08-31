import { useCallback, useEffect, useState } from 'react';
import type { EmbeddingHealth, OrganizationWithRole } from '../../api';
import { useApp } from '../AppContext';
import { AlertTriangle, Check, RefreshCw, Settings } from '../../icons';
import { Button, useDialogs } from '../../ui';
import { EmbeddingProviderForm } from './EmbeddingProviderForm';

/**
 * Admin → AI / Embeddings.
 *
 * WHICH embedder is running, and whether the vectors already in the database
 * were produced by it. The second question is the one that matters: change
 * the model and every stored vector has the wrong dimension, at which point
 * pgvector aborts the semantic half of a search with `different vector
 * dimensions`, keyword search absorbs the query, and results keep coming
 * back. Search silently becomes keyword-only. Until this panel the only
 * trace was a warning printed once, at boot, into the container log.
 *
 * Choosing the provider is still an install-time decision (env vars on the
 * `api` container): the model dictates the vector dimension, so switching is
 * a data migration, not a setting. What is here is the pair that migration
 * needs — see the mismatch, and rebuild from it.
 */
export function AiConfigTab({ org }: { org: OrganizationWithRole | null }) {
  const { api } = useApp();
  const dialogs = useDialogs();
  const [health, setHealth] = useState<EmbeddingHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reindexing, setReindexing] = useState(false);
  const [lastReindex, setLastReindex] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!org) return;
    setLoading(true);
    setError(null);
    try {
      setHealth(await api.embeddingHealth(org.id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, org]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reindex() {
    if (!org) return;
    const ok = await dialogs.confirm('Re-embed every note in this organisation?', {
      message:
        'Each note is chunked and embedded again. It runs in one pass and can take a while on ' +
        'a large workspace — leave this tab open until it finishes.',
      okLabel: 'Reindex',
    });
    if (!ok) return;
    setReindexing(true);
    setError(null);
    try {
      const { reindexed } = await api.reindex({ orgId: org.id });
      setLastReindex(reindexed);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReindexing(false);
    }
  }

  const canReindex = org?.role === 'org_admin';
  const active = health?.active ?? null;

  return (
    <div className="max-w-2xl">
      <header className="mb-4">
        <h2 className="text-lg font-semibold flex items-center gap-2 text-ink">
          <Settings size={16} className="text-brand" /> AI / Embeddings
        </h2>
        <p className="text-xs text-ink-muted mt-1">
          The semantic engine for this instance, and whether what is stored still matches it.
        </p>
      </header>

      {error && (
        <div role="alert" className="mb-4 rounded border border-danger/40 bg-danger/10 p-3 text-sm text-ink">
          {error}
        </div>
      )}

      <section className="rounded border border-line bg-bg-surface p-4 mb-4">
        <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-2">Active provider</div>
        {loading ? (
          <div className="text-sm text-ink-muted">Loading…</div>
        ) : !active ? (
          <div className="text-sm text-ink-muted">Unknown — this instance did not report one.</div>
        ) : (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-muted">Provider</dt>
            <dd className="font-mono text-ink">{active.provider}</dd>
            <dt className="text-ink-muted">Model</dt>
            <dd className="font-mono text-ink">{active.model ?? '—'}</dd>
            <dt className="text-ink-muted">Endpoint</dt>
            <dd className="font-mono text-ink">{active.endpoint ?? '—'}</dd>
            <dt className="text-ink-muted">Dimensions</dt>
            <dd className="font-mono text-ink">{active.dimensions}</dd>
          </dl>
        )}

        {/* The deterministic provider is the one an install lands on when
            nothing is configured, and "local" reads like a healthy state. It
            is not: the vectors are stable, not meaningful. */}
        {active && !active.semantic && (
          <p data-testid="not-semantic-warning" className="mt-3 flex gap-2 text-xs text-ink-muted">
            <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-px" />
            <span>
              This provider is <strong className="text-ink">not semantic</strong>. It hashes words
              into stable vectors, which is enough for tests and for keyword-adjacent matching, but
              two ways of saying the same thing land as far apart as two unrelated sentences.
              Configure Ollama or Azure OpenAI below for real semantic search.
            </span>
          </p>
        )}
      </section>

      <div className="mb-4">
        {org && <EmbeddingProviderForm orgId={org.id} onSaved={() => void load()} />}
      </div>

      <section className="rounded border border-line bg-bg-surface p-4 mb-4">
        <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-2">Stored vectors</div>
        {loading || !health ? (
          <div className="text-sm text-ink-muted">Loading…</div>
        ) : health.chunks === 0 ? (
          <div className="text-sm text-ink-muted">Nothing indexed yet.</div>
        ) : (
          <>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              {health.stored.map((g) => (
                <div key={g.dimensions} className="contents">
                  <dt className="text-ink-muted">{g.dimensions} dims</dt>
                  <dd className="font-mono text-ink">
                    {g.chunks} chunk{g.chunks === 1 ? '' : 's'}
                  </dd>
                </div>
              ))}
              {health.chunksWithoutEmbedding > 0 && (
                <>
                  <dt className="text-ink-muted">no embedding</dt>
                  <dd className="font-mono text-ink">{health.chunksWithoutEmbedding}</dd>
                </>
              )}
            </dl>

            <div className="mt-3 flex items-start gap-2 text-xs">
              {health.reindexRequired ? (
                <>
                  <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-px" />
                  <span className="text-ink">
                    Some stored vectors were not produced by the active embedder. Semantic search
                    fails on those notes until they are rebuilt — keyword search keeps working,
                    which is why nothing looks broken.
                  </span>
                </>
              ) : (
                <>
                  <Check size={14} className="text-brand shrink-0 mt-px" />
                  <span className="text-ink-muted">
                    Everything stored matches the active embedder.
                  </span>
                </>
              )}
            </div>
          </>
        )}

        <div className="mt-4 flex items-center gap-3">
          <Button
            onClick={() => void reindex()}
            disabled={!canReindex || reindexing || loading}
            variant={health?.reindexRequired ? 'primary' : 'secondary'}
          >
            <RefreshCw size={13} className={reindexing ? 'animate-spin' : ''} />
            {reindexing ? 'Reindexing…' : 'Reindex now'}
          </Button>
          {lastReindex !== null && !reindexing && (
            <span className="text-xs text-ink-muted">
              Re-embedded {lastReindex} note{lastReindex === 1 ? '' : 's'}.
            </span>
          )}
          {!canReindex && (
            <span className="text-xs text-ink-muted">Only an organisation admin can reindex.</span>
          )}
        </div>
      </section>

      <section className="text-sm text-ink-muted leading-relaxed space-y-3">
        <p>
          The form above is stored in the database and wins over the environment. Without it, the
          instance falls back to <code className="text-ink">AZURE_OPENAI_*</code> →{' '}
          <code className="text-ink">OLLAMA_*</code> → the deterministic provider, which is how
          installations were configured before and still works.
        </p>
        <pre className="bg-bg p-3 rounded text-xs text-ink overflow-x-auto border border-line">{`# Ollama (recommended)
OLLAMA_EMBEDDING_MODEL=mxbai-embed-large:335m
OLLAMA_EMBEDDING_DIMENSIONS=1024
OLLAMA_ENDPOINT=http://host.docker.internal:11434

# Azure OpenAI (overrides Ollama if all three are set)
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=text-embedding-3-large`}</pre>
      </section>
    </div>
  );
}
