import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { OrganizationTab } from './OrganizationTab';
import type { OrganizationWithRole } from '../../api';
import { renderWithCtx } from '../../../test/render-with-ctx';

const org: OrganizationWithRole = {
  id: 'org-acme',
  name: 'Acme',
  slug: 'acme',
  createdAt: new Date().toISOString(),
  role: 'super_admin',
};

describe('OrganizationTab — delete button mode gating', () => {
  it('shows the danger zone in local mode but the delete button is disabled', () => {
    renderWithCtx(<OrganizationTab org={org} />, { authMode: 'local' });

    expect(screen.getByText(/Danger zone/i)).toBeInTheDocument();

    const btn = screen.getByRole('button', { name: /delete organization/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Organization deletion requires server mode');

    expect(
      screen.getByText(/Available in server mode only/i),
    ).toBeInTheDocument();
  });

  it('enables the delete button in server mode', () => {
    renderWithCtx(<OrganizationTab org={org} />, { authMode: 'server' });

    const btn = screen.getByRole('button', { name: /delete organization/i });
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('title');

    expect(
      screen.queryByText(/Available in server mode only/i),
    ).not.toBeInTheDocument();
  });

  it('hides the danger zone entirely for non super_admin members', () => {
    renderWithCtx(<OrganizationTab org={{ ...org, role: 'member' }} />, {
      authMode: 'server',
    });

    expect(screen.queryByText(/Danger zone/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /delete organization/i }),
    ).not.toBeInTheDocument();
  });
});
