import { isCollision, type MeaningCollision } from '@diluxite/core';
import type { AppDeps } from './app';

/**
 * Find the words doing two jobs — "Company Brain — modo funcional" §9.
 *
 * The expensive failure is not the disagreement everybody knows about. It is
 * two areas using the same word for two different things without knowing, and
 * two reports that then do not reconcile. Nobody is wrong; the word is.
 *
 * The check is cheap because it starts from the vocabulary, not the corpus: a
 * space has far fewer distinct keys than notes, and only the ones stated by
 * more than one note can collide at all.
 */
export async function collisionsIn(
  deps: AppDeps,
  spaceId: string,
  opts: { maxKeys?: number; maxPairsPerKey?: number } = {},
): Promise<MeaningCollision[]> {
  if (!deps.facts?.keysStatedBySeveralNotes || !deps.search?.distanceBetween) return [];

  const keys = await deps.facts.keysStatedBySeveralNotes(spaceId, opts.maxKeys ?? 200);
  const out: MeaningCollision[] = [];

  for (const key of keys) {
    const hits = await deps.facts.lookup(spaceId, key);
    // One row per note: a table that states a key twice is a different
    // problem, and comparing a note against itself finds nothing.
    const byNote = new Map<string, (typeof hits)[number]>();
    for (const h of hits) if (!byNote.has(h.noteId)) byNote.set(h.noteId, h);
    const rows = [...byNote.values()];
    if (rows.length < 2) continue;

    // Bounded: the pairs of a key grow quadratically, and a key stated by
    // twenty notes is a glossary, not a collision.
    const cap = opts.maxPairsPerKey ?? 10;
    let pairs = 0;
    for (let i = 0; i < rows.length && pairs < cap; i++) {
      for (let j = i + 1; j < rows.length && pairs < cap; j++) {
        pairs++;
        const a = rows[i];
        const b = rows[j];
        const distance = await deps.search.distanceBetween(spaceId, a.noteId, b.noteId);
        if (!isCollision(distance, a.value, b.value)) continue;
        const [noteA, noteB] = await Promise.all([
          deps.notes.get(a.noteId),
          deps.notes.get(b.noteId),
        ]);
        out.push({
          key,
          a: { noteId: a.noteId, title: noteA?.title ?? '', value: a.value, line: a.sourceLine },
          b: { noteId: b.noteId, title: noteB?.title ?? '', value: b.value, line: b.sourceLine },
          distance: distance!,
          valuesDiffer: true,
        });
      }
    }
  }

  // Furthest apart first: the further two notes are while sharing a word, the
  // more likely the word is the problem rather than the topic.
  return out.sort((x, y) => y.distance - x.distance);
}
