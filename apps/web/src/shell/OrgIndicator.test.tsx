import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrgIndicator } from './OrgIndicator';
import type { OrganizationWithRole } from '../api';

const orgA: OrganizationWithRole = {
  id: 'org-a',
  name: 'Acme',
  slug: 'acme',
  createdAt: new Date().toISOString(),
  role: 'super_admin',
};
const orgB: OrganizationWithRole = {
  id: 'org-b',
  name: 'Globex',
  slug: 'globex',
  createdAt: new Date().toISOString(),
  role: 'admin',
};

describe('OrgIndicator — mode-aware create + switch', () => {
  it('local mode with one org: chip is non-interactive, no dropdown, no "New organization"', async () => {
    const user = userEvent.setup();
    render(
      <OrgIndicator
        orgs={[orgA]}
        currentOrgId={orgA.id}
        authMode="local"
        onPick={() => {}}
        onCreate={() => {}}
      />,
    );

    const chip = screen.getByRole('button', { name: /organization/i });
    expect(chip).toBeDisabled();

    // Clicking does nothing — no dropdown opens.
    await user.click(chip);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-indicator-create')).not.toBeInTheDocument();
  });

  it('server mode with one org: dropdown opens and shows only "New organization"', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <OrgIndicator
        orgs={[orgA]}
        currentOrgId={orgA.id}
        authMode="server"
        onPick={() => {}}
        onCreate={onCreate}
      />,
    );

    const chip = screen.getByRole('button', { name: /organization/i });
    expect(chip).not.toBeDisabled();
    await user.click(chip);

    // No "Switch organization" header when there's only one.
    expect(screen.queryByText(/Switch organization/i)).not.toBeInTheDocument();

    const createBtn = screen.getByTestId('org-indicator-create');
    await user.click(createBtn);
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('local mode with multiple orgs: dropdown opens for switch, but no "New organization"', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onCreate = vi.fn();
    render(
      <OrgIndicator
        orgs={[orgA, orgB]}
        currentOrgId={orgA.id}
        authMode="local"
        onPick={onPick}
        onCreate={onCreate}
      />,
    );

    const chip = screen.getByRole('button', { name: /organization/i });
    await user.click(chip);

    expect(screen.getByText(/Switch organization \(2\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('org-indicator-create')).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /globex/i }));
    expect(onPick).toHaveBeenCalledWith(orgB.id);
  });

  it('server mode with multiple orgs: both switcher list and "New organization" footer', async () => {
    const user = userEvent.setup();
    render(
      <OrgIndicator
        orgs={[orgA, orgB]}
        currentOrgId={orgA.id}
        authMode="server"
        onPick={() => {}}
        onCreate={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: /organization/i }));
    expect(screen.getByText(/Switch organization \(2\)/)).toBeInTheDocument();
    expect(screen.getByTestId('org-indicator-create')).toBeInTheDocument();
  });

  it('server mode without onCreate prop: no "New organization" entry', async () => {
    const user = userEvent.setup();
    render(
      <OrgIndicator
        orgs={[orgA, orgB]}
        currentOrgId={orgA.id}
        authMode="server"
        onPick={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: /organization/i }));
    expect(screen.queryByTestId('org-indicator-create')).not.toBeInTheDocument();
  });
});
