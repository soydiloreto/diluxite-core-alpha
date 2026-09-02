import { useCallback, useEffect, useState } from 'react';
import type { LiveValue, NoteValidity } from '../../api';
import { useApp } from '../AppContext';
import { useT } from '../../i18n';
import { Button } from '../../ui';

/**
 * ADR-002's three axes for one note, said as a sentence.
 *
 * Where it came from · since when it is valid, and until when · whether it
 * still stands · how fast it actually changes. Fields would be a form; the
 * point is that a person reads it in one pass and can act on it.
 *
 * And it is the ONLY place `valid_to` gets written by a human — the two
 * buttons are the doors ADR-002 shipped without.
 */
export function ValidityPanel({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const { api } = useApp();
  const t = useT();
  const [data, setData] = useState<NoteValidity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [expiry, setExpiry] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.noteValidity(noteId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, noteId]);

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

  if (error && !data) return <Shell onClose={onClose}><p className="text-danger-ink">{error}</p></Shell>;
  if (!data) return <Shell onClose={onClose}><p className="text-ink-muted">…</p></Shell>;

  const p = data.provenance;
  const superseded = p?.rank === 'deprecated';
  const days = (iso: string) => Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);

  return (
    <Shell onClose={onClose}>
      <dl className="text-xs leading-relaxed text-ink space-y-1.5">
        <Line label={t('validity.writtenBy')}>
          {p ? t(`validity.door.${p.agentKind}`) : '—'}
          {p && ` · ${t('validity.since', { days: days(p.validFrom) })}`}
        </Line>

        <Line label={t('validity.standing')}>
          {superseded
            ? t('validity.superseded')
            : data.expired
              ? t('validity.expired')
              : p?.validTo
                ? t('validity.expiresOn', { date: p.validTo.slice(0, 10) })
                : t('validity.holds')}
        </Line>

        <Line label={t('validity.signed')}>
          {p?.confirmedAt
            ? t('validity.signedOn', { date: p.confirmedAt.slice(0, 10) })
            : t('validity.neverSigned')}
        </Line>

        <Line label={t('validity.rhythm')}>
          {data.stats?.avgIntervalSeconds
            ? t('validity.rhythmMeasured', {
                typical: Math.round(data.stats.avgIntervalSeconds / 86_400),
                days: days(data.stats.lastChangedAt),
              })
            : t('validity.rhythmUnknown')}
        </Line>
      </dl>

      <LiveValues noteId={noteId} />

      {error && <p role="alert" className="text-[11px] text-danger-ink mt-2">{error}</p>}

      <div className="flex flex-wrap gap-1.5 mt-3">
        {superseded ? (
          <Button size="sm" disabled={busy} onClick={() => void run(() => api.reinstateNote(noteId))}>
            {t('validity.reinstate')}
          </Button>
        ) : (
          <>
            <Button size="sm" disabled={busy} onClick={() => void run(() => api.confirmNote(noteId))}>
              {t('validity.confirm')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => api.supersedeNote(noteId))}
            >
              {t('validity.supersede')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setExpiryOpen((v) => !v)}>
              {t('validity.setExpiry')}
            </Button>
          </>
        )}
      </div>

      {expiryOpen && !superseded && (
        <div className="flex items-center gap-1.5 mt-2">
          <input
            type="date"
            aria-label={t('validity.setExpiry')}
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="text-xs bg-bg border border-line rounded px-1.5 py-1 text-ink"
          />
          <Button
            size="sm"
            disabled={busy || !expiry}
            onClick={() =>
              void run(async () => {
                await api.setNoteValidTo(noteId, new Date(`${expiry}T00:00:00.000Z`).toISOString());
                setExpiryOpen(false);
              })
            }
          >
            {t('dialog.ok')}
          </Button>
          {p?.validTo && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => api.setNoteValidTo(noteId, null))}
            >
              {t('validity.clearExpiry')}
            </Button>
          )}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const t = useT();
  return (
    <div
      data-testid="validity-panel"
      className="border-t border-line bg-bg-surface px-3 py-2.5 shrink-0"
    >
      <div className="flex items-center mb-1.5">
        <span className="text-[11px] uppercase tracking-wider text-ink-muted flex-1">
          {t('validity.title')}
        </span>
        <button
          onClick={onClose}
          aria-label={t('editor.close')}
          className="text-[11px] text-ink-muted hover:text-ink"
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 min-w-0">
      <dt className="text-ink-muted shrink-0 w-28">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

/**
 * What this note's declared sources say right now — ADR-001 step 3.
 *
 * Renders nothing when the note declares none, which is almost every note.
 * Every value carries its age, and a value that could not be refreshed says
 * so: serving a cached number bare is the exact failure this lane exists to
 * prevent.
 */
function LiveValues({ noteId }: { noteId: string }) {
  const { api } = useApp();
  const t = useT();
  const [values, setValues] = useState<LiveValue[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .noteLiveValues(noteId)
      .then((v) => alive && setValues(v))
      // A dashboard being down is not a reason to break the panel.
      .catch(() => alive && setValues([]));
    return () => {
      alive = false;
    };
  }, [api, noteId]);

  if (!values || values.length === 0) return null;

  return (
    <div data-testid="live-values" className="mt-3 pt-2 border-t border-line">
      <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-1">
        {t('validity.live')}
      </div>
      <ul className="text-xs space-y-1">
        {values.map((v) => (
          <li key={v.name} className="flex gap-2 min-w-0">
            <span className="text-ink-muted shrink-0 w-28 truncate">{v.name}</span>
            <span className="min-w-0 flex-1">
              {v.value === null ? (
                <span className="text-ink-muted">
                  {t('validity.liveUnknown')} — {v.error}
                </span>
              ) : (
                <>
                  <span className="text-ink">{v.value}</span>{' '}
                  <span className="text-ink-muted">
                    ({ageOf(v.fetchedAt, t)})
                    {v.error ? ` · ${t('validity.liveStale')}` : ''}
                  </span>
                  {v.diverged && (
                    // Said out loud: a number that quietly stopped matching its
                    // source is the failure this lane exists to catch.
                    <div className="text-[11px] text-amber-700 dark:text-yellow-300/90 mt-0.5">
                      ⚠{' '}
                      {t('validity.liveDiverged', {
                        stored: v.diverged.storedValue,
                        line: v.diverged.sourceLine,
                      })}
                    </div>
                  )}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Age in words. The point is that "12 minutes" and "March" read differently. */
function ageOf(iso: string | null, t: (k: string, p?: Record<string, unknown>) => string): string {
  if (!iso) return t('validity.liveUnknownAge');
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return t('validity.liveSeconds', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('validity.liveMinutes', { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t('validity.liveHours', { n: h });
  return t('validity.liveDays', { n: Math.round(h / 24) });
}
