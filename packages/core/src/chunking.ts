export interface Chunk {
  text: string;
  index: number;
}

export interface ChunkOptions {
  /** Tope de tokens por chunk (default 512). */
  maxTokens?: number;
  /** Tokens de solapamiento entre chunks consecutivos (default 64). */
  overlapTokens?: number;
  /** Si la nota entera entra en este tope, va como un único chunk (default 400). */
  shortNoteThreshold?: number;
  /** Estimador de tokens. Default ≈ chars/4 (proxy razonable para OpenAI). */
  countTokens?: (s: string) => number;
}

const DEFAULTS = {
  maxTokens: 512,
  overlapTokens: 64,
  shortNoteThreshold: 400,
  countTokens: (s: string) => Math.ceil(s.length / 4),
};

interface Section {
  heading?: string;
  body: string;
}

const HEADING_RE = /^#{1,6}\s+\S/;

function splitByHeadings(md: string): Section[] {
  const lines = md.split('\n');
  const sections: { heading?: string; body: string[] }[] = [];
  let cur: { heading?: string; body: string[] } = { heading: undefined, body: [] };
  const hasContent = (s: typeof cur) => s.heading !== undefined || s.body.some((b) => b.trim());

  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      if (hasContent(cur)) sections.push(cur);
      cur = { heading: line.trim(), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (hasContent(cur)) sections.push(cur);

  return sections.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() }));
}

/** Parte el cuerpo en piezas atómicas, cada una <= budget. */
function atomize(body: string, budget: number, count: (s: string) => number): string[] {
  const atoms: string[] = [];
  for (const para of body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (count(para) <= budget) {
      atoms.push(para);
      continue;
    }
    for (const sentence of para.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)) {
      if (count(sentence) <= budget) {
        atoms.push(sentence);
        continue;
      }
      // Frase gigante: cortar por palabras (atómico) para permitir overlap.
      for (const w of sentence.split(/\s+/).filter(Boolean)) atoms.push(w);
    }
  }
  return atoms;
}

/** Empaqueta piezas en ventanas <= budget, arrastrando overlap de la anterior. */
function packWithOverlap(
  pieces: string[],
  budget: number,
  overlap: number,
  count: (s: string) => number,
): string[] {
  const windows: string[][] = [];
  let cur: string[] = [];
  let curTok = 0;

  for (const piece of pieces) {
    const t = count(piece);
    if (curTok + t > budget && cur.length > 0) {
      windows.push(cur);
      // Sembrar la próxima ventana con la cola de la actual (~overlap tokens).
      const tail: string[] = [];
      let tailTok = 0;
      for (let i = cur.length - 1; i >= 0; i--) {
        const tt = count(cur[i]);
        if (tailTok + tt > overlap) break;
        tail.unshift(cur[i]);
        tailTok += tt;
      }
      cur = [...tail];
      curTok = tailTok;
    }
    cur.push(piece);
    curTok += t;
  }
  if (cur.length) windows.push(cur);
  return windows.map((w) => w.join(' '));
}

/**
 * Chunking heading-aware (PRD §8):
 * - Notas cortas: un único chunk con la nota entera.
 * - Notas largas: se parten por headings; cada sección, si excede maxTokens,
 *   se divide en ventanas con overlap. El heading se antepone a cada chunk
 *   de la sección para conservar contexto.
 */
export function chunkMarkdown(md: string, options?: ChunkOptions): Chunk[] {
  const { maxTokens, overlapTokens, shortNoteThreshold, countTokens } = {
    ...DEFAULTS,
    ...options,
  };

  if (!md.trim()) return [];
  if (countTokens(md) <= shortNoteThreshold) return [{ text: md.trim(), index: 0 }];

  const texts: string[] = [];
  for (const section of splitByHeadings(md)) {
    const prefix = section.heading ? `${section.heading}\n\n` : '';
    const whole = prefix + section.body;

    if (countTokens(whole) <= maxTokens) {
      if (whole.trim()) texts.push(whole.trim());
      continue;
    }

    const headingTokens = section.heading ? countTokens(`${section.heading}\n\n`) : 0;
    const contentBudget = Math.max(1, maxTokens - headingTokens);
    const atoms = atomize(section.body, contentBudget, countTokens);
    for (const window of packWithOverlap(atoms, contentBudget, overlapTokens, countTokens)) {
      texts.push((prefix + window).trim());
    }
  }

  return texts.map((text, index) => ({ text, index }));
}
