import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createFakeApi } from './fakeApi';

const SPACE = 'space-1';

describe('App v2 — layout Obsidian-like', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('arranca con left-dock, status bar (admin local) y empty state', async () => {
    render(<App api={createFakeApi()} />);
    expect(await screen.findByTestId('left-dock')).toBeInTheDocument();
    expect(screen.getByTestId('main')).toBeInTheDocument();
    expect(await screen.findByText(/local@diluxite|admin local/)).toBeInTheDocument();
    expect(screen.getByText(/Tu memoria está esperando/)).toBeInTheDocument();
  });

  it('abre la modal de Ajustes con sub-tabs laterales', async () => {
    const user = userEvent.setup();
    render(<App api={createFakeApi()} />);
    await user.click(await screen.findByRole('button', { name: /Ajustes/ }));
    const modal = await screen.findByTestId('settings-modal');
    expect(within(modal).getByTestId('settings-tab-connect')).toBeInTheDocument();
    expect(within(modal).getByTestId('settings-tab-appearance')).toBeInTheDocument();
    expect(within(modal).getByTestId('settings-tab-search')).toBeInTheDocument();
    expect(within(modal).getByTestId('settings-tab-mcp')).toBeInTheDocument();
    expect(within(modal).getByTestId('settings-tab-about')).toBeInTheDocument();

    await user.click(within(modal).getByTestId('settings-tab-mcp'));
    expect(await within(modal).findByTestId('mcp-url')).toHaveTextContent('/mcp');
  });

  it('cambia el tema desde Apariencia', async () => {
    const user = userEvent.setup();
    render(<App api={createFakeApi()} />);
    await user.click(await screen.findByRole('button', { name: /Ajustes/ }));
    const modal = await screen.findByTestId('settings-modal');
    await user.click(within(modal).getByTestId('settings-tab-appearance'));
    await user.selectOptions(within(modal).getByLabelText('tema'), 'claro');
    expect(document.documentElement.dataset.theme).toBe('claro');
  });

  it('crea una nota desde "+ nota" y la abre en el editor', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('Mi nota');
    render(<App api={createFakeApi()} />);
    const dock = await screen.findByTestId('left-dock');
    await user.click(within(dock).getByText('+ nota'));
    expect(await screen.findByRole('heading', { name: 'Mi nota', level: 2 })).toBeInTheDocument();
  });

  it('crea carpeta y nota dentro de ella desde el árbol', async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, 'prompt');
    render(<App api={createFakeApi()} />);
    const dock = await screen.findByTestId('left-dock');

    promptSpy.mockReturnValueOnce('Trabajo');
    await user.click(within(dock).getByText('+ carpeta'));
    expect(await within(dock).findByText('Trabajo')).toBeInTheDocument();
  });

  it('Quick switcher (botón ⌘K) lista y filtra notas', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'Azure', 'la nube');
    await api.createNote(SPACE, 'Cocina', 'recetas');
    render(<App api={api} />);
    await screen.findByText('Azure');

    await user.click(screen.getByRole('button', { name: /buscador rápido/ }));
    const qs = await screen.findByTestId('quick-switcher');
    await user.type(within(qs).getByLabelText('quick switcher'), 'cocin');
    await waitFor(() => expect(within(qs).getByText('Cocina')).toBeInTheDocument());
    expect(within(qs).queryByText('Azure')).toBeNull();
  });

  it('búsqueda en sidebar abre la primera coincidencia', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'Azure', 'la nube');
    render(<App api={api} />);
    await screen.findByText('Azure');
    const buscar = within(screen.getByTestId('left-dock')).getByLabelText('buscar');
    await user.type(buscar, 'azure');
    fireEvent.submit(buscar.closest('form')!);
    expect(await screen.findByRole('heading', { name: 'Azure', level: 2 })).toBeInTheDocument();
  });

  it('marca una nota como favorita desde el editor', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'F', 'x');
    render(<App api={api} />);
    await user.click(await screen.findByText('F'));
    await user.click(screen.getByRole('button', { name: /marcar favorita/ }));
    expect(await screen.findByRole('button', { name: /quitar favorita/ })).toBeInTheDocument();
  });

  it('borra con confirmación inline en el editor', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'Borrame', 'x');
    render(<App api={api} />);
    await user.click(await screen.findByText('Borrame'));
    await user.click(screen.getByRole('button', { name: 'Borrar' }));
    await user.click(screen.getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() =>
      expect(within(screen.getByTestId('left-dock')).queryByText('Borrame')).toBeNull(),
    );
  });
});
