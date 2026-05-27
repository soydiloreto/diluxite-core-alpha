import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TopBar, type TopBarHandle } from './TopBar';
import { renderWithCtx, makeNote } from '../../test/render-with-ctx';

beforeEach(() => {
  // cmdk's Item focuses itself with scrollIntoView; jsdom doesn't implement it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).scrollIntoView = vi.fn();
});

describe('TopBar', () => {
  it('shows the brand label and a search input', () => {
    renderWithCtx(<TopBar onNewNote={() => {}} />);
    expect(screen.getByText('DILUXITE')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search notes/i)).toBeInTheDocument();
  });

  it('renders a custom brand label when provided', () => {
    renderWithCtx(<TopBar onNewNote={() => {}} brandLabel="Vault" />);
    expect(screen.getByText('VAULT')).toBeInTheDocument();
  });

  it('default mode: typing filters notes by title', async () => {
    const user = userEvent.setup();
    const openNote = vi.fn();
    const a = makeNote({ title: 'Azure' });
    const b = makeNote({ title: 'Kubernetes' });
    renderWithCtx(<TopBar onNewNote={() => {}} />, { notes: [a, b], openNote });

    const input = screen.getByPlaceholderText(/Search notes/i);
    await user.click(input);
    await user.type(input, 'azu');
    expect(await screen.findByText('Azure')).toBeInTheDocument();
    expect(screen.queryByText('Kubernetes')).toBeNull();
  });

  it('command mode (>): suggests built-in commands', async () => {
    const user = userEvent.setup();
    const onNewNote = vi.fn();
    renderWithCtx(<TopBar onNewNote={onNewNote} />);
    const input = screen.getByPlaceholderText(/Search notes/i);
    await user.click(input);
    await user.type(input, '>');
    expect(await screen.findByText('New note')).toBeInTheDocument();
    expect(screen.getByText('Open graph')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();

    await user.click(screen.getByText('New note'));
    expect(onNewNote).toHaveBeenCalledTimes(1);
  });

  it('tag mode (#): lists tags with their counts', async () => {
    const user = userEvent.setup();
    renderWithCtx(<TopBar onNewNote={() => {}} />, {
      notes: [makeNote()],
      tags: [
        { tag: 'azure', count: 3 },
        { tag: 'kubernetes', count: 1 },
      ],
    });
    const input = screen.getByPlaceholderText(/Search notes/i);
    await user.click(input);
    await user.type(input, '#');
    expect(await screen.findByText('#azure')).toBeInTheDocument();
    expect(screen.getByText('#kubernetes')).toBeInTheDocument();
    expect(screen.getByText('3 notes')).toBeInTheDocument();
  });

  it('opens a note when clicking a result', async () => {
    const user = userEvent.setup();
    const openNote = vi.fn();
    const a = makeNote({ title: 'Pick me' });
    renderWithCtx(<TopBar onNewNote={() => {}} />, { notes: [a], openNote });
    const input = screen.getByPlaceholderText(/Search notes/i);
    await user.click(input);
    await user.click(await screen.findByText('Pick me'));
    expect(openNote).toHaveBeenCalledWith(a.id);
  });

  it('focusSearch(prefix) (via ref) opens the dropdown with the prefix pre-filled', async () => {
    const ref = createRef<TopBarHandle>();
    renderWithCtx(<TopBar ref={ref} onNewNote={() => {}} />, {
      notes: [makeNote()],
      tags: [{ tag: 'azure', count: 1 }],
    });
    act(() => ref.current?.focusSearch('#az'));
    // After the focus call the dropdown's `Tags` group lists matching tags.
    await waitFor(() => expect(screen.getByText('#azure')).toBeInTheDocument());
    const input = screen.getByPlaceholderText(/Search notes/i) as HTMLInputElement;
    expect(input.value).toBe('#az');
  });

  it('Escape closes the dropdown', async () => {
    const user = userEvent.setup();
    renderWithCtx(<TopBar onNewNote={() => {}} />, { notes: [makeNote({ title: 'X' })] });
    const input = screen.getByPlaceholderText(/Search notes/i);
    await user.click(input);
    expect(await screen.findByText('X')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('X')).toBeNull();
  });

  it('shows a "clear search" affordance once there is text and clears on click', async () => {
    const user = userEvent.setup();
    renderWithCtx(<TopBar onNewNote={() => {}} />, { notes: [makeNote()] });
    const input = screen.getByPlaceholderText(/Search notes/i) as HTMLInputElement;
    await user.click(input);
    await user.type(input, 'abc');
    expect(input.value).toBe('abc');
    await user.click(screen.getByRole('button', { name: 'clear search' }));
    expect(input.value).toBe('');
  });
});
