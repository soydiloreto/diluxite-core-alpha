import { describe, it, expect } from 'vitest';
import { addTagToMarkdown, removeTagFromMarkdown, normaliseTag } from './tag-edit';
import { parseTags } from './tags';

describe('normaliseTag', () => {
  it('accepts a tag with or without the hash', () => {
    expect(normaliseTag('work')).toBe('work');
    expect(normaliseTag('#work')).toBe('work');
    expect(normaliseTag('  #proyecto/diluxite  ')).toBe('proyecto/diluxite');
  });

  it('refuses what parseTags would never read back', () => {
    // A "tag" the parser does not recognise would be written into the note and
    // then not appear in its tags — the operation would look done and not be.
    for (const bad of ['', '#', '#1st', 'con espacio', '#hash#tag', '#(x)']) {
      expect(normaliseTag(bad), bad).toBeNull();
    }
  });
});

describe('addTagToMarkdown', () => {
  it('appends the tag on its own line, separated from the prose', () => {
    const out = addTagToMarkdown('Una nota sobre el deploy.', 'infra');
    expect(out).toBe('Una nota sobre el deploy.\n\n#infra');
    expect(parseTags(out)).toContain('infra');
  });

  it('joins the note existing tag line instead of starting a second one', () => {
    const md = 'Cuerpo de la nota.\n\n#uno #dos';
    expect(addTagToMarkdown(md, 'tres')).toBe('Cuerpo de la nota.\n\n#uno #dos #tres');
  });

  it('is idempotent, byte for byte', () => {
    // A bulk operation runs over notes that already carry the tag. Rewriting
    // them would be a save, a new version and a re-index for nothing.
    const md = 'Nota.\n\n#infra';
    expect(addTagToMarkdown(md, 'infra')).toBe(md);
    expect(addTagToMarkdown(md, '#INFRA')).toBe(md);
  });

  it('handles an empty note and one that ends in blank lines', () => {
    expect(addTagToMarkdown('', 'x')).toBe('#x');
    expect(addTagToMarkdown('Texto.\n\n', 'x')).toBe('Texto.\n\n#x\n');
  });

  it('refuses to write something the parser would not read back', () => {
    expect(() => addTagToMarkdown('n', 'no válido')).toThrow(/not a tag/);
  });
});

describe('removeTagFromMarkdown', () => {
  it('removes the tag and leaves the rest of the line alone', () => {
    expect(removeTagFromMarkdown('Nota.\n\n#uno #dos', 'uno')).toBe('Nota.\n\n#dos');
    expect(removeTagFromMarkdown('Nota con #infra adentro.', 'infra')).toBe('Nota con adentro.');
  });

  it('does not eat a longer tag that starts the same', () => {
    // `#work` must not match inside `#workflow`.
    expect(removeTagFromMarkdown('a #workflow b', 'work')).toBe('a #workflow b');
    expect(removeTagFromMarkdown('a #work #workflow b', 'work')).toBe('a #workflow b');
  });

  it('leaves code alone', () => {
    // `#include` in a fence was never a tag — `parseTags` masks code — and
    // removing it would corrupt the block.
    const md = ['Nota #include', '', '```c', '#include <stdio.h>', '```'].join('\n');
    const out = removeTagFromMarkdown(md, 'include');
    expect(out).toContain('#include <stdio.h>');
    expect(out.split('\n')[0]).toBe('Nota');
  });

  it('drops the blank line a tags-only line leaves behind', () => {
    expect(removeTagFromMarkdown('Nota.\n\n#solo', 'solo')).toBe('Nota.\n');
  });

  it('does nothing when the tag is not there', () => {
    const md = 'Nota.\n\n#otro';
    expect(removeTagFromMarkdown(md, 'infra')).toBe(md);
  });

  it('round-trips with add', () => {
    for (const md of ['Nota.', 'Nota.\n\n#uno', '', 'Una #uno en el medio.']) {
      const added = addTagToMarkdown(md, 'temporal');
      expect(parseTags(added)).toContain('temporal');
      expect(parseTags(removeTagFromMarkdown(added, 'temporal'))).not.toContain('temporal');
    }
  });
});
