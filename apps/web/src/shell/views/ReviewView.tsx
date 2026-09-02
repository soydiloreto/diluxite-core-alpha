import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import { useT } from '../../i18n';
import { Button } from '../../ui';
import { ViewShell, Empty } from './FavoritesView';
import type {
  CurationItem,
  CurationDecisionValue,
  MeaningCollision as MeaningCollisionValue,
} from '../../api';

/**
 * The weekly batch: one card, one question, three buttons.
 *
 * Fifteen seconds a card is what makes a fifteen-minute budget real, so the
 * card asks something answerable with yes or no and shows the citation beside
 * it — a bad question is then visible rather than silently promoted.
 *
 * One card at a time, deliberately. A list invites reading ahead and deciding
 * in bulk, which is how a review becomes a rubber stamp.
 */
export function ReviewView() {
  const { api, spaceId, openNote, refreshAll } = useApp();
  const t = useT();
  const [items, setItems] = useState<CurationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const refresh = useCallback(async () => {
    if (!spaceId) return;
    setLoading(true);
    try {
      setItems(await api.curationBatch(spaceId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, spaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const current = items[0];

  async function decide(decision: CurationDecisionValue, why?: string) {
    if (!current) return;
    setBusy(true);
    try {
      await api.decideCuration(current.id, decision, why);
      // Drop the answered card locally instead of re-reading: the next one
      // has to appear instantly, or the fifteen seconds go to waiting.
      setItems((rest) => rest.slice(1));
      setRejecting(false);
      setReason('');
      setError(null);
      if (decision !== 'reassigned') await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function build() {
    if (!spaceId) return;
    setBusy(true);
    try {
      await api.buildCurationBatch(spaceId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ViewShell title={t('review.title')} count={items.length}>
      <Collisions />
      {error && (
        <p role="alert" className="text-[11px] text-danger-ink px-2 py-1">
          {error}
        </p>
      )}

      {loading ? (
        <Empty>…</Empty>
      ) : !current ? (
        <>
          <Empty>{t('review.empty')}</Empty>
          <div className="px-2">
            <Button size="sm" disabled={busy} onClick={() => void build()}>
              {t('review.build')}
            </Button>
          </div>
        </>
      ) : (
        <div data-testid="review-card" className="border border-line rounded-md p-3 m-1">
          <p className="text-sm text-ink mb-2">{current.question}</p>

          <blockquote className="text-sm text-ink border-l-2 border-brand pl-2 mb-2 break-words">
            «{current.citation}»
          </blockquote>

          <button
            onClick={() => openNote(current.noteId)}
            className="text-[11px] text-ink-muted hover:text-ink underline block mb-1"
          >
            {current.title}
            {current.sourceLine !== null && ` · ${t('review.line', { line: current.sourceLine })}`}
          </button>

          <p className="text-[11px] text-ink-muted mb-3">
            {t('review.usedTimes', { n: current.useCount })} · {t('review.neverSigned')}
          </p>

          {rejecting ? (
            <div className="flex flex-col gap-1.5">
              {/* A rejection carries its reason: an owner must not be able to
                  drop something in silence, and the API refuses one without. */}
              <input
                aria-label={t('review.reason')}
                placeholder={t('review.reason')}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="text-xs bg-bg border border-line rounded px-1.5 py-1 text-ink"
              />
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  disabled={busy || !reason.trim()}
                  onClick={() => void decide('rejected', reason)}
                >
                  {t('review.reject')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
                  {t('dialog.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" disabled={busy} onClick={() => void decide('confirmed')}>
                {t('review.holds')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('superseded')}>
                {t('review.changed')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('reassigned')}>
                {t('review.notMine')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(true)}>
                {t('review.rejectOpen')}
              </Button>
            </div>
          )}

          <p className="text-[11px] text-ink-muted mt-2 text-right">
            {t('review.position', { n: 1, total: items.length })}
          </p>
        </div>
      )}
    </ViewShell>
  );
}

/**
 * Words doing two jobs (Company Brain §9), above the batch.
 *
 * Above, because it is a different kind of question: a card asks "does this
 * still hold", and this asks "are we even talking about the same thing". The
 * second one invalidates the first, so seeing it after answering ten cards is
 * seeing it too late.
 *
 * Renders nothing when there are none, which is the normal state.
 */
function Collisions() {
  const { api, spaceId, openNote } = useApp();
  const t = useT();
  const [found, setFound] = useState<MeaningCollisionValue[]>([]);

  useEffect(() => {
    if (!spaceId) return;
    let alive = true;
    api
      .collisions(spaceId)
      .then((c) => alive && setFound(c))
      // A detector being down is not a reason to break the review.
      .catch(() => alive && setFound([]));
    return () => {
      alive = false;
    };
  }, [api, spaceId]);

  if (found.length === 0) return null;

  return (
    <div data-testid="collisions" className="border border-amber-500/40 rounded-md p-3 m-1">
      <div className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-yellow-300/90 mb-1">
        ⚠ {t('review.collisions')}
      </div>
      <ul className="text-xs space-y-2">
        {found.slice(0, 5).map((c) => (
          <li key={`${c.key}-${c.a.noteId}-${c.b.noteId}`}>
            <div className="text-ink mb-0.5">
              «{c.key}» {t('review.collisionMeans')}
            </div>
            {[c.a, c.b].map((side) => (
              <button
                key={side.noteId}
                onClick={() => openNote(side.noteId)}
                className="block text-left text-ink-muted hover:text-ink underline"
              >
                {side.value} — {side.title}:{side.line}
              </button>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
