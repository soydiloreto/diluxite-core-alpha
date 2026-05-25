// Un tag arranca con # seguido de una letra (así "# Título" de markdown NO es tag),
// precedido por inicio, espacio o paréntesis (evita matchear dentro de palabras/URLs).
const TAG_RE = /(?:^|[\s(])#(\p{L}[\p{L}\p{N}_/-]*)/gu;

/** Extrae los tags `#tag` de un texto, únicos (case-insensitive), preservando el primero. */
export function parseTags(md: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of md.matchAll(TAG_RE)) {
    const tag = m[1];
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}
