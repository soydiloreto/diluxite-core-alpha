import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { CustomTab } from './CustomTab';

function makeProps(activeId: string, ids: string[]) {
  const closes = new Map(ids.map((id) => [id, vi.fn()]));
  const panels = ids.map((id) => ({ id, api: { close: closes.get(id)! } }));
  const props = {
    api: {
      id: activeId,
      // The tab renders the title and subscribes to renames, so the fake api
      // has to answer both — `onDidTitleChange` hands back a disposable.
      title: activeId,
      onDidTitleChange: () => ({ dispose: () => {} }),
      close: closes.get(activeId)!,
      group: { panels },
    },
  } as unknown as IDockviewPanelHeaderProps;
  return { props, closes, closed: () => ids.filter((id) => closes.get(id)!.mock.calls.length > 0) };
}

const openMenu = () => fireEvent.contextMenu(screen.getByText('b'));
const item = (name: RegExp | string) => screen.getByRole('menuitem', { name });

describe('CustomTab close menu', () => {
  it('carries the VS Code labels', () => {
    const { props } = makeProps('b', ['a', 'b', 'c']);
    render(<CustomTab {...props} />);
    openMenu();

    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'Close',
      'Close Others',
      'Close to the Right',
      'Close All',
    ]);
  });

  it('Close closes only this tab', () => {
    const { props, closed } = makeProps('b', ['a', 'b', 'c']);
    render(<CustomTab {...props} />);
    openMenu();
    fireEvent.click(item('Close'));

    expect(closed()).toEqual(['b']);
  });

  it('Close Others spares the clicked tab', () => {
    const { props, closed } = makeProps('b', ['a', 'b', 'c']);
    render(<CustomTab {...props} />);
    openMenu();
    fireEvent.click(item('Close Others'));

    expect(closed()).toEqual(['a', 'c']);
  });

  it('Close to the Right stops at the clicked tab', () => {
    const { props, closed } = makeProps('b', ['a', 'b', 'c', 'd']);
    render(<CustomTab {...props} />);
    openMenu();
    fireEvent.click(item('Close to the Right'));

    expect(closed()).toEqual(['c', 'd']);
  });

  it('Close All takes the whole group', () => {
    const { props, closed } = makeProps('b', ['a', 'b', 'c']);
    render(<CustomTab {...props} />);
    openMenu();
    fireEvent.click(item('Close All'));

    expect(closed()).toEqual(['a', 'b', 'c']);
  });

  it('disables the entries that would close nothing', () => {
    const { props } = makeProps('b', ['a', 'b']);
    render(<CustomTab {...props} />);
    openMenu();

    // 'b' is last, so there is nothing to its right.
    expect(item('Close to the Right')).toBeDisabled();
    expect(item('Close Others')).toBeEnabled();
  });
});

describe('CustomTab accessibility', () => {
  it('the ✕ is decorative: it closes on click and is not a nested control', () => {
    // Dockview marks the tab `role="tab"` with `tabindex="0"`. A real button
    // inside it is `nested-interactive` — the axe failure this component was
    // rewritten to remove. The keyboard path is Delete on the tab, which
    // dockview's tab strip implements itself.
    const { props, closed } = makeProps('b', ['a', 'b']);
    const { container } = render(<CustomTab {...props} />);

    const close = container.querySelector('.dv-default-tab-action')!;
    expect(close.tagName).toBe('SPAN');
    expect(close.getAttribute('aria-hidden')).toBe('true');
    // Not merely `tabindex="-1"`: axe rejects that too, because a negative
    // tabindex is still focusable.
    expect(close.hasAttribute('tabindex')).toBe(false);
    expect(container.querySelectorAll('button, [href], input, select, textarea')).toHaveLength(0);

    fireEvent.click(close);
    expect(closed()).toEqual(['b']);
  });

  it('renames follow the panel title', () => {
    const listeners: ((e: { title: string }) => void)[] = [];
    const props = {
      api: {
        id: 'b',
        title: 'antes',
        onDidTitleChange: (fn: (e: { title: string }) => void) => {
          listeners.push(fn);
          return { dispose: () => {} };
        },
        close: vi.fn(),
        group: { panels: [{ id: 'b', api: { close: vi.fn() } }] },
      },
    } as unknown as IDockviewPanelHeaderProps;

    render(<CustomTab {...props} />);
    expect(screen.getByText('antes')).toBeInTheDocument();

    act(() => listeners.forEach((fn) => fn({ title: 'después' })));
    expect(screen.getByText('después')).toBeInTheDocument();
  });
});
