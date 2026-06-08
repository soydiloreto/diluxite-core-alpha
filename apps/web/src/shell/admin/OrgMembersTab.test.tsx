import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrgMembersTab } from './OrgMembersTab';
import type { ApiClient, OrgMember, OrganizationWithRole } from '../../api';
import { renderWithCtx } from '../../../test/render-with-ctx';

const org: OrganizationWithRole = {
  id: 'org-acme',
  name: 'Acme',
  slug: 'acme',
  createdAt: new Date().toISOString(),
  role: 'super_admin',
};

function makeApi(members: OrgMember[]): ApiClient {
  return {
    listOrgMembers: vi.fn(async () => members),
    addOrgMember: vi.fn(async () => ({ ok: true as const, userId: 'u-new', role: 'member' as const })),
    updateOrgMember: vi.fn(async () => undefined),
    removeOrgMember: vi.fn(async () => undefined),
  } as unknown as ApiClient;
}

describe('OrgMembersTab', () => {
  it('renders the header with the org name', async () => {
    const api = makeApi([]);
    renderWithCtx(<OrgMembersTab org={org} />, { api, authMode: 'server' });
    expect(await screen.findByText(/Members of/i)).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
  });

  it('lists the members returned by the api', async () => {
    const api = makeApi([
      { userId: 'u-1', email: 'ana@x.com', role: 'admin' },
      { userId: 'u-2', email: 'bob@x.com', role: 'member' },
    ]);
    renderWithCtx(<OrgMembersTab org={org} />, { api, authMode: 'server' });
    expect(await screen.findByText('ana@x.com')).toBeInTheDocument();
    expect(screen.getByText('bob@x.com')).toBeInTheDocument();
  });

  it('renders an empty state when no members match', async () => {
    const api = makeApi([]);
    renderWithCtx(<OrgMembersTab org={org} />, { api, authMode: 'server' });
    expect(await screen.findByText(/No members match/i)).toBeInTheDocument();
  });

  it('Invite calls api.addOrgMember with the typed email', async () => {
    const user = userEvent.setup();
    const api = makeApi([]);
    renderWithCtx(<OrgMembersTab org={org} />, { api, authMode: 'server' });
    await screen.findByText(/No members match/i);
    await user.type(screen.getByLabelText(/invite email/i), 'NEW@x.com');
    await user.click(screen.getByRole('button', { name: /invite/i }));
    await waitFor(() => {
      expect(api.addOrgMember).toHaveBeenCalledWith('org-acme', 'new@x.com', 'member');
    });
  });

  it('the email filter narrows the visible rows', async () => {
    const user = userEvent.setup();
    const api = makeApi([
      { userId: 'u-1', email: 'ana@x.com', role: 'admin' },
      { userId: 'u-2', email: 'bob@x.com', role: 'member' },
    ]);
    renderWithCtx(<OrgMembersTab org={org} />, { api, authMode: 'server' });
    await screen.findByText('ana@x.com');
    await user.type(screen.getByLabelText(/filter members/i), 'bob');
    expect(screen.queryByText('ana@x.com')).not.toBeInTheDocument();
    expect(screen.getByText('bob@x.com')).toBeInTheDocument();
  });

  it('Remove confirms then calls api.removeOrgMember', async () => {
    const user = userEvent.setup();
    const api = makeApi([{ userId: 'u-1', email: 'ana@x.com', role: 'member' }]);
    renderWithCtx(<OrgMembersTab org={org} />, { api, authMode: 'server' });
    await screen.findByText('ana@x.com');
    await user.click(screen.getByRole('button', { name: /remove ana@x.com/i }));
    await user.click(await screen.findByRole('button', { name: /^remove$/i }));
    await waitFor(() => {
      expect(api.removeOrgMember).toHaveBeenCalledWith('org-acme', 'u-1');
    });
  });

  it('hides the invite form for a plain member role', async () => {
    const api = makeApi([{ userId: 'u-1', email: 'ana@x.com', role: 'member' }]);
    renderWithCtx(<OrgMembersTab org={{ ...org, role: 'member' }} />, { api, authMode: 'server' });
    await screen.findByText('ana@x.com');
    expect(screen.queryByLabelText(/invite email/i)).not.toBeInTheDocument();
  });
});
