import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createFakeApi } from './fakeApi';

const SPACE = 'space-1';

describe('App (UI completa)', () => {
  beforeEach(() => localStorage.clear());

  it('carga las notas existentes', async () => {
    const api = createFakeApi();
    await api.createNote(SPACE, 'Azure', 'la nube');
    render(<App api={api} />);
    const notas = await screen.findByTestId('notas');
    expect(within(notas).getByRole('button', { name: 'Azure' })).toBeInTheDocument();
  });

  it('crea una nota y la abre en el editor', async () => {
    const user = userEvent.setup();
    render(<App api={createFakeApi()} />);
    await user.type(screen.getByLabelText('nueva nota'), 'MUG');
    await user.click(screen.getByRole('button', { name: 'Crear' }));
    expect(await screen.findByRole('heading', { name: 'MUG', level: 2 })).toBeInTheDocument();
  });

  it('renderiza wikilinks en el preview', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'Azure', 'contenido');
    render(<App api={api} />);
    await user.click(within(await screen.findByTestId('notas')).getByRole('button', { name: 'Azure' }));
    fireEvent.change(screen.getByLabelText('contenido'), { target: { value: 'ver [[MUG]]' } });
    const preview = screen.getByTestId('preview');
    await waitFor(() => expect(preview.querySelector('a.wikilink')).toBeTruthy());
    expect(preview.querySelector('a.wikilink')?.getAttribute('data-note')).toBe('MUG');
  });

  it('borra una nota pidiendo confirmación', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'Borrame', 'x');
    render(<App api={api} />);
    await user.click(within(await screen.findByTestId('notas')).getByRole('button', { name: 'Borrame' }));
    await user.click(screen.getByRole('button', { name: 'Borrar' }));
    // aparece la confirmación
    await user.click(screen.getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() =>
      expect(within(screen.getByTestId('notas')).queryByRole('button', { name: 'Borrame' })).toBeNull(),
    );
  });

  it('busca y filtra la lista', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'Azure', 'la nube de microsoft');
    await api.createNote(SPACE, 'Cocina', 'recetas');
    render(<App api={api} />);
    await screen.findByTestId('notas');
    await user.type(screen.getByLabelText('buscar'), 'microsoft');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(screen.getByTestId('filtro')).toBeInTheDocument());
    const notas = screen.getByTestId('notas');
    expect(within(notas).getByRole('button', { name: 'Azure' })).toBeInTheDocument();
    expect(within(notas).queryByRole('button', { name: 'Cocina' })).toBeNull();
  });

  it('filtra por tag', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'Infra', 'usa #cloud');
    await api.createNote(SPACE, 'Otra', 'sin tags');
    render(<App api={api} />);
    const tags = await screen.findByTestId('tags');
    await user.click(within(tags).getByRole('button', { name: /#cloud/ }));
    await waitFor(() => expect(screen.getByTestId('filtro')).toBeInTheDocument());
    const notas = screen.getByTestId('notas');
    expect(within(notas).getByRole('button', { name: 'Infra' })).toBeInTheDocument();
    expect(within(notas).queryByRole('button', { name: 'Otra' })).toBeNull();
  });

  it('muestra backlinks de la nota abierta', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'MUG', 'grupo');
    await api.createNote(SPACE, 'Azure', 'ver [[MUG]]');
    render(<App api={api} />);
    await user.click(within(await screen.findByTestId('notas')).getByRole('button', { name: 'MUG' }));
    const backlinks = await screen.findByTestId('backlinks');
    await waitFor(() => expect(within(backlinks).getByRole('button', { name: 'Azure' })).toBeInTheDocument());
  });

  it('la pestaña Grafo lista los nodos', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'MUG', 'grupo');
    await api.createNote(SPACE, 'Azure', 'ver [[MUG]]');
    render(<App api={api} />);
    await screen.findByTestId('notas');
    await user.click(screen.getByRole('button', { name: 'Grafo' }));
    const nodes = await screen.findByTestId('graph-nodes');
    expect(within(nodes).getByRole('button', { name: 'MUG' })).toBeInTheDocument();
    expect(within(nodes).getByRole('button', { name: 'Azure' })).toBeInTheDocument();
  });

  it('Inicio explica el producto y permite conectar la IA', async () => {
    const user = userEvent.setup();
    render(<App api={createFakeApi()} />);
    const connect = await screen.findByTestId('connect');
    expect(screen.getByTestId('mcp-url')).toHaveTextContent('/mcp');
    await user.click(within(connect).getByRole('button', { name: 'Generar token' }));
    expect(await screen.findByTestId('home-token')).toBeInTheDocument();
    expect(screen.getByTestId('home-stats')).toBeInTheDocument();
  });

  it('Ajustes tiene opciones reales y aplica el tema', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'X', 'contenido #t y [[Y]]');
    render(<App api={api} />);
    await user.click(screen.getByRole('button', { name: 'Ajustes' }));
    expect(await screen.findByLabelText('tema')).toBeInTheDocument();
    expect(screen.getByLabelText('modo búsqueda')).toBeInTheDocument();
    expect(screen.getByLabelText('topK')).toBeInTheDocument();
    expect(screen.getByTestId('embedder')).toHaveTextContent('local');
    expect(screen.getByTestId('space-stats')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Exportar/ })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('tema'), 'claro');
    expect(document.documentElement.dataset.theme).toBe('claro');
  });

  it('la pestaña Ajustes muestra el endpoint MCP y genera token', async () => {
    const user = userEvent.setup();
    render(<App api={createFakeApi()} />);
    await user.click(screen.getByRole('button', { name: 'Ajustes' }));
    expect(await screen.findByTestId('mcp-url')).toHaveTextContent('/mcp');
    await user.type(screen.getByLabelText('nombre token'), 'Claude');
    await user.click(within(screen.getByRole('heading', { name: 'Conexión MCP' }).closest('section')!).getByRole('button', { name: 'Generar token' }));
    expect(await screen.findByTestId('nuevo-token')).toBeInTheDocument();
  });
});
