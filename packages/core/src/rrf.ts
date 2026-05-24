export interface FusedItem {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion (PRD §7.4): fusiona varias listas ya rankeadas
 * (keyword + vectorial) en un único ranking. score = Σ 1/(k + rank).
 * `k` amortigua el peso de las primeras posiciones (default 60, estándar).
 */
export function reciprocalRankFusion(lists: string[][], k = 60): FusedItem[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
