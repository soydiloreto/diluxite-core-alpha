import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchConfigTab } from './SearchConfigTab';
import { renderWithCtx } from '../../../test/render-with-ctx';
import type { OrganizationWithRole, SearchMode } from '../../api';

const ORG = (role: OrganizationWithRole['role']): OrganizationWithRole => ({
  id: 'org-1',
  name: 'Acme',
  slug: 'acme',
  role,
});

function setup(
  role: OrganizationWithRole['role'] = 'admin',
  cfg: { mode: SearchMode; topK: number } = { mode: 'hybrid', topK: 5 },
) {
  const getSearchConfig = vi.fn().mockResolvedValue(cfg);
  const setSearchConfig = vi.fn().mockResolvedValue(undefined);
  const r = renderWithCtx(<SearchConfigTab org={ORG(role)} />, {
    api: { getSearchConfig, setSearchConfig },
  });
  return { ...r, getSearchConfig, setSearchConfig };
}

describe('SearchConfigTab', () => {
  it('loads the ORG configuration, not a browser preference', async () => {
    const { getSearchConfig } = setup('admin', { mode: 'keyword', topK: 12 });
    await waitFor(() => expect(screen.getByLabelText(/search mode/i)).toHaveValue('keyword'));
    expect(screen.getByLabelText(/topK/i)).toHaveValue(12);
    expect(getSearchConfig).toHaveBeenCalledWith('org-1');
  });

  it('Save is disabled until something changes', async () => {
    setup();
    await waitFor(() => expect(screen.getByLabelText(/search mode/i)).toHaveValue('hybrid'));
    expect(screen.getByTestId('search-save')).toBeDisabled();
  });

  /**
   * The bug this tab existed with: it lived in the ADMIN console and wrote to
   * localStorage, so an admin configured their own laptop while believing they
   * had configured the organisation. The write must reach the server.
   */
  it('saves to the organization, and says so', async () => {
    const { setSearchConfig } = setup();
    await waitFor(() => expect(screen.getByLabelText(/search mode/i)).toHaveValue('hybrid'));

    await userEvent.selectOptions(screen.getByLabelText(/search mode/i), 'semantic');
    await userEvent.click(screen.getByTestId('search-save'));

    await waitFor(() =>
      expect(setSearchConfig).toHaveBeenCalledWith('org-1', { mode: 'semantic', topK: 5 }),
    );
    expect(await screen.findByTestId('search-saved')).toBeInTheDocument();
  });

  it('shows the scope, so nobody has to guess whose setting this is', async () => {
    setup();
    expect(await screen.findByText(/Acme/)).toBeInTheDocument();
  });

  it('a plain member sees the values but cannot change them', async () => {
    setup('member');
    await waitFor(() => expect(screen.getByLabelText(/search mode/i)).toBeDisabled());
    expect(screen.getByTestId('search-save')).toBeDisabled();
    expect(screen.getByTestId('search-readonly')).toBeInTheDocument();
  });

  it('surfaces a failed save instead of pretending it worked', async () => {
    const getSearchConfig = vi.fn().mockResolvedValue({ mode: 'hybrid', topK: 5 });
    const setSearchConfig = vi.fn().mockRejectedValue(new Error('no write access'));
    renderWithCtx(<SearchConfigTab org={ORG('admin')} />, {
      api: { getSearchConfig, setSearchConfig },
    });
    await waitFor(() => expect(screen.getByLabelText(/search mode/i)).toHaveValue('hybrid'));

    await userEvent.selectOptions(screen.getByLabelText(/search mode/i), 'keyword');
    await userEvent.click(screen.getByTestId('search-save'));

    expect(await screen.findByTestId('search-error')).toHaveTextContent('no write access');
    expect(screen.queryByTestId('search-saved')).not.toBeInTheDocument();
  });

  it('says so plainly when there is no organization', () => {
    renderWithCtx(<SearchConfigTab org={null} />, {});
    expect(screen.getByTestId('admin-search-tab')).toHaveTextContent(/no organization/i);
  });
});
