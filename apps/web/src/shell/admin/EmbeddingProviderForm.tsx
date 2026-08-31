import { useEffect, useState } from 'react';
import type {
  EmbeddingConfig,
  EmbeddingConfigInput,
  EmbeddingProviderName,
  EmbeddingTestResult,
} from '../../api';
import { useApp } from '../AppContext';
import { AlertTriangle, Check } from '../../icons';
import { Button, Field, Input, Select, useDialogs } from '../../ui';

/**
 * Choosing the embedding provider — ADR-003.
 *
 * The form's job is not to collect four fields. It is to stop an administrator
 * from doing, in one click, the thing that quietly breaks search: switching to
 * a model whose vectors do not exist yet.
 *
 * So saving here **does not switch anything**. It stores the choice and
 * registers the new vector space empty; search keeps answering from the model
 * that has vectors until a reindex fills the new one. The form says that
 * before the click, not after.
 *
 * And the provider is tried before it is trusted: one round trip that catches
 * a wrong key, a mistyped endpoint, a model that does not exist, or — the one
 * nobody expects — a model that answers with a different number of dimensions
 * than you told it to, which would index cleanly and fail on every search.
 */

interface Draft {
  provider: EmbeddingProviderName;
  model: string;
  dimensions: string;
  endpoint: string;
  apiKey: string;
}

/** What each provider needs, and what to call it in the form. */
const SHAPE: Record<
  EmbeddingProviderName,
  {
    label: string;
    needsModel: boolean;
    /** The field's name, or `null` when the provider has no endpoint at all. */
    endpoint: string | null;
    /** Ollama has a working default, so asking for it is optional. */
    endpointRequired: boolean;
    needsKey: boolean;
    note: string;
  }
> = {
  local: {
    label: 'Deterministic, local (no model)',
    needsModel: false,
    endpoint: null,
    endpointRequired: false,
    needsKey: false,
    note: 'Hashes words rather than meaning. Useful for testing; it will not find a note that says the same thing in other words.',
  },
  ollama: {
    label: 'Ollama (on your own machine)',
    needsModel: true,
    endpoint: 'Endpoint',
    endpointRequired: false,
    needsKey: false,
    note: 'The model runs on your own infrastructure. None of your notes leaves it.',
  },
  azure: {
    label: 'Azure OpenAI',
    needsModel: true,
    endpoint: 'Endpoint',
    endpointRequired: true,
    needsKey: true,
    note: 'Your notes\u2019 text travels to Microsoft to be turned into vectors.',
  },
  bedrock: {
    label: 'Amazon Bedrock',
    needsModel: true,
    endpoint: 'Region',
    endpointRequired: true,
    needsKey: true,
    note: 'Your notes\u2019 text travels to AWS to be turned into vectors.',
  },
};

const EMPTY: Draft = { provider: 'local', model: '', dimensions: '1536', endpoint: '', apiKey: '' };

