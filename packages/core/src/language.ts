import { maskCodeSpans } from './code-spans';

/**
 * Which language a note is written in, so the lexical channel can index it
 * with a stemmer that speaks it.
 *
 * Postgres full-text search is per-configuration: `to_tsvector('spanish', …)`
 * applied to an English note keeps "the" and "and" as index terms and never
 * collapses "backups" to "backup", so a search for the singular does not find
 * the plural. The evaluation measures exactly that (three inflections out of
 * three lost per language, `apps/api/src/search-eval.integration.test.ts`).
 *
 * Four languages, not a general-purpose detector: es, en, pt and it are what
 * this vault is written in, and each one Postgres ships a Snowball
 * configuration for. A fifth costs one word list and one line here.
 *
 * Deliberately NOT a dependency. `franc` and friends carry trigram models for
 * 180 languages to decide between four, and the supply chain of the published
 * image is the thing this repository is most careful about. Function words are
 * what separate these four in practice, and the test suite is the evidence.
 */
export type ContentLanguage = 'es' | 'en' | 'pt' | 'it';

/** The Postgres text-search configuration each language is indexed with. */
export const FTS_CONFIG: Record<ContentLanguage, string> = {
  es: 'spanish',
  en: 'english',
  pt: 'portuguese',
  it: 'italian',
};

/** Every configuration the lexical channel may have to query. */
export const FTS_CONFIGS: string[] = Object.values(FTS_CONFIG);

/**
 * When detection cannot tell, this is what a note gets.
 *
 * Spanish, because that is what every note written before this existed was
 * indexed as: an inconclusive note keeps behaving exactly as it did, and the
 * change can only improve a note it recognises.
 */
export const DEFAULT_LANGUAGE: ContentLanguage = 'es';

/**
 * Function words, by language.
 *
 * Content words are useless here — "docker", "backup" and "pgvector" are the
 * same in all four. What separates the languages is the glue: articles,
 * prepositions, auxiliaries. A word shared by several languages (`de`, `la`,
 * `che`) still votes, but its vote splits between them, so a text only wins
 * on the words that are actually its own.
 */
const FUNCTION_WORDS: Record<ContentLanguage, string[]> = {
  es: [
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'que', 'y', 'en',
    'con', 'por', 'para', 'se', 'no', 'es', 'son', 'más', 'pero', 'como', 'cuando', 'donde',
    'esto', 'esta', 'este', 'todo', 'toda', 'cada', 'sin', 'sobre', 'hay', 'ser', 'está',
    'están', 'tiene', 'tienen', 'puede', 'pueden', 'así', 'después', 'entre', 'desde', 'hasta',
    'su', 'sus', 'lo', 'le', 'les', 'ya', 'muy', 'también', 'porque', 'mismo', 'misma',
  ],
  en: [
    'the', 'and', 'of', 'to', 'in', 'is', 'are', 'that', 'this', 'these', 'those', 'with', 'for',
    'on', 'it', 'as', 'by', 'from', 'be', 'was', 'were', 'can', 'will', 'not', 'but', 'they',
    'you', 'what', 'when', 'where', 'which', 'there', 'their', 'has', 'have', 'had', 'does',
    'do', 'at', 'an', 'a', 'or', 'if', 'so', 'than', 'then', 'each', 'every', 'both', 'about',
    'into', 'over', 'after', 'before', 'once', 'same', 'other', 'without',
  ],
  pt: [
    'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das', 'no', 'na',
    'nos', 'nas', 'ao', 'à', 'que', 'e', 'em', 'com', 'por', 'para', 'se', 'não', 'é', 'são',
    'mais', 'mas', 'como', 'quando', 'onde', 'isso', 'esta', 'este', 'todo', 'toda', 'cada',
    'sem', 'sobre', 'há', 'ser', 'está', 'estão', 'tem', 'têm', 'pode', 'podem', 'assim',
    'depois', 'entre', 'desde', 'até', 'seu', 'sua', 'já', 'muito', 'também', 'porque', 'você',
    'mesmo', 'mesma', 'então',
  ],
  it: [
    'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'del', 'dello', 'della', 'dei',
    'degli', 'delle', 'al', 'allo', 'alla', 'nel', 'nello', 'nella', 'sul', 'sulla', 'che', 'e',
    'in', 'con', 'per', 'da', 'si', 'non', 'è', 'sono', 'più', 'ma', 'come', 'quando', 'dove',
    'questo', 'questa', 'tutto', 'tutta', 'ogni', 'senza', 'su', 'essere', 'ha', 'hanno', 'può',
    'possono', 'così', 'dopo', 'tra', 'fra', 'anche', 'quindi', 'suo', 'sua', 'già', 'molto',
    'perché', 'stesso', 'stessa',
  ],
};

