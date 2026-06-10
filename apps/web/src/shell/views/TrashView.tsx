import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import type { NoteRef } from '../../api';
import { useDialogs, Button } from '../../ui';
import { Trash2, Undo2 } from '../../icons';
import { ViewShell, Empty } from './FavoritesView';

/**
 * Sidebar view: trash bin for the active workspace.
 *
 * Lists notes that have been soft-deleted (alpha.43). Two per-row actions:
 *   - Restore → moves the note back to active listings.
 *   - Purge   → hard delete (one note, with confirm).
 *
 * Plus a "Empty trash" footer that purges all rows at once.
 *
 * Pattern (per docs/PATTERNS.md §2): mutate → `refreshAll()` instead of
 * patching local state — that way the explorer + favorites + recent all
 * see the change without each view caring.
 */
export function TrashView() {
  const { api, spaceId, refreshAll } = useApp();
  const dialogs = useDialogs();
  const [items, setItems] = useState<NoteRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!spaceId) return;
    setLoading(true);
    try {
      setItems(await api.listTrash(spaceId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, spaceId]);

  // Load guarded against a workspace switch landing mid-flight: a slow
  // listTrash(spaceA) must not paint over a faster listTrash(spaceB).
  useEffect(() => {
    if (!spaceId) return;
    let cancelled = false;
    setLoading(true);
    api
      .listTrash(spaceId)
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, spaceId]);

  async function onRestore(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api.restoreNote(id);
      await Promise.all([refresh(), refreshAll()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onPurge(item: NoteRef) {
    const ok = await dialogs.confirm(`Permanently delete "${item.title}"?`, {
      message: 'This removes the note forever — it cannot be undone.',
      danger: true,
      okLabel: 'Delete forever',
    });
    if (!ok) return;
    setBusy(item.id);
    setError(null);
    try {
      await api.purgeNote(item.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onEmpty() {
    if (!spaceId || items.length === 0) return;
    const ok = await dialogs.confirm(`Empty the trash (${items.length} notes)?`, {
      message: 'All notes in the trash will be permanently deleted.',
      danger: true,
      okLabel: 'Empty trash',
    });
    if (!ok) return;
    setBusy('all');
    setError(null);
    try {
      await api.emptyTrash(spaceId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ViewShell title="Trash" count={items.length}>
      <div data-testid="trash-view" className="flex flex-col gap-2 min-h-0">
        {error && (
          <p
            role="alert"
            className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2"
          >
            {error}
          </p>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2">
          {loading ? (
            <Empty>Loading…</Empty>
          ) : items.length === 0 ? (
            <Empty>Trash is empty. Deleted notes appear here for recovery.</Empty>
          ) : (
            <ul className="flex flex-col py-1">
              {items.map((n) => (
                <li
                  key={n.id}
                  data-testid={`trash-item-${n.id}`}
                  className="flex items-center gap-1 px-1 py-1 text-xs rounded hover:bg-bg min-w-0"
                >
                  <span className="flex-1 min-w-0 truncate text-ink" title={n.title}>
                    {n.title}
                  </span>
                  <button
                    onClick={() => void onRestore(n.id)}
                    disabled={busy === n.id || busy === 'all'}
                    aria-label={`restore ${n.title}`}
                    title="Restore"
                    className="p-1 rounded hover:bg-bg-surface text-ink-muted hover:text-brand disabled:opacity-50"
                  >
                    <Undo2 size={12} />
                  </button>
                  <button
                    onClick={() => void onPurge(n)}
                    disabled={busy === n.id || busy === 'all'}
                    aria-label={`purge ${n.title}`}
                    title="Delete forever"
                    className="p-1 rounded hover:bg-bg-surface text-ink-muted hover:text-red-400 disabled:opacity-50"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {items.length > 0 && (
          <div className="shrink-0 border-t border-line pt-2">
            <Button
              variant="danger"
              size="sm"
              onClick={() => void onEmpty()}
              disabled={busy === 'all'}
              className="w-full"
              data-testid="empty-trash"
            >
              <Trash2 size={12} /> Empty trash ({items.length})
            </Button>
          </div>
        )}
      </div>
    </ViewShell>
  );
}
