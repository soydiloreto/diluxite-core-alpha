import { describe, it, expect } from 'vitest';
import { maskCodeSpans } from './code-spans';

const sp = (s: string) => ' '.repeat(s.length);

/** The core invariant: masking never changes length, line count, or newline positions. */
function expectShapePreserved(input: string, masked: string) {
  expect(masked.length).toBe(input.length);
  const a = input.split('\n');
  const b = masked.split('\n');
  expect(b.length).toBe(a.length);
  a.forEach((line, i) => expect(b[i].length).toBe(line.length));
}

describe('maskCodeSpans', () => {
  it('leaves plain text untouched', () => {
    const md = '# Heading\n\nSome **bold** text with a #tag and [[Wikilink]].';
    expect(maskCodeSpans(md)).toBe(md);
  });

  it('masks inline code content but preserves length', () => {
    const input = 'use `#include` here';
    const out = maskCodeSpans(input);
    expect(out).toBe('use ' + sp('`#include`') + ' here');
    expect(out).not.toContain('#include');
    expectShapePreserved(input, out);
  });

  it('masks a fenced block and its fence lines, keeping line shape', () => {
    const md = ['before', '```c', '#include <stdio.h>', '# not a heading', '```', 'after'].join('\n');
    const out = maskCodeSpans(md);
    const lines = out.split('\n');
    expect(lines[0]).toBe('before');
    expect(lines[1]).toBe(sp('```c'));
    expect(lines[2]).toBe(sp('#include <stdio.h>'));
    expect(lines[3]).toBe(sp('# not a heading'));
    expect(lines[5]).toBe('after');
    expect(out).not.toContain('#include');
    expect(out).not.toContain('not a heading');
    expectShapePreserved(md, out);
  });

  it('masks the fence info string line entirely', () => {
    const md = '```ts\nconst x = 1;\n```';
    const lines = maskCodeSpans(md).split('\n');
    expect(lines[0]).toBe(sp('```ts'));
    expect(lines[1]).toBe(sp('const x = 1;'));
  });

  it('supports ~~~ fences', () => {
    const md = '~~~\n# inside\n~~~';
    const lines = maskCodeSpans(md).split('\n');
    expect(lines[1]).toBe(sp('# inside'));
  });

  it('handles double-backtick spans that contain a single backtick', () => {
    const input = 'a ``b`c`` d';
    const out = maskCodeSpans(input);
    expect(out).toBe('a ' + sp('``b`c``') + ' d');
    expectShapePreserved(input, out);
  });

  it('keeps dangling (unclosed) inline backticks literal', () => {
    const md = 'an `unclosed span here';
    expect(maskCodeSpans(md)).toBe(md);
  });

  it('masks an unterminated fence through end-of-input', () => {
    const md = 'intro\n```\n#tag still masked\nmore';
    const out = maskCodeSpans(md);
    const lines = out.split('\n');
    expect(lines[0]).toBe('intro');
    expect(lines[2]).toBe(sp('#tag still masked'));
    expect(lines[3]).toBe(sp('more'));
    expect(out).not.toContain('#tag');
  });

  it('only closes a fence with a marker run at least as long as the opener', () => {
    // opened with ```` (4); a ``` (3) line does NOT close it.
    const md = '````\nstill in\n```\nalso in\n````';
    const out = maskCodeSpans(md);
    const lines = out.split('\n');
    expect(lines[1]).toBe(sp('still in'));
    expect(lines[3]).toBe(sp('also in'));
  });

  it('masks inline code, leaving surrounding text intact', () => {
    expect(maskCodeSpans('x `code` y')).toBe('x ' + sp('`code`') + ' y');
  });

  it('round-trips an empty string', () => {
    expect(maskCodeSpans('')).toBe('');
  });
});
