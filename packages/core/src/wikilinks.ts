import { maskCodeSpans } from './code-spans';

export interface WikiLink {
  /** Nota destino, sin corchetes y recortada. */
  target: string;
  /** Texto alternativo tras `|`, si existe. */
  alias?: string;
  /** Coincidencia original completa, incluidos los corchetes. */
  raw: string;
}

// [[ ... ]] no codicioso; el contenido no puede tener corchetes.
const WIKILINK_RE = /\[\[([^[\]]+?)\]\]/g;

/** Extrae los wikilinks `[[Nota]]` / `[[Nota|alias]]` en orden de aparición. */
export function parseWikilinks(markdown: string): WikiLink[] {
  const out: WikiLink[] = [];
  // Match against the code-masked text so `[[Link]]` inside a fence/inline code
  // isn't parsed as a wikilink. Masking preserves offsets, so `raw` is sliced
  // from the original markdown at the same index.
  const masked = maskCodeSpans(markdown);
  for (const m of masked.matchAll(WIKILINK_RE)) {
    const inner = m[1];
    const sep = inner.indexOf('|');
    const target = (sep === -1 ? inner : inner.slice(0, sep)).trim();
    if (!target) continue; // ignora [[]] y [[   ]]
    const aliasRaw = sep === -1 ? '' : inner.slice(sep + 1).trim();
    out.push({ target, alias: aliasRaw || undefined, raw: markdown.slice(m.index, m.index + m[0].length) });
  }
  return out;
}

/** Targets únicos (case-sensitive) preservando el orden de aparición. */
export function uniqueTargets(markdown: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { target } of parseWikilinks(markdown)) {
    if (!seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}
