import {
  ageInWords,
  hostAllowed,
  parseResolvers,
  resolveValue,
  type ResolverSpec,
} from '@diluxite/core';
import type { AppDeps } from './app';

/**
 * Live state, resolved at query time — ADR-001 step 3.
 *
 * A note declares where to ask; this asks, caches, and — the rule the whole
 * step exists for — **never returns a value without the date it was true**.
 * When the source is unreachable the last known value is served WITH ITS AGE,
 * because "MRR 42k (12 minutes ago)" is something you say out loud and "MRR
 * 42k (March)" is something you go check.
 */

export interface LiveValue {
  noteId: string;
  noteTitle: string;
  name: string;
  /** Null when nothing was ever fetched successfully — then `error` says why. */
  value: string | null;
  /** When the value was true. Null when there is no value. */
  fetchedAt: Date | null;
  /** Set when the last attempt failed, even if an older value is being shown. */
  error: string | null;
  /** True when this answer came from the source just now. */
  fresh: boolean;
}

/**
 * A search must not wait on somebody else's dashboard.
 *
 * Shorter than the resolver's own timeout on purpose: a source that is merely
 * slow gets served from cache, with its age, which is a good answer. Only a
 * source nobody has ever reached produces "I don't know".
 */
export const LIVE_QUERY_BUDGET_MS = 2_000;

/**
 * Resolve the live values declared by a set of notes.
 *
 * Bounded by the notes handed in — the ones a search actually returned — so
 * the cost is a function of topK, never of the corpus. Parsed from the
 * markdown rather than from a table: the note is the single source of truth
 * for what it declares, exactly as it is for tags, links and facts.
 */
export async function liveValuesFor(
  deps: AppDeps,
  spaceId: string,
  noteIds: string[],
  opts: { now?: () => Date; budgetMs?: number } = {},
): Promise<LiveValue[]> {
  if (!deps.resolvers || noteIds.length === 0) return [];
  const now = opts.now ?? (() => new Date());

  const notes = (await Promise.all(noteIds.map((id) => deps.notes.get(id)))).filter(
    (n): n is NonNullable<typeof n> => !!n,
  );
  const declared: { noteId: string; title: string; spec: ResolverSpec }[] = [];
  for (const note of notes) {
    for (const spec of parseResolvers(note.contentMd).resolvers) {
      declared.push({ noteId: note.id, title: note.title, spec });
    }
  }
  if (declared.length === 0) return [];

  const cached = await deps.resolvers.cachedFor(declared.map((d) => d.noteId));
  const space = await deps.spaces.findById(spaceId);
  // No organisation means no allowlist to consult, which means nothing is
  // called. Refusing is the only safe reading of "we cannot tell".
  const allowed = space ? await deps.resolvers.allowedHosts(space.orgId) : [];

  const out: LiveValue[] = [];
  const deadline = now().getTime() + (opts.budgetMs ?? LIVE_QUERY_BUDGET_MS);

  await Promise.all(
    declared.map(async ({ noteId, title, spec }) => {
      const prior = (cached.get(noteId) ?? []).find((c: { name: string }) => c.name === spec.name);
      const fresh =
        prior?.fetchedAt && now().getTime() - prior.fetchedAt.getTime() < spec.ttlSeconds * 1000;

      if (fresh) {
        out.push({
          noteId,
          noteTitle: title,
          name: spec.name,
          value: prior!.value,
          fetchedAt: prior!.fetchedAt,
          error: null,
          fresh: true,
        });
        return;
      }

      const push = (error: string) =>
        out.push({
          noteId,
          noteTitle: title,
          name: spec.name,
          value: prior?.value ?? null,
          fetchedAt: prior?.fetchedAt ?? null,
          error,
          fresh: false,
        });

      // The allowlist is the trust boundary. A note that names a host nobody
      // allowed is not an error in the note — it is a decision the operator
      // has not made — so it says exactly that.
      if (!hostAllowed(spec.url, allowed)) {
        push('host is not on the allowlist');
        return;
      }
      if (now().getTime() > deadline) {
        // Out of budget: serve what is known, with its age. A slow dashboard
        // must not become a slow search.
        push('not refreshed in time');
        return;
      }

      const entry = space ? await deps.resolvers!.entryForHost(space.orgId, new URL(spec.url).host) : null;
      const token = entry?.tokenSealed ? deps.openSecret?.(entry.tokenSealed) : null;
      const outcome = await resolveValue(spec, {
        token,
        timeoutMs: Math.max(200, deadline - now().getTime()),
      });
      await deps.resolvers!.record(noteId, spaceId, spec.name, outcome, now());
      // Self-healing: a resolver renamed in the note leaves a cached row under
      // the old name that nothing will ever read again. Pruned on refetch —
      // once per TTL, not once per query.
      await deps.resolvers!.prune(
        noteId,
        declared.filter((d) => d.noteId === noteId).map((d) => d.spec.name),
      );

      if (outcome.ok) {
        out.push({
          noteId,
          noteTitle: title,
          name: spec.name,
          value: outcome.value,
          fetchedAt: now(),
          error: null,
          fresh: true,
        });
      } else {
        push(outcome.error);
      }
    }),
  );

  return out;
}

/**
 * The block that goes ABOVE the prose, in the words a person reads.
 *
 * Composed, never fused into the ranking — the same reason facts are not: a
 * live value either resolved or it did not, and averaging that into a
 * relevance score throws away the one signal that separates it from an
 * opinion about the topic.
 */
export function liveBlock(values: LiveValue[], now: Date = new Date()): string | null {
  if (values.length === 0) return null;
  const lines = values.map((v) => {
    const where = ` — ${v.noteTitle}`;
    if (v.value === null) {
      // Saying "I don't know" is a feature. A second brain that always answers
      // is one you cannot trust on any single answer.
      return `• ${v.name}: unknown (${v.error ?? 'never reached'})${where}`;
    }
    const age = v.fetchedAt ? ageInWords(v.fetchedAt, now) : 'unknown age';
    const stale = v.error ? ` · could not refresh: ${v.error}` : '';
    return `• ${v.name}: ${v.value} (${age})${stale}${where}`;
  });
  return `LIVE (resolved now, from the source):\n${lines.join('\n')}`;
}
