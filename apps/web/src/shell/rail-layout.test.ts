import { describe, it, expect } from 'vitest';
import { nextRailMode, railCollapsed, railWidthPx, RAIL_COLLAPSED_PX, RAIL_EXPANDED_PX } from './rail-layout';

describe('rail layout', () => {
  it('cycles auto → expanded → collapsed → auto', () => {
    expect(nextRailMode('auto')).toBe('expanded');
    expect(nextRailMode('expanded')).toBe('collapsed');
    expect(nextRailMode('collapsed')).toBe('auto');
  });

  it('auto shows labels at the top level and shrinks when a panel opens', () => {
    expect(railCollapsed('auto', false)).toBe(false);
    expect(railCollapsed('auto', true)).toBe(true);
  });

  it('the explicit modes ignore whether a panel is open', () => {
    expect(railCollapsed('expanded', true)).toBe(false);
    expect(railCollapsed('collapsed', false)).toBe(true);
  });

  it('width follows the state', () => {
    expect(railWidthPx('auto', false)).toBe(RAIL_EXPANDED_PX);
    expect(railWidthPx('auto', true)).toBe(RAIL_COLLAPSED_PX);
  });
});
