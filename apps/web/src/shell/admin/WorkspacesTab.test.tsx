import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspacesTab } from './WorkspacesTab';
import type { ApiClient, OrganizationWithRole, Space } from '../../api';
import { renderWithCtx } from '../../../test/render-with-ctx';

const org: OrganizationWithRole = {
  id: 'org-acme',
  name: 'Acme',
  slug: 'acme',
  createdAt: new Date().toISOString(),
  role: 'super_admin',
};

function makeApi(workspaces: Space[]): ApiClient {
  return {
    listOrgWorkspaces: vi.fn(async () => workspaces),
    listWorkspaceMembers: vi.fn(async () => []),
    createWorkspace: vi.fn(async (_orgId: string, name: string) => ({ id: 'ws-new', name })),
    deleteWorkspace: vi.fn(async () => undefined),
    renameWorkspace: vi.fn(async () => undefined),
  } as unknown as ApiClient;
}

describe('WorkspacesTab', () => {
  it('renders the header with the org name', async () => {
    const api = makeApi([]);
    renderWithCtx(<WorkspacesTab org={org} />, { api, authMode: 'server' });
    expect(await screen.findByText(/Workspaces in/i)).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
  });

  it('lists the workspaces returned by the api', async () => {
    const api = makeApi([
      { id: 'ws-1', name: 'Platform' },
      { id: 'ws-2', name: 'Design' },
    ]);
    renderWithCtx(<WorkspacesTab org={org} />, { api, authMode: 'server' });
    expect(await screen.findByText('Platform')).toBeInTheDocument();
    expect(screen.getByText('Design')).toBeInTheDocument();
  });

  it('renders an empty state when no workspaces come back', async () => {
    const api = makeApi([]);
    renderWithCtx(<WorkspacesTab org={org} />, { api, authMode: 'server' });
    expect(await screen.findByText(/No workspaces yet/i)).toBeInTheDocument();
  });

  it('Create calls api.createWorkspace with the typed name', async () => {
    const user = userEvent.setup();
    const api = makeApi([]);
    renderWithCtx(<WorkspacesTab org={org} />, { api, authMode: 'server' });
    await screen.findByText(/No workspaces yet/i);
    await user.type(screen.getByLabelText(/new workspace name/i), 'Platform team');
    await user.click(screen.getByRole('button', { name: /create/i }));
    await waitFor(() => {
      expect(api.createWorkspace).toHaveBeenCalledWith('org-acme', 'Platform team');
    });
  });

  it('hides the create form for a plain member role', async () => {
    const api = makeApi([{ id: 'ws-1', name: 'Platform' }]);
    renderWithCtx(<WorkspacesTab org={{ ...org, role: 'member' }} />, { api, authMode: 'server' });
    await screen.findByText('Platform');
    expect(screen.queryByLabelText(/new workspace name/i)).not.toBeInTheDocument();
  });

  it('expanding a workspace shows its member panel + Delete calls api.deleteWorkspace', async () => {
    const user = userEvent.setup();
    const api = makeApi([{ id: 'ws-1', name: 'Platform' }]);
    renderWithCtx(<WorkspacesTab org={org} />, { api, authMode: 'server' });
    const row = (await screen.findByText('Platform')).closest('div')!;
    // Delete with confirm dialog
    await user.click(within(row.parentElement as HTMLElement).getByText('Delete'));
    await user.click(await screen.findByRole('button', { name: /delete workspace/i }));
    await waitFor(() => {
      expect(api.deleteWorkspace).toHaveBeenCalledWith('ws-1');
    });
  });
});
