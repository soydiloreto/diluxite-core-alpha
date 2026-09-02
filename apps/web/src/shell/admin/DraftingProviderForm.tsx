import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import { Button } from '../../ui';
import type { GenerationConfig } from '../../api';

/**
 * Admin → AI: the drafting provider (ADR-006).
 *
 * Beside the embedding provider on purpose — two engines with different jobs,
 * not two features — and with the difference stated where an admin reads it:
 * this one only writes the QUESTION on a review card. It never decides whether
 * something is true, never touches ranking, and never answers anybody.
 *
 * Leaving it empty is a working state, and the form says so rather than
 * looking like an unfinished setup.
 */
export function DraftingProviderForm({ orgId }: { orgId: string }) {
  const { api } = useApp();
  const [cfg, setCfg] = useState<GenerationConfig | null>(null);
  const [provider, setProvider] = useState<'openai-compatible' | 'ollama'>('openai-compatible');
  const [model, setModel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await api.generationConfig(orgId);
      setCfg(c);
      if (c) {
        setProvider(c.provider);
        setModel(c.model);
        setEndpoint(c.endpoint);
      }
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
    setTested(null);
    try {
      await fn();
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
        Drafting provider (optional)
      </div>
      <p className="text-xs text-ink-muted mb-3 leading-relaxed">
        Writes the question on a review card, and nothing else — it never decides
        whether something is true, never affects ranking, and never answers a
        question. Leave it empty and the weekly batch still works: exact values
        keep their templated questions, and prose is quoted instead of summarised.
      </p>

      <div className="grid gap-2 max-w-md">
        <label className="text-xs text-ink-muted">
          Provider
          <select
            aria-label="Provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
            className="mt-0.5 w-full text-sm bg-bg border border-line rounded px-2 py-1 text-ink"
          >
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="ollama">Ollama</option>
          </select>
        </label>

        <label className="text-xs text-ink-muted">
          Endpoint
          <input
            aria-label="Endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://…/v1/chat/completions"
            className="mt-0.5 w-full text-sm bg-bg border border-line rounded px-2 py-1 text-ink"
          />
        </label>

        <label className="text-xs text-ink-muted">
          Model
          <input
            aria-label="Model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="mt-0.5 w-full text-sm bg-bg border border-line rounded px-2 py-1 text-ink"
          />
        </label>

        <label className="text-xs text-ink-muted">
          API key
          <input
            aria-label="API key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={cfg?.hasApiKey ? 'stored — leave empty to keep it' : 'optional'}
            className="mt-0.5 w-full text-sm bg-bg border border-line rounded px-2 py-1 text-ink"
          />
        </label>
      </div>

      {error && (
        <p role="alert" className="text-xs text-danger-ink mt-2">
          {error}
        </p>
      )}
      {tested && <p className="text-xs text-ink-muted mt-2">Drafted: «{tested}»</p>}

      <div className="flex flex-wrap gap-2 mt-3">
        <Button
          size="sm"
          disabled={busy || !model.trim() || !endpoint.trim()}
          onClick={() =>
            void run(async () => {
              // An empty box means "keep the stored key", never "erase it":
              // an admin cannot retype a key they are not allowed to read.
              await api.saveGenerationConfig(orgId, {
                provider,
                model,
                endpoint,
                ...(apiKey ? { apiKey } : {}),
              });
              setApiKey('');
              await load();
            })
          }
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !cfg}
          onClick={() =>
            void run(async () => {
              const r = await api.testGenerationConfig(orgId);
              setTested(r.claim ?? '—');
            })
          }
        >
          Try it once
        </Button>
        {cfg && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.clearGenerationConfig(orgId);
                setModel('');
                setEndpoint('');
                setApiKey('');
                await load();
              })
            }
          >
            Remove
          </Button>
        )}
      </div>
    </section>
  );
}
