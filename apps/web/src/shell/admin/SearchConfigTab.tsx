import { useEffect, useState } from 'react';
import { Button, Field, Input, Select } from '../../ui';
import type { Prefs } from '../../useSettings';

/**
 * Admin → Search. Pattern Save explícito (draft local + botón "Save").
 */
export function SearchConfigTab({
  prefs,
  setPref,
}: {
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
}) {
  const [draft, setDraft] = useState<{ searchMode: Prefs['searchMode']; topK: number }>({
    searchMode: prefs.searchMode,
    topK: prefs.topK,
  });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft({ searchMode: prefs.searchMode, topK: prefs.topK });
  }, [prefs.searchMode, prefs.topK]);
  const dirty = draft.searchMode !== prefs.searchMode || draft.topK !== prefs.topK;
  function save() {
    if (draft.searchMode !== prefs.searchMode) setPref('searchMode', draft.searchMode);
    if (draft.topK !== prefs.topK) setPref('topK', draft.topK);
    setSaved(true);
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
        <p className="text-xs text-ink-muted mt-1 italic">
          Currently persisted per-browser. Server-side org persistence ships in alpha.48.
        </p>
      </header>

      <Field label="Mode">
        <Select
          aria-label="search mode"
          value={draft.searchMode}
          onChange={(e) => {
            setDraft((d) => ({ ...d, searchMode: e.target.value as Prefs['searchMode'] }));
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
          max={20}
          value={draft.topK}
          onChange={(e) => {
            setDraft((d) => ({ ...d, topK: Number(e.target.value) || 5 }));
            setSaved(false);
          }}
          className="w-24"
        />
      </Field>

      <div className="flex items-center gap-2 mt-2">
        <Button data-testid="search-save" onClick={save} disabled={!dirty}>
          Save changes
        </Button>
        {saved && !dirty && (
          <span data-testid="search-saved" className="text-xs text-brand">
            ✓ Saved
          </span>
        )}
      </div>
    </div>
  );
}
