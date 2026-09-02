import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GraphView } from './GraphView';
import { renderWithCtx } from '../../test/render-with-ctx';
import type { ApiClient, Graph } from '../api';

const GRAPH: Graph = {
  nodes: [
    { id: 'n1', title: 'Azure', folderId: null },
    { id: 'n2', title: 'MUG', folderId: null },
  ],
  edges: [{ source: 'n1', target: 'n2' }],
};

function api(): ApiClient {
  return { graph: vi.fn().mockResolvedValue(GRAPH) } as unknown as ApiClient;
}

beforeEach(() => {
  // jsdom has no canvas 2d context; the graph only needs it to paint.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype as any).getContext = vi.fn(() => null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('GraphView — the controls have their own panel', () => {
  it('renders the view modes as a list beside the canvas, not in the header', async () => {
    renderWithCtx(<GraphView api={api()} spaceId="s1" onOpen={vi.fn()} />, {});
    const panel = await screen.findByTestId('graph-controls');
    expect(panel).toBeInTheDocument();
    // They were a <select> in a strip along the top of the canvas, where a
    // dropdown and a slider competed with the breadcrumb for one line.
    expect(screen.queryByLabelText('graph view mode')).toBeNull();
    expect(within(panel).getByRole('button', { name: 'All connections' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Hubs' })).toBeInTheDocument();
  });

  it('picking a mode marks it as the current one', async () => {
    const user = userEvent.setup();
    renderWithCtx(<GraphView api={api()} spaceId="s1" onOpen={vi.fn()} />, {});
    const panel = await screen.findByTestId('graph-controls');
    const hubs = within(panel).getByRole('button', { name: 'Hubs' });
    await user.click(hubs);
    await waitFor(() => expect(hubs.className).toContain('bg-brand'));
  });

  it('Fit view and the zoom read-out live in the panel too', async () => {
    renderWithCtx(<GraphView api={api()} spaceId="s1" onOpen={vi.fn()} />, {});
    const panel = await screen.findByTestId('graph-controls');
    expect(within(panel).getByRole('button', { name: 'Fit view' })).toBeInTheDocument();
    expect(within(panel).getByText('100%')).toBeInTheDocument();
  });
});
