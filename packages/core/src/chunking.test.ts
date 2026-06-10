import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from './chunking';

// Contador determinista por palabras para que los tests sean claros.
const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const opts = {
  maxTokens: 8,
  overlapTokens: 2,
  shortNoteThreshold: 8,
  countTokens: words,
};

describe('chunkMarkdown', () => {
  it('texto vacío => sin chunks', () => {
    expect(chunkMarkdown('', opts)).toEqual([]);
    expect(chunkMarkdown('   \n  ', opts)).toEqual([]);
  });

  it('nota corta (<= umbral) => un solo chunk con la nota entera', () => {
    const r = chunkMarkdown('hola mundo', opts);
    expect(r).toEqual([{ text: 'hola mundo', index: 0 }]);
  });

  it('nota larga se parte por headings (heading-aware)', () => {
    const md = '# A\n\nuno dos tres\n\n# B\n\ncuatro cinco seis';
    const r = chunkMarkdown(md, opts);
    expect(r.length).toBe(2);
    expect(r[0].text.startsWith('# A')).toBe(true);
    expect(r[0].text).toContain('uno dos tres');
    expect(r[1].text.startsWith('# B')).toBe(true);
    expect(r[1].text).toContain('cuatro cinco seis');
    expect(r.map((c) => c.index)).toEqual([0, 1]);
  });

  it('una sección larga se parte en ventanas con overlap', () => {
    const md = '# T\n\na b c d e f g h i j';
    const r = chunkMarkdown(md, opts);
    expect(r.length).toBeGreaterThanOrEqual(2);
    // ningún chunk supera maxTokens
    for (const c of r) expect(words(c.text)).toBeLessThanOrEqual(opts.maxTokens);
    // cada chunk de la sección arranca con el heading (contexto)
    for (const c of r) expect(c.text.startsWith('# T')).toBe(true);
    // hay overlap: el contenido se solapa entre chunks consecutivos
    const body0 = r[0].text.replace('# T', '').trim().split(/\s+/);
    const body1 = r[1].text.replace('# T', '').trim().split(/\s+/);
    expect(body1.some((w) => body0.includes(w))).toBe(true);
    // no se pierde contenido: todas las letras aparecen en algún chunk
    const all = r.map((c) => c.text).join(' ');
    for (const w of 'a b c d e f g h i j'.split(' ')) expect(all).toContain(w);
  });

  it('overlap >= budget se clampea: chunks acotados, sin arrastre acumulativo', () => {
    // Sin clamp, cada ventana sembraría con TODA la anterior y los chunks
    // crecerían monotónicamente arrastrando todo lo previo.
    const md = 'a b c d e f g h i j';
    const r = chunkMarkdown(md, {
      maxTokens: 3,
      overlapTokens: 64,
      shortNoteThreshold: 1,
      countTokens: words,
    });
    // Cantidad acotada: 10 átomos con paso efectivo >= budget - floor(budget/2).
    expect(r.length).toBeLessThanOrEqual(6);
    // Ningún chunk supera el budget (el bug producía ventanas crecientes).
    for (const c of r) expect(words(c.text)).toBeLessThanOrEqual(3);
    // No se pierde contenido.
    const all = r.map((c) => c.text).join(' ');
    for (const w of md.split(' ')) expect(all).toContain(w);
  });

  it('un heading dentro de un code fence NO parte una sección', () => {
    // El `# no-heading` vive dentro del fence: no debe arrancar una sección.
    // Sin el fix, splitByHeadings vería dos headings => dos secciones.
    const md = '# A\n\nuno dos\n\n```\n# no-heading\nx y\n```\n\ntres';
    // maxTokens alto para aislar el comportamiento de split-by-heading.
    const r = chunkMarkdown(md, { ...opts, maxTokens: 100, shortNoteThreshold: 1 });
    // Una sola sección (heading "# A"); el fence no la parte.
    expect(r.length).toBe(1);
    expect(r[0].text.startsWith('# A')).toBe(true);
    // El contenido del fence se preserva tal cual (incluido el `#`).
    expect(r[0].text).toContain('# no-heading');
  });

  it('usa defaults razonables (char/4) sin opciones', () => {
    // ~2000 chars => > 400 tokens default => se parte en varios chunks
    const long = 'palabra '.repeat(400); // 3200 chars aprox
    const r = chunkMarkdown(long);
    expect(r.length).toBeGreaterThan(1);
  });
});
