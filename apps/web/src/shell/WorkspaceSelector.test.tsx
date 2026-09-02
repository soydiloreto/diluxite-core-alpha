import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RENDER_CAP, WorkspaceSelector } from './WorkspaceSelector';
import type { Space } from '../api';

function makeSpaces(n: number): Space[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ws-${i}`,
    orgId: 'org-1',
    name: `Workspace ${i}`,
    role: 'editor',
    createdAt: new Date(2026, 0, 1).toISOString(),
  })) as Space[];
}

describe('WorkspaceSelector — small lists (≤ filter threshold)', () => {
  it('renders the active workspace name on the trigger', () => {
    const ws = makeSpaces(3);
    render(
      <WorkspaceSelector
        workspaces={ws}
        activeId="ws-1"
        onPick={() => undefined}
      />,
    );
    expect(screen.getByLabelText('workspace selector').textContent).toContain('Workspace 1');
  });

  it('does NOT show the filter input when below the threshold', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSelector
        workspaces={makeSpaces(5)}
        activeId="ws-0"
        onPick={() => undefined}
      />,
    );
    await user.click(screen.getByLabelText('workspace selector'));
    expect(screen.queryByLabelText('filter workspaces')).not.toBeInTheDocument();
  });

  it('clicking a workspace calls onPick with its id and closes the menu', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <WorkspaceSelector
        workspaces={makeSpaces(3)}
        activeId="ws-0"
        onPick={onPick}
      />,
    );
    await user.click(screen.getByLabelText('workspace selector'));
    await user.click(screen.getByRole('menuitem', { name: /Workspace 2/i }));
    expect(onPick).toHaveBeenCalledWith('ws-2');
  });
});

describe('WorkspaceSelector — large lists (> filter threshold)', () => {
  it('shows the filter input when the list exceeds the threshold', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSelector
        workspaces={makeSpaces(50)}
        activeId="ws-0"
        onPick={() => undefined}
      />,
    );
    await user.click(screen.getByLabelText('workspace selector'));
    expect(await screen.findByLabelText('filter workspaces')).toBeInTheDocument();
  });

  it('filter narrows the visible workspaces case-insensitive', async () => {
    const user = userEvent.setup();
    const ws = [
      ...makeSpaces(15),
      { id: 'ws-prod', orgId: 'org-1', name: 'PRODUCTION', role: 'editor' } as Space,
    ];
    render(<WorkspaceSelector workspaces={ws} activeId="ws-0" onPick={() => undefined} />);
    await user.click(screen.getByLabelText('workspace selector'));
    const filter = await screen.findByLabelText('filter workspaces');
    await user.type(filter, 'prod');
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('PRODUCTION')).toBeInTheDocument();
    // Scope the negative check to the menu — the trigger button shows the
    // active workspace's name ("Workspace 0") regardless of the filter.
    expect(within(menu).queryByText('Workspace 0')).not.toBeInTheDocument();
  });

  it('caps rendered items and shows an overflow hint with N=1000', async () => {
    // Regression for "lista interminable de workspaces". The dropdown must
    // NOT render 1000 <li> nodes — that would jank scroll + DOM mutation.
    // The component caps at RENDER_CAP and shows a +N hint instead.
    //
    // Asserted by COUNTING the nodes, never by timing the render. A wall-clock
    // bound in a unit test measures the machine: this one passed alone and
    // failed inside the full suite, where a dozen jsdom environments share the
    // same cores. The DOM count is the invariant the regression was about, and
    // it cannot be satisfied by a fast machine with a broken cap.
    const user = userEvent.setup();
    const N = 1000;
    render(
      <WorkspaceSelector
        workspaces={makeSpaces(N)}
        activeId="ws-0"
        onPick={() => undefined}
      />,
    );
    await user.click(screen.getByLabelText('workspace selector'));

    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.length).toBe(RENDER_CAP);
    // And the hint accounts for exactly what was left out, so "capped" cannot
    // quietly become "truncated and unmentioned".
    expect(within(menu).getByTestId('overflow-hint').textContent).toContain(
      `+${N - RENDER_CAP} más`,
    );
  });

  it('filter survives N=1000 — typing finds a single match quickly', async () => {
    const user = userEvent.setup();
    const ws = makeSpaces(1000);
    render(<WorkspaceSelector workspaces={ws} activeId="ws-0" onPick={() => undefined} />);
    await user.click(screen.getByLabelText('workspace selector'));
    const filter = await screen.findByLabelText('filter workspaces');
    await user.type(filter, 'Workspace 777');
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Workspace 777')).toBeInTheDocument();
    // After narrowing to one match the overflow hint disappears.
    expect(within(menu).queryByTestId('overflow-hint')).not.toBeInTheDocument();
  });
});
