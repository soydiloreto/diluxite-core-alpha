import { describe, it, expect } from 'vitest';
import { parseWikilinks, uniqueTargets } from './wikilinks';

describe('parseWikilinks', () => {
  it('devuelve vacío cuando no hay links', () => {
    expect(parseWikilinks('texto sin links')).toEqual([]);
    expect(parseWikilinks('')).toEqual([]);
  });

  it('extrae un wikilink simple', () => {
    expect(parseWikilinks('mirá [[Ideas]] acá')).toEqual([
      { target: 'Ideas', alias: undefined, raw: '[[Ideas]]' },
    ]);
  });

  it('soporta alias [[Nota|alias]]', () => {
    expect(parseWikilinks('[[ConoSurTech|mi comunidad]]')).toEqual([
      { target: 'ConoSurTech', alias: 'mi comunidad', raw: '[[ConoSurTech|mi comunidad]]' },
    ]);
  });

  it('soporta targets con espacios y recorta whitespace', () => {
    expect(parseWikilinks('[[  Mi Nota  ]]')[0].target).toBe('Mi Nota');
    expect(parseWikilinks('[[ Nota | alias ]]')[0]).toEqual({
      target: 'Nota',
      alias: 'alias',
      raw: '[[ Nota | alias ]]',
    });
  });

  it('extrae varios links en orden', () => {
    const r = parseWikilinks('[[A]] y [[B|b]] y [[A]]');
    expect(r.map((l) => l.target)).toEqual(['A', 'B', 'A']);
  });

  it('ignora corchetes vacíos o malformados', () => {
    expect(parseWikilinks('[[]] [[   ]] [single] [[no cierra')).toEqual([]);
  });
});

describe('uniqueTargets', () => {
  it('devuelve targets únicos preservando orden y case', () => {
    expect(uniqueTargets('[[A]] [[b]] [[A]] [[B]]')).toEqual(['A', 'b', 'B']);
  });
});
