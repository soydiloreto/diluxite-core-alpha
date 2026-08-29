import type { Freshness } from '../../api';
import { useT } from '../../i18n';

/**
 * How this note is ageing, judged against its OWN measured rhythm (ADR-002).
 *
 * Renders NOTHING when the note is fresh, or when no cadence was measured at
 * all. Both silences are deliberate:
 *
 *  - A badge on every note is one nobody reads, which costs exactly the notes
 *    where it mattered. The signal only works if it is rare.
 *  - An absent `freshness` means the deployment measures no cadence. That is
 *    not "fresh", and showing a reassuring badge for it would be the system
 *    claiming something it never checked.
 *
 * The wording keeps evidence and guess apart: a note with a measured rhythm
 * says what that rhythm is, and one without says it has none yet rather than
 * borrowing the confidence of a number it does not have.
 */
export function FreshnessBadge({ freshness }: { freshness?: Freshness }) {
  const t = useT();
  if (!freshness || freshness.level === 'fresh') return null;

  const days = Math.round(freshness.ageSeconds / 86_400);
  const typical = Math.round(freshness.expectedIntervalSeconds / 86_400);
  const stale = freshness.level === 'stale';

  const label = freshness.usingPrior
    ? t(stale ? 'freshness.stalePrior' : 'freshness.agingPrior')
    : t(stale ? 'freshness.stale' : 'freshness.aging');

  const detail = freshness.usingPrior
    ? t('freshness.detailPrior', { days })
    : t('freshness.detailMeasured', { days, typical });

  return (
    <span
      data-testid="freshness-badge"
      title={`${label} — ${detail}`}
      className={`text-[10px] mr-1 whitespace-nowrap ${
        stale ? 'text-amber-500' : 'text-ink-muted'
      }`}
    >
      ⚠ {detail}
    </span>
  );
}
