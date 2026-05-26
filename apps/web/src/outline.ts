export interface Heading {
  level: number;
  text: string;
}

/** Extrae los headings Markdown (`# …`) en orden. */
export function parseHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  for (const line of md.split('\n')) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}
