import { describe, it, expect } from 'vitest';
import { removeWikilink, extractWikilinkTargets, extractTags } from './markdown';

describe('removeWikilink (unlink keeps the words, drops the edge)', () => {
  it('unwraps [[Target]] to plain text', () => {
    expect(removeWikilink('see [[Target]] here', 'Target')).toBe('see Target here');
  });

  it('unwraps [[Target|alias]] to the alias', () => {
    expect(removeWikilink('see [[Target|the alias]] here', 'target')).toBe('see the alias here');
  });

  it('is case-insensitive on the title', () => {
    expect(removeWikilink('[[Event Sourcing]]', 'event sourcing')).toBe('Event Sourcing');
  });

  it('only touches the matching link, leaving others intact', () => {
    expect(removeWikilink('[[A]] and [[B]]', 'A')).toBe('A and [[B]]');
  });

  it('removes every occurrence of the same target', () => {
    expect(removeWikilink('[[X]] ... [[X]]', 'X')).toBe('X ... X');
    expect(extractWikilinkTargets(removeWikilink('[[X]] [[X]]', 'X'))).toEqual([]);
  });

  it('leaves tags untouched', () => {
    const out = removeWikilink('[[A]] #tag', 'A');
    expect(extractTags(out)).toEqual(['tag']);
  });
});
