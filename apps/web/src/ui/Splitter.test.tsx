import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Splitter } from './Splitter';

/**
 * Regression guard: the split divider must be VISIBLE at rest (not only on
 * hover). It's a 4px drag area with an always-on 1px hairline (`bg-line`,
 * theme-aware) that tints brand on hover/drag.
 */
describe('Splitter', () => {
  it('renders a separator with an always-visible hairline (not transparent)', () => {
    render(
      <Splitter
        orientation="horizontal"
        value={200}
        min={100}
        max={400}
        onChange={vi.fn()}
        ariaLabel="resize editor"
      />,
    );
    const sep = screen.getByRole('separator', { name: 'resize editor' });
    const hairline = sep.querySelector('div');
    expect(hairline).toBeTruthy();
    // Visible at rest via the theme line color, NOT bg-transparent.
    expect(hairline!.className).toContain('bg-line');
    expect(sep.className).not.toContain('bg-transparent');
  });

  it('exposes the correct orientation for assistive tech', () => {
    render(
      <Splitter orientation="vertical" value={120} min={80} max={300} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
  });
});
