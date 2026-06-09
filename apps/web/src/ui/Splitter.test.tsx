import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('host-relative drag reports the pixel size to onChange (regression: was clamped to a % range)', () => {
    const onChange = vi.fn();
    const host = document.createElement('div');
    host.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
    render(
      <Splitter
        orientation="horizontal"
        value={50}
        min={0}
        max={10000}
        hostRef={{ current: host }}
        onChange={onChange}
        ariaLabel="resize"
      />,
    );
    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 300 });
    // Distance from the host's left edge (0) to the cursor = 300px. Must reach
    // onChange un-clamped — the bug was min/max=20/80 squashing it to 80.
    expect(onChange).toHaveBeenLastCalledWith(300);
  });
});
