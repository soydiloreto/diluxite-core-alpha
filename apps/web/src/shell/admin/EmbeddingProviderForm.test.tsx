import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithCtx } from '../../../test/render-with-ctx';
import { EmbeddingProviderForm } from './EmbeddingProviderForm';

/**
 * The form that chooses the embedding provider — ADR-003.
 *
 * Most of these are about what it must NOT let happen. A form that cheerfully
 * accepts a model switch is one click from a search that returns nothing while
 * reporting success, and the person clicking has no way to know.
 */

const config = (over: Record<string, unknown> = {}) => ({
  provider: 'ollama',
  model: 'mxbai-embed-large',
  dimensions: 1024,
  endpoint: 'http://localhost:11434',
  hasApiKey: false,
  updatedAt: new Date().toISOString(),
  updatedBy: null,
  ...over,
});

const setup = (over: Record<string, unknown> = {}) => {
  const getEmbeddingConfig = vi
    .fn()
    .mockResolvedValue({ config: null, canStoreCredentials: true, ...over });
  const setEmbeddingConfig = vi.fn().mockResolvedValue({
    config: config(),
    model: { key: 'ollama:mxbai-embed-large@1024', state: 'building' },
    nextStep: 'reindex-then-activate',
  });
  const testEmbeddingProvider = vi
    .fn()
    .mockResolvedValue({ ok: true, dimensions: 1024, expected: 1024, elapsedMs: 42, error: null });
  const r = renderWithCtx(<EmbeddingProviderForm />, {
    api: { getEmbeddingConfig, setEmbeddingConfig, testEmbeddingProvider },
  });
  return { ...r, getEmbeddingConfig, setEmbeddingConfig, testEmbeddingProvider };
};

describe('EmbeddingProviderForm', () => {
  it('says what each provider means for the data, before it is chosen', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('embedding provider');

    // For a company's second brain, "the text travels to Microsoft" is a
    // business decision. It belongs on the screen, not in a doc nobody opens.
    await user.selectOptions(screen.getByLabelText('embedding provider'), 'azure');
    expect(screen.getByText(/travels to Microsoft/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('embedding provider'), 'ollama');
    expect(screen.getByText(/None of your notes leaves it/i)).toBeInTheDocument();
  });

  it('warns that the deterministic provider is not semantic', async () => {
    setup();
    // It is the default, and it looks healthy. That is exactly the problem.
    expect(await screen.findByText(/Hashes words rather than meaning/i)).toBeInTheDocument();
  });

  it('asks only for the fields the chosen provider needs', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('embedding provider');

    expect(screen.queryByLabelText('model')).toBeNull();
    expect(screen.queryByLabelText('api key')).toBeNull();

    await user.selectOptions(screen.getByLabelText('embedding provider'), 'bedrock');
    expect(screen.getByLabelText('model')).toBeInTheDocument();
    expect(screen.getByLabelText('region')).toBeInTheDocument();
    expect(screen.getByLabelText('api key')).toBeInTheDocument();
  });

  it('tests the provider and reports what came back', async () => {
    const user = userEvent.setup();
    const { testEmbeddingProvider } = setup();
    await screen.findByLabelText('embedding provider');

    await user.click(screen.getByRole('button', { name: /Test connection/i }));
    await waitFor(() => expect(testEmbeddingProvider).toHaveBeenCalled());
    expect(await screen.findByTestId('embedding-test-result')).toHaveTextContent(/dimensions/);
  });

  it('surfaces a dimension mismatch, which would index fine and break every search', async () => {
    const user = userEvent.setup();
    const testEmbeddingProvider = vi.fn().mockResolvedValue({
      ok: false,
      dimensions: 768,
      expected: 1024,
      elapsedMs: 30,
      error: 'the provider returned 768 dimensions, not 1024',
    });
    renderWithCtx(<EmbeddingProviderForm />, {
      api: {
        getEmbeddingConfig: vi.fn().mockResolvedValue({ config: config(), canStoreCredentials: true }),
        testEmbeddingProvider,
      },
    });
    await screen.findByLabelText('embedding provider');

    await user.click(screen.getByRole('button', { name: /Test connection/i }));
    expect(await screen.findByTestId('embedding-test-result')).toHaveTextContent(
      /768 dimensions, not 1024/,
    );
  });

  it('warns BEFORE saving that this changes the vector space', async () => {
    const user = userEvent.setup();
    const { setEmbeddingConfig } = setup({
      config: config({ provider: 'local', model: null, dimensions: 1536 }),
    });
    await screen.findByLabelText('embedding provider');

    await user.selectOptions(screen.getByLabelText('embedding provider'), 'ollama');
    await user.type(screen.getByLabelText('model'), 'mxbai-embed-large');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // A confirmation that explains the consequence, not a generic "are you sure".
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/KEEPS answering from the current model/i);
    expect(setEmbeddingConfig).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setEmbeddingConfig).toHaveBeenCalled());
    expect(await screen.findByTestId('embedding-saved')).toHaveTextContent(/reindex to fill it/i);
  });

  it('does not ask for confirmation when only the endpoint changed', async () => {
    // Same vector space: nothing to warn about, and a needless confirmation
    // is how people learn to click through the ones that matter.
    const user = userEvent.setup();
    const { setEmbeddingConfig } = setup({ config: config() });
    await screen.findByLabelText('embedding provider');

    const endpoint = screen.getByLabelText('endpoint');
    await user.clear(endpoint);
    await user.type(endpoint, 'http://otro:11434');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setEmbeddingConfig).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not send an empty key, so an edit cannot erase the stored one', async () => {
    const user = userEvent.setup();
    const { setEmbeddingConfig } = setup({
      config: config({ provider: 'azure', model: 'te3l', endpoint: 'https://a', hasApiKey: true }),
    });
    await screen.findByLabelText('embedding provider');

    const endpoint = screen.getByLabelText('endpoint');
    await user.clear(endpoint);
    await user.type(endpoint, 'https://b');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setEmbeddingConfig).toHaveBeenCalled());
    expect(setEmbeddingConfig.mock.calls[0][0]).not.toHaveProperty('apiKey');
  });

  it('refuses to offer a save it knows cannot work', async () => {
    const user = userEvent.setup();
    setup({ config: null, canStoreCredentials: false });
    await screen.findByLabelText('embedding provider');

    await user.selectOptions(screen.getByLabelText('embedding provider'), 'azure');
    await user.type(screen.getByLabelText('model'), 'te3l');
    await user.type(screen.getByLabelText('endpoint'), 'https://a');

    expect(screen.getByRole('alert')).toHaveTextContent(/DILUXITE_SECRET_KEY/);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps the save button out of reach while the form is incomplete', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('embedding provider');
    await user.selectOptions(screen.getByLabelText('embedding provider'), 'ollama');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(screen.getByLabelText('model'), 'mxbai');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
