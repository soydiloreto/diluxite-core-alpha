import { describe, it, expect } from 'vitest';
import {
  clipLine,
  compileQuery,
  scanDocs,
  takeMatches,
  type ResultGroup,
  type SearchDoc,
} from './noteSearch';

const DOCS: SearchDoc[] = [
  { id: 'a', title: 'Alpha', contentMd: '# Alpha\nazure is the cloud\nazure again' },
  { id: 'b', title: 'Bravo', contentMd: 'nothing relevant' },
  { id: 'c', title: 'Charlie', contentMd: 'AZURE shouting' },
];

const PLAIN = { matchCase: false, wholeWord: false, regex: false };

function compiled(query: string, opts = PLAIN): RegExp {
  const c = compileQuery(query, opts);
  if (!c || !('re' in c)) throw new Error(`expected a regex for ${query}`);
  return c.re;
}

describe('compileQuery', () => {
  it('returns null for an empty query', () => {
    expect(compileQuery('', PLAIN)).toBeNull();
  });

  it('escapes the query unless regex mode is on', () => {
    expect(compiled('a.c').test('abc')).toBe(false);
    expect(compiled('a.c', { ...PLAIN, regex: true }).test('abc')).toBe(true);
  });

  it('anchors to word boundaries when whole word is on', () => {
    expect(compiled('lake', { ...PLAIN, wholeWord: true }).test('lakes')).toBe(false);
    expect(compiled('lake', { ...PLAIN, wholeWord: true }).test('a lake here')).toBe(true);
  });

  it('reports an invalid pattern instead of throwing', () => {
    const c = compileQuery('[', { ...PLAIN, regex: true });
    expect(c).toMatchObject({ error: expect.stringMatching(/invalid regular expression/i) });
  });
});

describe('scanDocs', () => {
  it('groups matches by note with 1-based line numbers', () => {
    const { results, totalMatches } = scanDocs(DOCS, compiled('azure'));
    expect(totalMatches).toBe(3);
    expect(results.map((r) => r.noteId)).toEqual(['a', 'c']);
    expect(results[0].matches).toEqual([
      { lineNo: 2, line: 'azure is the cloud' },
      { lineNo: 3, line: 'azure again' },
    ]);
  });

  it('honours case sensitivity', () => {
    const { totalMatches } = scanDocs(DOCS, compiled('azure', { ...PLAIN, matchCase: true }));
    expect(totalMatches).toBe(2);
  });

  it('returns nothing when no note matches', () => {
    expect(scanDocs(DOCS, compiled('nowhere'))).toEqual({ results: [], totalMatches: 0 });
  });

  it('is not thrown off by a global regex carrying lastIndex between lines', () => {
    const docs: SearchDoc[] = [{ id: 'x', title: 'X', contentMd: 'foo\nfoo\nfoo' }];
    const { totalMatches } = scanDocs(docs, compiled('foo'));
    expect(totalMatches).toBe(3);
  });
});

function group(id: string, n: number): ResultGroup {
  return {
    noteId: id,
    title: id.toUpperCase(),
    matches: Array.from({ length: n }, (_, i) => ({ lineNo: i + 1, line: `line ${i}` })),
  };
}

describe('takeMatches', () => {
  it('keeps whole groups while they fit', () => {
    const { groups, shown } = takeMatches([group('a', 2), group('b', 3)], 10);
    expect(shown).toBe(5);
    expect(groups.map((g) => g.matches.length)).toEqual([2, 3]);
  });

  it('truncates the group that straddles the limit and drops the rest', () => {
    const { groups, shown } = takeMatches([group('a', 2), group('b', 40), group('c', 5)], 10);
    expect(shown).toBe(10);
    expect(groups.map((g) => g.noteId)).toEqual(['a', 'b']);
    expect(groups[1].matches.length).toBe(8);
  });

  it('caps a five-figure result set to the limit', () => {
    const { groups, shown } = takeMatches([group('a', 11269)], 100);
    expect(shown).toBe(100);
    expect(groups[0].matches.length).toBe(100);
  });
});

describe('clipLine', () => {
  const re = () => /needle/gi;

  it('leaves a short line untouched', () => {
    expect(clipLine('a needle here', re())).toEqual({
      text: 'a needle here',
      clippedStart: false,
      clippedEnd: false,
    });
  });

  it('windows a long line around the match', () => {
    const line = `${'x'.repeat(4000)}needle${'y'.repeat(4000)}`;
    const c = clipLine(line, re(), 240);
    expect(c.text.length).toBe(240);
    expect(c.text).toContain('needle');
    expect(c).toMatchObject({ clippedStart: true, clippedEnd: true });
  });

  it('does not run past the end when the match is near it', () => {
    const line = `${'x'.repeat(4000)}needle`;
    const c = clipLine(line, re(), 240);
    expect(c.text.endsWith('needle')).toBe(true);
    expect(c.clippedEnd).toBe(false);
  });
});