/** word → the languages that use it, so a shared word splits its vote. */
const OWNERS = new Map<string, ContentLanguage[]>();
for (const [lang, words] of Object.entries(FUNCTION_WORDS) as [ContentLanguage, string[]][]) {
  for (const w of words) {
    const owners = OWNERS.get(w);
    if (owners) owners.push(lang);
    else OWNERS.set(w, [lang]);
  }
}

/**
 * Orthography that belongs to exactly one of the four.
 *
 * Worth a vote each because a note can be short on function words and still
 * be unmistakable: "ação", "ñ" and "gli" each appear in one language of this
 * set and nowhere else in it.
 */
const ORTHOGRAPHY: { lang: ContentLanguage; re: RegExp; weight: number }[] = [
  { lang: 'es', re: /ñ/g, weight: 2 },
  { lang: 'es', re: /[¿¡]/g, weight: 2 },
  { lang: 'pt', re: /[ãõ]/g, weight: 2 },
  { lang: 'pt', re: /ç[ãõ]/g, weight: 1 },
  { lang: 'it', re: /\bgli\b|gli[aeou]/g, weight: 2 },
  { lang: 'it', re: /[èìòù]/g, weight: 2 },
];

/** Letters, digits and the accents these four use — everything else splits. */
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/**
 * How much stronger the winner has to be than the runner-up.
 *
 * Below this the two languages are explaining the text about equally well,
 * which for es/pt in particular happens on any text short enough to be all
 * shared words. Guessing there would index a note under a stemmer chosen by
 * a rounding error; the fallback is the honest answer.
 */
const MARGIN = 1.25;

/** Under this many votes there is nothing to tell apart. */
const MIN_SCORE = 1.5;

export interface LanguageGuess {
  language: ContentLanguage;
  /** False when the fallback was used because the text did not say enough. */
  confident: boolean;
  scores: Record<ContentLanguage, number>;
}

/**
 * URLs and e-mail addresses, which are not prose in any language.
 *
 * They vote anyway if you let them: `.com` is the Portuguese word for "with",
 * so a note whose only text is a link to `example.com` was being detected as
 * Portuguese, confidently.
 */
const LINKS_RE = /(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+/g;

/**
 * Score all four languages over a piece of markdown.
 *
 * Code is masked out first: a fenced block full of `for`, `if` and `return`
 * is a vote for English cast by a machine, and notes here are full of them.
 * Links go the same way, for the same reason.
 */
export function scoreLanguages(markdown: string): LanguageGuess {
  const text = maskCodeSpans(markdown).replace(LINKS_RE, ' ').toLowerCase();
  const scores: Record<ContentLanguage, number> = { es: 0, en: 0, pt: 0, it: 0 };

  for (const [token] of text.matchAll(TOKEN_RE)) {
    const owners = OWNERS.get(token);
    if (!owners) continue;
    const share = 1 / owners.length;
    for (const lang of owners) scores[lang] += share;
  }

  for (const { lang, re, weight } of ORTHOGRAPHY) {
    const hits = text.match(re)?.length ?? 0;
    if (hits > 0) scores[lang] += Math.min(hits, 3) * weight;
  }

  const ranked = (Object.entries(scores) as [ContentLanguage, number][]).sort(
    (a, b) => b[1] - a[1],
  );
  const [best, bestScore] = ranked[0];
  const runnerUp = ranked[1][1];
  const confident = bestScore >= MIN_SCORE && bestScore >= runnerUp * MARGIN;

  return { language: confident ? best : DEFAULT_LANGUAGE, confident, scores };
}

/** The language a note is written in, falling back when the text is mute. */
export function detectLanguage(markdown: string): ContentLanguage {
  return scoreLanguages(markdown).language;
}

/** The Postgres configuration a note's chunks should be indexed with. */
export function ftsConfigFor(markdown: string): string {
  return FTS_CONFIG[detectLanguage(markdown)];
}
