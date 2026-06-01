import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TreeRow } from './TreeRow';

describe('TreeRow — actions slot', () => {
  it('hides the actions container entirely (display:none) when not hovered, so it does NOT reserve horizontal space', () => {
    // Regression for: shrinking the Explorer sidebar caused folder/note labels
    // to truncate prematurely. Root cause was `opacity-0 group-hover:opacity-100`
    // on the actions container — invisible but still taking up width, which
    // forced the flex-1 label to compete for space with the invisible icons.
    // Fix: `hidden group-hover:flex` so the icons take ZERO width by default.
    render(
      <TreeRow
        depth={0}
        label="folder name that should not truncate"
        actions={
          <>
            <button>a</button>
            <button>b</button>
            <button>c</button>
          </>
        }
      />,
    );
    const actionsContainer = screen.getByRole('button', { name: 'a' }).parentElement;
    expect(actionsContainer).toBeTruthy();
    // The container must carry the Tailwind class that gives display:none.
    expect(actionsContainer!.className).toContain('hidden');
    expect(actionsContainer!.className).toContain('group-hover:flex');
    // Negative assertion: the legacy "opacity-only" class is forbidden because
    // it reserves space. If a future refactor reintroduces it, this test fails.
    expect(actionsContainer!.className).not.toMatch(/\bopacity-0\b/);
  });

  it('renders the label inside a min-w-0 + truncate button so flex can shrink it', () => {
    // The label button must allow flex shrink (min-w-0) so the truncation
    // happens on the LABEL, not by overflowing the row container — otherwise
    // long names would push the actions off-screen instead of getting `...`.
    render(<TreeRow depth={0} label="muy largo blablabla" />);
    const labelButton = screen.getByRole('button', { name: 'muy largo blablabla' });
    expect(labelButton.className).toContain('min-w-0');
    expect(labelButton.className).toContain('truncate');
    expect(labelButton.className).toContain('flex-1');
  });
});
