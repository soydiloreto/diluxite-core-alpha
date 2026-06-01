import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrgTokensTab } from './OrgTokensTab';
import type { OrganizationWithRole } from '../../api';
import { AppProvider, type AppCtx } from '../AppContext';
import { createFakeApi } from '../../fakeApi';
import { DialogProvider } from '../../ui';

const org: OrganizationWithRole = {
  id: 'org-acme',
  name: 'Acme',
  slug: 'acme',
  createdAt: new Date().toISOString(),
  role: 'super_admin',
};

function renderWith(ctx?: Partial<AppCtx>) {
  const api = createFakeApi({ authMode: 'server' });
  const full: AppCtx = {
    api,
    spaceId: null,
    spaces: [],
    organizations: [],
    currentOrgId: null,
    // Org tokens are a server-mode feature — tests run against that mode so
    // the form is interactive (local mode now grises it out by design).
    authMode: 'server',
    notes: [],
    folders: [],
    tags: [],
    currentNoteId: null,
    prefs: {},
    setPref: () => {},
    getNote: async () => null,
    openNote: () => {},
    openByTitle: () => {},
    openGraph: () => {},
    openSettings: () => {},
    saveNote: async () => {},
    deleteNote: async () => {},
    searchTag: () => {},
    createNote: async () => null,
    user: null,
    collabUrl: null,
    refreshAll: async () => {},
    refreshOrgs: async () => {},
    refreshSpaces: async () => {},
    ...ctx,
  } as AppCtx;
  return render(
    <DialogProvider>
      <AppProvider value={full}>
        <OrgTokensTab org={org} />
      </AppProvider>
    </DialogProvider>,
  );
}

describe('OrgTokensTab', () => {
  it('renders the header with the org name', async () => {
    renderWith();
    expect(await screen.findByText(/Org tokens/i)).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
  });

  it('mints a token with the chosen scopes, shows it once, then lists it', async () => {
    const user = userEvent.setup();
    renderWith();
    // Type a name
    await user.type(screen.getByLabelText(/new org token name/i), 'ci-bot');
    // Default scope is 'read'; add 'write'
    await user.click(screen.getByRole('checkbox', { name: /scope write/i }));
    await user.click(screen.getByRole('button', { name: /^mint$/i }));
    // The freshly minted token is displayed
    const minted = await screen.findByTestId('minted-org-token');
    expect(minted.textContent ?? '').toMatch(/org_tok_/);
    // And the list shows the new token + its scope badges
    const tab = await screen.findByTestId('org-tokens-tab');
    expect(within(tab).getByText('ci-bot')).toBeInTheDocument();
    expect(within(tab).getByText('read')).toBeInTheDocument();
    expect(within(tab).getByText('write')).toBeInTheDocument();
  });

  it('blocks minting with zero scopes (selecting none + clicking Mint shows error)', async () => {
    const user = userEvent.setup();
    renderWith();
    // Uncheck the default 'read'
    await user.click(screen.getByRole('checkbox', { name: /scope read/i }));
    await user.click(screen.getByRole('button', { name: /^mint$/i }));
    expect(await screen.findByText(/Pick at least one scope/i)).toBeInTheDocument();
  });

  it('hides the mint form + revoke buttons for a member role', () => {
    const memberOrg: OrganizationWithRole = { ...org, role: 'member' };
    render(
      <DialogProvider>
        <AppProvider
          value={
            {
              api: createFakeApi(),
              user: null,
    collabUrl: null,
              spaceId: null,
              spaces: [],
              organizations: [],
              currentOrgId: null,
              notes: [],
              folders: [],
              tags: [],
              currentNoteId: null,
              prefs: {},
              setPref: () => {},
              getNote: async () => null,
              openNote: () => {},
              openByTitle: () => {},
              openGraph: () => {},
              openSettings: () => {},
              saveNote: async () => {},
              deleteNote: async () => {},
              searchTag: () => {},
              createNote: async () => null,
              refreshAll: async () => {},
              refreshOrgs: async () => {},
              refreshSpaces: async () => {},
            } as unknown as AppCtx
          }
        >
          <OrgTokensTab org={memberOrg} />
        </AppProvider>
      </DialogProvider>,
    );
    expect(screen.getByText(/need admin or super_admin/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/new org token name/i)).not.toBeInTheDocument();
  });

  it('local mode (super_admin role) hides the mint form and shows the server-mode notice', () => {
    // A super_admin in local mode still cannot mint org tokens — the matching
    // API guard refuses it with 403. The UI mirrors the contract so users
    // do not see actions that would fail when clicked.
    renderWith({ authMode: 'local' });
    expect(
      screen.getByText(/Org tokens are available in/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/new org token name/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^mint$/i }),
    ).not.toBeInTheDocument();
  });
});
