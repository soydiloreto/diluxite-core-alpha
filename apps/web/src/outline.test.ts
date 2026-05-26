import { describe, it, expect } from 'vitest';
import { parseHeadings } from './outline';

describe('parseHeadings', () => {
  it('extrae headings con nivel y texto', () => {
    const md = '# Uno\n\ntexto\n\n## Dos\n\n### Tres\nx';
    expect(parseHeadings(md)).toEqual([
      { level: 1, text: 'Uno' },
      { level: 2, text: 'Dos' },
      { level: 3, text: 'Tres' },
    ]);
  });

  it('texto sin headings => []', () => {
    expect(parseHeadings('solo texto sin headings')).toEqual([]);
  });
});
