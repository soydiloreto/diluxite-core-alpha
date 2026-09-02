import type { AppDeps } from './app';

/**
 * "What did we believe in March?" — ADR-001 step 3b.
 *
 * The question that arrives AFTER a decision goes wrong, and the reason
 * ADR-002 stores two timelines instead of one. Answering "what is true now" is
 * the easy half; this is the other one.
 *
 * Two sources, and they answer different halves:
 *   - what the note SAID  → the version history (migration 0023)
 *   - whether it was HELD → the validity window (migration 0024)
 *
 * The limit is stated rather than hidden: history is a bounded safety net, not
 * an archive, so a moment older than the oldest snapshot answers "I cannot see
 * that far back" instead of handing over today's text dressed as the past.
 * That distinction is the whole point of the feature.
 */

export interface AsOfAnswer {
  noteId: string;
  at: string;
  /** The text that was live then. Null when history does not reach that far. */
  contentMd: string | null;
  title: string;
  /** How the note was standing at that moment. */
  standing: 'held' | 'not-yet-written' | 'superseded' | 'expired' | 'unknown';
  /** When the window closed, when it had. */
  supersededAt: string | null;
  /** True when the content is the note's current text (nothing saved since). */
  current: boolean;
  /** How far back the history actually goes, so the limit is visible. */
  historyReachesBackTo: string | null;
}

export async function noteAsOf(
  deps: AppDeps,
  noteId: string,
  at: Date,
): Promise<AsOfAnswer | null> {
  const note = await deps.notes.get(noteId);
  if (!note) return null;

  const versions = deps.noteVersions;
  const snapshot = versions?.contentAsOf ? await versions.contentAsOf(noteId, at) : null;
  const reach = versions?.historyReach
    ? await versions.historyReach(noteId)
    : { oldest: null, truncated: false };

  // Whether the moment is answerable at all turns on ONE thing: did the
  // per-note cap drop snapshots older than it?
  //
  // If it did, the oldest snapshot we still have already contains edits made
  // between the moment asked about and it — so quoting it would be inventing
  // the past, which is the failure this feature exists to avoid. If it did
  // not, everything is answerable: either a snapshot after the moment holds
  // the text that was live, or nothing was saved since and the current text is
  // it.
  const beyondReach = reach.truncated && !!reach.oldest && reach.oldest.getTime() > at.getTime();
  const contentMd = beyondReach ? null : (snapshot?.contentMd ?? note.contentMd);

  const prov = deps.provenance ? await deps.provenance.get('note', noteId) : null;
  let standing: AsOfAnswer['standing'] = 'unknown';
  let supersededAt: string | null = null;
  if (prov) {
    supersededAt = prov.validTo ? prov.validTo.toISOString() : null;
    if (prov.validFrom.getTime() > at.getTime()) standing = 'not-yet-written';
    else if (prov.validTo && prov.validTo.getTime() <= at.getTime())
      standing = prov.rank === 'deprecated' ? 'superseded' : 'expired';
    else standing = 'held';
  }

  return {
    noteId,
    at: at.toISOString(),
    contentMd,
    title: snapshot ? snapshot.title : note.title,
    standing,
    supersededAt,
    current: !snapshot && contentMd !== null,
    historyReachesBackTo: reach.oldest ? reach.oldest.toISOString() : null,
  };
}

/** The answer in the words a model or a person reads. */
export function asOfBlock(a: AsOfAnswer): string {
  const when = a.at.slice(0, 10);
  if (a.standing === 'not-yet-written') return `On ${when} this note did not exist yet.`;
  if (a.contentMd === null) {
    const back = a.historyReachesBackTo?.slice(0, 10);
    // Saying "I cannot see that far back" beats handing over today's text as
    // if it were the past, which is the failure this whole feature avoids.
    return `I cannot see back to ${when} — the history of this note only reaches ${back}.`;
  }
  const standing =
    a.standing === 'superseded'
      ? `It had already been marked as no longer true (on ${a.supersededAt?.slice(0, 10)}).`
      : a.standing === 'expired'
        ? `It had already expired (on ${a.supersededAt?.slice(0, 10)}).`
        : a.standing === 'held'
          ? 'It was held as current then.'
          : '';
  const freshness = a.current ? ' (unchanged since)' : '';
  return [`# ${a.title} — as of ${when}${freshness}`, standing, '', a.contentMd]
    .filter(Boolean)
    .join('\n');
}
