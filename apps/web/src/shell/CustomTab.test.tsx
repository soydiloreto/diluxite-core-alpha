import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { CustomTab } from './CustomTab';

vi.mock('dockview-react', () => ({
  DockviewDefaultTab: ({ api }: { api: { id: string } }) => <span>{api.id}</span>,
}));

function makeProps(activeId: string, ids: string[]) {
  const closes = new Map(ids.map((id) => [id, vi.fn()]));
  const panels = ids.map((id) => ({ id, api: { close: closes.get(id)! } }));
  const props = {
    api: { id: activeId, close: closes.get(activeId)!, group: { panels } },
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
