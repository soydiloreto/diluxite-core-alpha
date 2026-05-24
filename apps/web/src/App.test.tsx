import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createFakeApi } from './fakeApi';

describe('App', () => {
  it('muestra las notas existentes al cargar', async () => {
    const api = createFakeApi();
    await api.createNote('space-1', 'Azure', 'la nube');
    render(<App api={api} />);
    expect(await screen.findByRole('button', { name: 'Azure' })).toBeInTheDocument();
  });

  it('crea una nota nueva y la abre', async () => {
    const user = userEvent.setup();
    render(<App api={createFakeApi()} />);
    await user.type(screen.getByLabelText('nueva nota'), 'MUG');
    await user.click(screen.getByRole('button', { name: 'Crear' }));
    expect(await screen.findByRole('button', { name: 'MUG' })).toBeInTheDocument();
    // h2 del editor (nivel 2) abierto con el título
    expect(screen.getByRole('heading', { name: 'MUG', level: 2 })).toBeInTheDocument();
  });

  it('abre una nota y renderiza wikilinks en el preview', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote('space-1', 'Azure', 'contenido');
    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: 'Azure' }));
    fireEvent.change(screen.getByLabelText('contenido'), { target: { value: 'ver [[MUG]]' } });
    const preview = screen.getByTestId('preview');
    await waitFor(() => expect(preview.querySelector('a.wikilink')).toBeTruthy());
    expect(preview.querySelector('a.wikilink')?.getAttribute('data-note')).toBe('MUG');
  });

  it('guarda al perder el foco (blur)', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    const note = await api.createNote('space-1', 'T', 'v1');
    const spy = vi.spyOn(api, 'updateNote');
    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: 'T' }));
    const ta = screen.getByLabelText('contenido');
    fireEvent.change(ta, { target: { value: 'v2' } });
    fireEvent.blur(ta);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(note.id, { contenidoMd: 'v2' }));
  });

  it('busca y muestra solo los resultados que matchean', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote('space-1', 'Azure', 'la nube de microsoft');
    await api.createNote('space-1', 'Cocina', 'recetas caseras');
    render(<App api={api} />);
    await screen.findByRole('button', { name: 'Azure' });
    await user.type(screen.getByLabelText('buscar'), 'microsoft');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    const resultados = await screen.findByTestId('resultados');
    expect(resultados).toHaveTextContent('Azure');
    expect(resultados).not.toHaveTextContent('Cocina');
  });

  it('borra una nota', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote('space-1', 'Borrame', '');
    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: 'borrar Borrame' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Borrame' })).not.toBeInTheDocument(),
    );
  });
});
