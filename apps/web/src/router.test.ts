import { describe, it, expect } from 'vitest';
import { buildPath } from './router';

describe('buildPath', () => {
  it('builds paths for each route kind', () => {
    expect(buildPath({ kind: 'home' })).toBe('/');
    expect(buildPath({ kind: 'note', id: 'abc' })).toBe('/notes/abc');
    expect(buildPath({ kind: 'folder', id: 'f1' })).toBe('/folders/f1');
    expect(buildPath({ kind: 'graph' })).toBe('/graph');
    expect(buildPath({ kind: 'settings' })).toBe('/settings');
    expect(buildPath({ kind: 'settings', tab: 'appearance' })).toBe('/settings/appearance');
  });
});
