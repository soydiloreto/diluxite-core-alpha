import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useContextMenu, type ContextMenuEntry } from './ContextMenu';

/** Tiny harness component: a "trigger" button + the Menu rendering slot. */
function Harness({ entries }: { entries: ContextMenuEntry[] }) {
  const { open, Menu } = useContextMenu();
  return (
    <div>
      <button data-testid="trigger" onClick={(e) => open(e, entries)}>
        open
      </button>
      <Menu />
    </div>
  );
}

const noop = () => {};

describe('ContextMenu', () => {
  it('opens at the click position and closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        entries={[
          { label: 'One', onSelect: noop },
          { label: 'Two', onSelect: noop },
        ]}
      />,
    );

    await user.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('closes when clicking outside', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Harness entries={[{ label: 'One', onSelect: noop }]} />
        <button data-testid="elsewhere">elsewhere</button>
      </div>,
    );
    await user.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    // mousedown outside the menu — useContextMenu listens for mousedown, not click.
    fireEvent.mouseDown(screen.getByTestId('elsewhere'));
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('renders separators between items', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        entries={[
          { label: 'A', onSelect: noop },
          'separator',
          { label: 'B', onSelect: noop },
        ]}
      />,
    );
    await user.click(screen.getByTestId('trigger'));
    const menu = screen.getByTestId('context-menu');
    expect(within(menu).getByRole('menuitem', { name: 'A' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'B' })).toBeInTheDocument();
  });

  it('disabled items are not clickable and not highlighted by arrows', async () => {
    const user = userEvent.setup();
    const onA = vi.fn();
    const onB = vi.fn();
    const onC = vi.fn();
    render(
      <Harness
        entries={[
          { label: 'A', onSelect: onA },
          { label: 'B', onSelect: onB, disabled: true },
          { label: 'C', onSelect: onC },
        ]}
      />,
    );
    await user.click(screen.getByTestId('trigger'));

    // B is disabled — clicking it does nothing.
    const b = screen.getByRole('menuitem', { name: 'B' });
    expect(b).toBeDisabled();
    await user.click(b);
    expect(onB).not.toHaveBeenCalled();

    // ArrowDown from A skips B and lands on C.
    await user.keyboard('{ArrowDown}');
    const c = screen.getByRole('menuitem', { name: 'C' });
    expect(c).toHaveAttribute('data-highlighted', 'true');
  });

  it('Arrow keys move the highlight, Enter activates', async () => {
    const user = userEvent.setup();
    const onA = vi.fn();
    const onB = vi.fn();
    const onC = vi.fn();
    render(
      <Harness
        entries={[
          { label: 'A', onSelect: onA },
          { label: 'B', onSelect: onB },
          { label: 'C', onSelect: onC },
        ]}
      />,
    );
    await user.click(screen.getByTestId('trigger'));
    // First enabled item is auto-highlighted on open.
    expect(screen.getByRole('menuitem', { name: 'A' })).toHaveAttribute('data-highlighted', 'true');

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'C' })).toHaveAttribute('data-highlighted', 'true');

    await user.keyboard('{Enter}');
    expect(onC).toHaveBeenCalledTimes(1);
    expect(onA).not.toHaveBeenCalled();
    expect(onB).not.toHaveBeenCalled();
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('ArrowDown wraps to the first item past the end', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        entries={[
          { label: 'A', onSelect: noop },
          { label: 'B', onSelect: noop },
        ]}
      />,
    );
    await user.click(screen.getByTestId('trigger'));
    await user.keyboard('{ArrowDown}{ArrowDown}'); // B → wrap → A
    expect(screen.getByRole('menuitem', { name: 'A' })).toHaveAttribute('data-highlighted', 'true');
  });

  it('Home jumps to the first item, End jumps to the last', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        entries={[
          { label: 'A', onSelect: noop },
          { label: 'B', onSelect: noop },
          { label: 'C', onSelect: noop },
        ]}
      />,
    );
    await user.click(screen.getByTestId('trigger'));
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'C' })).toHaveAttribute('data-highlighted', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'A' })).toHaveAttribute('data-highlighted', 'true');
  });

  it('Space also activates the highlighted item', async () => {
    const user = userEvent.setup();
    const onA = vi.fn();
    render(<Harness entries={[{ label: 'A', onSelect: onA }]} />);
    await user.click(screen.getByTestId('trigger'));
    await user.keyboard(' '); // space
    expect(onA).toHaveBeenCalledTimes(1);
  });
});
