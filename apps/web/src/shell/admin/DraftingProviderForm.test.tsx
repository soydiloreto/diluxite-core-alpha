import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DraftingProviderForm } from './DraftingProviderForm';
import { renderWithCtx } from '../../../test/render-with-ctx';
import type { ApiClient, GenerationConfig } from '../../api';

const stored: GenerationConfig = {
  orgId: 'o1',
  provider: 'ollama',
  model: 'llama',
  endpoint: 'http://x/v1/chat/completions',
  hasApiKey: true,
  updatedAt: new Date().toISOString(),
};

function apiWith(over: Partial<ApiClient>): ApiClient {
  return {
    generationConfig: vi.fn().mockResolvedValue(null),
    saveGenerationConfig: vi.fn().mockResolvedValue(stored),
    clearGenerationConfig: vi.fn().mockResolvedValue({ ok: true }),
    testGenerationConfig: vi.fn().mockResolvedValue({ ok: true, claim: 'El umbral es 3%' }),
    ...over,
  } as unknown as ApiClient;
}

describe('DraftingProviderForm', () => {
  it('says what the provider does and that leaving it empty still works', async () => {
    renderWithCtx(<DraftingProviderForm orgId="o1" />, { api: apiWith({}) });
    expect(await screen.findByText(/never decides whether something is true/i)).toBeInTheDocument();
    expect(screen.getByText(/still works/i)).toBeInTheDocument();
  });

  it('saving without typing a key does NOT send one', async () => {
    const saveGenerationConfig = vi.fn().mockResolvedValue(stored);
    const api = apiWith({
      generationConfig: vi.fn().mockResolvedValue(stored),
      saveGenerationConfig,
    });
    renderWithCtx(<DraftingProviderForm orgId="o1" />, { api });
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('llama'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    // An empty box means "keep the stored key", never "erase it".
    await waitFor(() =>
      expect(saveGenerationConfig).toHaveBeenCalledWith('o1', {
        provider: 'ollama',
        model: 'llama',
        endpoint: 'http://x/v1/chat/completions',
      }),
    );
  });

  it('a typed key is sent', async () => {
    const saveGenerationConfig = vi.fn().mockResolvedValue(stored);
    const api = apiWith({
      generationConfig: vi.fn().mockResolvedValue(stored),
      saveGenerationConfig,
    });
    renderWithCtx(<DraftingProviderForm orgId="o1" />, { api });
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('llama'));
    await userEvent.type(screen.getByLabelText('API key'), 'sk-nueva');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saveGenerationConfig).toHaveBeenCalledWith(
        'o1',
        expect.objectContaining({ apiKey: 'sk-nueva' }),
      ),
    );
  });

  it('trying it once shows what it drafted', async () => {
    const api = apiWith({ generationConfig: vi.fn().mockResolvedValue(stored) });
    renderWithCtx(<DraftingProviderForm orgId="o1" />, { api });
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('llama'));
    await userEvent.click(screen.getByRole('button', { name: /Try it once/i }));
    expect(await screen.findByText(/El umbral es 3%/)).toBeInTheDocument();
  });

  it('nothing configured offers no Remove button', async () => {
    renderWithCtx(<DraftingProviderForm orgId="o1" />, { api: apiWith({}) });
    await screen.findByLabelText('Model');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('saving is refused until endpoint and model are filled in', async () => {
    renderWithCtx(<DraftingProviderForm orgId="o1" />, { api: apiWith({}) });
    await screen.findByLabelText('Model');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
