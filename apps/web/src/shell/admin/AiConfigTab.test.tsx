import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithCtx } from '../../../test/render-with-ctx';
import { AiConfigTab } from './AiConfigTab';
import type { EmbeddingHealth, OrganizationWithRole } from '../../api';

const ORG: OrganizationWithRole = {
  id: 'org-1',
  name: 'Acme',
  slug: 'acme',
  role: 'org_admin',
} as OrganizationWithRole;

const HEALTHY: EmbeddingHealth = {
  active: {
    provider: 'ollama',
    semantic: true,
    dimensions: 1024,
    model: 'mxbai-embed-large:335m',
    endpoint: 'localhost:11434',
  },
  stored: [
    { key: 'ollama:mxbai-embed-large:335m@1024', dimensions: 1024, chunks: 42, state: 'active' as const },
  ],
  chunksWithoutEmbedding: 0,
  chunks: 42,
  reindexRequired: false,
};

const render = (health: EmbeddingHealth, over: Partial<OrganizationWithRole> = {}) => {
  const embeddingHealth = vi.fn().mockResolvedValue(health);
  const reindex = vi.fn().mockResolvedValue({ reindexed: 7, spaces: 1 });
  // The provider form lives in this tab now and reads its own config.
  const getEmbeddingConfig = vi.fn().mockResolvedValue({ config: null, canStoreCredentials: true });
  const org = { ...ORG, ...over };
  const r = renderWithCtx(<AiConfigTab org={org} />, {
    api: { embeddingHealth, reindex, getEmbeddingConfig },
  });
  return { ...r, embeddingHealth, reindex };
};

describe('AiConfigTab', () => {
  it('names the provider, the model and the dimension', async () => {
    render(HEALTHY);
    expect(await screen.findByText('ollama')).toBeInTheDocument();
    expect(screen.getByText('mxbai-embed-large:335m')).toBeInTheDocument();
    expect(screen.getByText('localhost:11434')).toBeInTheDocument();
    expect(screen.getByText('1024')).toBeInTheDocument();
  });

  it('says so when the provider is not semantic', async () => {
    // The state an unconfigured install lands in, where "local" reads as
    // healthy and search has quietly stopped being semantic.
    render({
      ...HEALTHY,
      active: { provider: 'local', semantic: false, dimensions: 64, model: null, endpoint: null },
    });
    // Targeted at the panel that describes the ACTIVE provider: the form
    // below says something similar about the one being chosen, and a loose
    // text match would confuse the two.
    expect(await screen.findByTestId('not-semantic-warning')).toBeInTheDocument();
  });

  it('stays quiet about semantics when the provider is one', async () => {
    render(HEALTHY);
    await screen.findByText('ollama');
    expect(screen.queryByTestId('not-semantic-warning')).toBeNull();
  });

  it('reports a clean corpus', async () => {
    render(HEALTHY);
    expect(await screen.findByText(/Everything stored matches/i)).toBeInTheDocument();
    expect(screen.getByText('42 chunks')).toBeInTheDocument();
  });

  it('offers the flip only while a space is being built, and says what is missing', async () => {
    // The button nobody could reach: `activate()` existed in the repository
    // and was tested, and no route or screen called it. A model change left
    // the organisation with a `building` space that could not become live.
    render({
      ...HEALTHY,
      chunks: 42,
      stored: [
        { key: 'live@1024', dimensions: 1024, chunks: 42, state: 'active' as const },
        { key: 'nuevo@384', dimensions: 384, chunks: 10, state: 'building' as const },
      ],
    });
    expect(await screen.findByTestId('embedding-building')).toHaveTextContent('10');
    expect(screen.getByTestId('embedding-building')).toHaveTextContent('42');
    expect(screen.getByText(/Reindex first/i)).toBeInTheDocument();
  });

  it('says it is ready once the new space holds everything', async () => {
    render({
      ...HEALTHY,
      chunks: 42,
      stored: [
        { key: 'live@1024', dimensions: 1024, chunks: 42, state: 'active' as const },
        { key: 'nuevo@384', dimensions: 384, chunks: 42, state: 'building' as const },
      ],
    });
    expect(await screen.findByText(/you can switch back/i)).toBeInTheDocument();
  });

  it('says nothing about flipping when no change is in flight', async () => {
    render(HEALTHY);
    await screen.findByText(/Everything stored matches/i);
    expect(screen.queryByTestId('embedding-building')).not.toBeInTheDocument();
  });

  it('warns when stored vectors do not match the active embedder', async () => {
    render({
      ...HEALTHY,
      stored: [
        { key: 'old@768', dimensions: 768, chunks: 40, state: 'retired' as const },
        { key: 'live@1024', dimensions: 1024, chunks: 2, state: 'active' as const },
      ],
      reindexRequired: true,
    });
    expect(await screen.findByText(/not produced by the active embedder/i)).toBeInTheDocument();
    // Both groups are listed: a half-finished reindex is the state that
    // breaks search for some notes and not others.
    expect(screen.getByText('768 dims')).toBeInTheDocument();
    expect(screen.getByText('1024 dims')).toBeInTheDocument();
  });

  it('counts chunks the embedder never reached', async () => {
    render({ ...HEALTHY, stored: [], chunksWithoutEmbedding: 42, reindexRequired: true });
    expect(await screen.findByText('no embedding')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('reindexes after a confirmation, and re-reads the health', async () => {
    const user = userEvent.setup();
    const { reindex, embeddingHealth } = render({ ...HEALTHY, reindexRequired: true });
    await screen.findByText('ollama');
    expect(embeddingHealth).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /Reindex now/i }));
    await user.click(await screen.findByRole('button', { name: 'Reindex' }));

    await waitFor(() => expect(reindex).toHaveBeenCalledWith({ orgId: 'org-1' }));
    expect(await screen.findByText(/Re-embedded 7 notes/i)).toBeInTheDocument();
    // The panel must not keep showing the state it just changed.
    expect(embeddingHealth).toHaveBeenCalledTimes(2);
  });

  it('does not reindex when the confirmation is declined', async () => {
    const user = userEvent.setup();
    const { reindex } = render({ ...HEALTHY, reindexRequired: true });
    await screen.findByText('ollama');

    await user.click(screen.getByRole('button', { name: /Reindex now/i }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(reindex).not.toHaveBeenCalled();
  });

  it('offers no reindex button to a member', async () => {
    render(HEALTHY, { role: 'org_member' } as Partial<OrganizationWithRole>);
    await screen.findByText('ollama');
    expect(screen.getByRole('button', { name: /Reindex now/i })).toBeDisabled();
    expect(screen.getByText(/Only an organisation admin/i)).toBeInTheDocument();
  });

  it('surfaces a failure instead of showing stale numbers', async () => {
    const embeddingHealth = vi.fn().mockRejectedValue(new Error('boom'));
    const getEmbeddingConfig = vi.fn().mockResolvedValue({ config: null, canStoreCredentials: true });
    renderWithCtx(<AiConfigTab org={ORG} />, { api: { embeddingHealth, getEmbeddingConfig } });
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
