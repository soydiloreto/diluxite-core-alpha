import { useEffect, useState } from 'react';
import { Button, Field, Input, Select } from '../../ui';
import type { OrganizationWithRole, SearchMode } from '../../api';
import { useApp } from '../AppContext';

/**
 * Admin → Search. Explicit-save pattern: a local draft plus a Save button.
 *
 * This used to write to the browser's localStorage while living in the ADMIN
 * console, so an administrator configured their own laptop believing they had
 * configured the organisation — the tab said so in small print. It now reads
 * and writes the org's setting, which is what its placement always claimed.
 */
export function SearchConfigTab({ org }: { org: OrganizationWithRole | null }) {
  const { api } = useApp();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<{ mode: SearchMode; topK: number } | null>(null);
  const [draft, setDraft] = useState<{ mode: SearchMode; topK: number }>({
    mode: 'hybrid',
    topK: 5,
  });

  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    setLoading(true);
    void api
      .getSearchConfig(org.id)
      .then((cfg) => {
        if (cancelled) return;
        setCurrent(cfg);
        setDraft(cfg);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, org]);

  // Only an org admin may change it; everyone else reads it. Mirrors the API,
  // which refuses the write regardless — this just stops the UI offering a
  // button that cannot work.
  const canEdit = org?.role === 'admin' || org?.role === 'super_admin';
  const dirty = !!current && (draft.mode !== current.mode || draft.topK !== current.topK);

  async function save() {
    if (!org) return;
    setError(null);
    try {
      await api.setSearchConfig(org.id, draft);
      setCurrent({ ...draft });
      setSaved(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!org) {
    return (
      <div data-testid="admin-search-tab" className="text-sm text-ink-muted">
        No organization selected.
      </div>
    );
  }

  return (
    <div data-testid="admin-search-tab" className="flex flex-col gap-4 max-w-xl">
      <header>
        <h2 className="text-lg font-semibold">Search</h2>
        <p className="text-xs text-ink-muted mt-1">
          How Diluxite searches your memory. <strong>Hybrid</strong> combines keyword + meaning
          (recommended). <strong>Keyword-only</strong> is literal. <strong>Semantic-only</strong>
          ignores the exact word.
        </p>
        <p className="text-xs text-ink-muted mt-1">
          Applies to everyone in <strong>{org.name}</strong>. A request that asks for a specific
          mode still gets it — this is the default.
        </p>
      </header>

      <Field label="Mode">
        <Select
          aria-label="search mode"
          disabled={loading || !canEdit}
          value={draft.mode}
          onChange={(e) => {
            setDraft((d) => ({ ...d, mode: e.target.value as SearchMode }));
            setSaved(false);
          }}
        >
          <option value="hybrid">Hybrid</option>
          <option value="keyword">Keyword only</option>
          <option value="semantic">Semantic only</option>
        </Select>
      </Field>

      <Field label="Results per query (topK)">
        <Input
          aria-label="topK"
          type="number"
          min={1}
          max={50}
          disabled={loading || !canEdit}
          value={draft.topK}
          onChange={(e) => {
            setDraft((d) => ({ ...d, topK: Number(e.target.value) || 5 }));
            setSaved(false);
          }}
          className="w-24"
        />
      </Field>

      {!canEdit && (
        <p data-testid="search-readonly" className="text-xs text-ink-muted">
          Only an organization admin can change this.
        </p>
      )}

      <div className="flex items-center gap-2 mt-2">
        <Button data-testid="search-save" onClick={() => void save()} disabled={!dirty || !canEdit}>
          Save changes
        </Button>
        {saved && !dirty && (
          <span data-testid="search-saved" className="text-xs text-brand">
            ✓ Saved
          </span>
        )}
        {error && (
          <span data-testid="search-error" className="text-xs text-red-400">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