export function EmbeddingProviderForm({
  orgId,
  onSaved,
}: {
  orgId: string;
  onSaved?: () => void;
}) {
  const { api } = useApp();
  const dialogs = useDialogs();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [stored, setStored] = useState<EmbeddingConfig | null>(null);
  const [canStoreCredentials, setCanStore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [test, setTest] = useState<EmbeddingTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getEmbeddingConfig(orgId)
      .then((r) => {
        if (cancelled) return;
        setCanStore(r.canStoreCredentials);
        setStored(r.config);
        if (r.config) {
          setDraft({
            provider: r.config.provider,
            model: r.config.model ?? '',
            dimensions: String(r.config.dimensions),
            endpoint: r.config.endpoint ?? '',
            apiKey: '',
          });
        }
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, orgId]);

  const shape = SHAPE[draft.provider];

  const toInput = (): EmbeddingConfigInput => ({
    provider: draft.provider,
    model: shape.needsModel ? draft.model.trim() || null : null,
    dimensions: Number(draft.dimensions),
    endpoint: shape.endpoint ? draft.endpoint.trim() || null : null,
    // Omitted when untouched, so editing the endpoint does not erase a key
    // nobody can read back and retype.
    ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
  });

  /** Does this change the vector space? That is what decides the warning. */
  const changesModel =
    !stored ||
    stored.provider !== draft.provider ||
    (stored.model ?? '') !== (shape.needsModel ? draft.model.trim() : '') ||
    stored.dimensions !== Number(draft.dimensions);

  const missing =
    (shape.needsModel && !draft.model.trim()) ||
    (shape.endpointRequired && !draft.endpoint.trim()) ||
    !Number.isInteger(Number(draft.dimensions)) ||
    Number(draft.dimensions) < 8;

  async function runTest() {
    setBusy('test');
    setError(null);
    setTest(null);
    try {
      setTest(await api.testEmbeddingProvider(orgId, toInput()));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (changesModel) {
      const ok = await dialogs.confirm('Save this provider?', {
        message:
          'Semantic search KEEPS answering from the current model, and nothing breaks. What this ' +
          'saves is the choice: the new vector space is registered and left empty. Switching the ' +
          'live model to it is NOT available yet in this version, so search goes on using the ' +
          'current one until it is.',
        okLabel: 'Save',
      });
      if (!ok) return;
    }
    setBusy('save');
    setError(null);
    try {
      const r = await api.setEmbeddingConfig(orgId, toInput());
      setStored(r.config);
      setDraft((d) => ({ ...d, apiKey: '' }));
      setSaved(
        r.nextStep === 'reindex-then-activate'
          ? 'Saved. The new vector space is registered and empty; search keeps using the current model.'
          : 'Saved, and live.',
      );
      onSaved?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="text-sm text-ink-muted">Loading…</div>;

  return (
    <section className="rounded border border-line bg-bg-surface p-4 flex flex-col gap-3">
      <Field label="Provider">
        <Select
          value={draft.provider}
          aria-label="embedding provider"
          onChange={(e) => {
            const provider = e.target.value as EmbeddingProviderName;
            setTest(null);
            setSaved(null);
            setDraft((d) => ({ ...d, provider }));
          }}
        >
          {(Object.keys(SHAPE) as EmbeddingProviderName[]).map((p) => (
            <option key={p} value={p}>
              {SHAPE[p].label}
            </option>
          ))}
        </Select>
      </Field>

      {/* What the choice means for the data, before it is made rather than
          after. For a second brain holding a company's notes, "the text
          travels to Microsoft" is a business decision, not a technical one. */}
      <p className="text-xs text-ink-muted flex gap-2">
        {draft.provider === 'local' ? (
          <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-px" />
        ) : null}
        <span>{shape.note}</span>
      </p>

      {shape.needsModel && (
        <Field label="Model" hint="e.g. mxbai-embed-large, text-embedding-3-large, amazon.titan-embed-text-v2:0">
          <Input
            value={draft.model}
            aria-label="model"
            onChange={(e) => {
              setTest(null);
              setDraft((d) => ({ ...d, model: e.target.value }));
            }}
          />
        </Field>
      )}

      {shape.endpoint && (
        <Field
          label={shape.endpoint}
          hint={
            draft.provider === 'bedrock'
              ? 'e.g. us-east-1'
              : 'e.g. http://host.docker.internal:11434 \u2014 empty uses localhost:11434'
          }
        >
          <Input
            value={draft.endpoint}
            aria-label={shape.endpoint.toLowerCase()}
            onChange={(e) => {
              setTest(null);
              setDraft((d) => ({ ...d, endpoint: e.target.value }));
            }}
          />
        </Field>
      )}

      <Field
        label="Dimensions"
        hint="Must match the model's. If it does not, the test below says so."
      >
        <Input
          value={draft.dimensions}
          inputMode="numeric"
          aria-label="dimensions"
          onChange={(e) => {
            setTest(null);
            setDraft((d) => ({ ...d, dimensions: e.target.value }));
          }}
        />
      </Field>

      {shape.needsKey && (
        <Field
          label="API key"
          hint={
            stored?.hasApiKey
              ? 'One is stored. Leave this empty to keep it.'
              : 'Stored encrypted. It can never be read back.'
          }
        >
          <Input
            type="password"
            value={draft.apiKey}
            aria-label="api key"
            placeholder={stored?.hasApiKey ? '•••••••• (unchanged)' : ''}
            onChange={(e) => {
              setTest(null);
              setDraft((d) => ({ ...d, apiKey: e.target.value }));
            }}
          />
        </Field>
      )}

      {shape.needsKey && !canStoreCredentials && (
        <p role="alert" className="text-xs text-ink flex gap-2">
          <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-px" />
          <span>
            No encryption passphrase is configured, so the key cannot be stored. Set{' '}
            <code>DILUXITE_SECRET_KEY</code> on the <code>api</code> container and try again. A
            random one is deliberately not invented: it would make every stored credential
            unreadable after the next restart.
          </span>
        </p>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="secondary" onClick={() => void runTest()} disabled={!!busy || !!missing}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </Button>
        <Button
          onClick={() => void save()}
          disabled={!!busy || !!missing || (shape.needsKey && !canStoreCredentials && !stored?.hasApiKey)}
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </Button>
        {changesModel && (
          <span className="text-xs text-ink-muted">
            This changes the vector space: it has to be reindexed before it goes live.
          </span>
        )}
      </div>

      {test && (
        <p
          role="status"
          className={`text-xs flex gap-2 ${test.ok ? 'text-ink-muted' : 'text-ink'}`}
          data-testid="embedding-test-result"
        >
          {test.ok ? (
            <Check size={14} className="text-brand shrink-0 mt-px" />
          ) : (
            <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-px" />
          )}
          <span>
            {test.ok
              ? `Answered with ${test.dimensions} dimensions in ${test.elapsedMs} ms.`
              : test.error}
          </span>
        </p>
      )}

      {saved && (
        <p role="status" className="text-xs text-ink-muted" data-testid="embedding-saved">
          {saved}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger-ink">
          {error}
        </p>
      )}
    </section>
  );
}
