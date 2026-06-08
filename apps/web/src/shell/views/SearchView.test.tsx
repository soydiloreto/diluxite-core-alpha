import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchView } from './SearchView';
import { renderWithCtx, makeNote } from '../../../test/render-with-ctx';
import type { ApiClient, Note } from '../../api';

function makeApiStub(notes: Note[]): ApiClient {
  return {
    async updateNote(id: string, payload: Partial<Pick<Note, 'title' | 'contentMd'>>) {
      const i = notes.findIndex((n) => n.id === id);
      if (i === -1) throw new Error('not found');
      const next: Note = {
        ...notes[i],
        ...(payload.contentMd !== undefined ? { contentMd: payload.contentMd } : {}),
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        updatedAt: new Date().toISOString(),
      };
      notes[i] = next;
      return next;
    },
  } as unknown as ApiClient;
}

beforeEach(() => {
  // scrollIntoView is poked by cmdk's keyboard handlers (Item focus).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).scrollIntoView = vi.fn();
});

describe('SearchView', () => {
  it('shows a hint and no results when the query is empty', () => {
    renderWithCtx(<SearchView />, {
      notes: [makeNote({ contentMd: '# Hello\nworld' })],
    });
    expect(screen.getByText(/Type to search across all notes/i)).toBeInTheDocument();
  });

  it('seeds the query from a #tag click and immediately lists matches', () => {
    renderWithCtx(<SearchView seed={{ q: '#ddd', nonce: 1 }} />, {
      notes: [
        makeNote({ title: 'Tagged', contentMd: '# Tagged\nsomething #ddd here' }),
        makeNote({ title: 'Untagged', contentMd: '# Untagged\nnothing relevant' }),
      ],
    });
    // The search box is pre-filled with the tag the user clicked…
    expect(screen.getByDisplayValue('#ddd')).toBeInTheDocument();
    // …and it surfaces the note carrying that tag (the full /search, not a
    // truncated dropdown).
    expect(screen.getByText('Tagged')).toBeInTheDocument();
    expect(screen.queryByText('Untagged')).not.toBeInTheDocument();
  });

  it('lists matches grouped by note with line numbers', async () => {
    const user = userEvent.setup();
    const a = makeNote({ title: 'Alpha', contentMd: '# Alpha\nazure is the cloud' });
    const b = makeNote({ title: 'Bravo', contentMd: 'no match here' });
    renderWithCtx(<SearchView />, { notes: [a, b] });
    await user.type(screen.getByPlaceholderText('Search'), 'azure');

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    // line number prefix for the match (rendered as "  2:" with padding).
    expect(screen.getByText(/^\s*2:\s*$/)).toBeInTheDocument();
    expect(screen.queryByText('Bravo')).toBeNull();
  });

  it('whole word toggle: "lake" does not match "lakes" when enabled', async () => {
    const user = userEvent.setup();
    renderWithCtx(<SearchView />, {
      notes: [makeNote({ contentMd: 'lakes\nlake\nlake side' })],
    });
    await user.type(screen.getByPlaceholderText('Search'), 'lake');
    // 3 matches by default (substring matches "lakes" too).
    let badge = screen.getByText(/3 matches in 1 note/);
    expect(badge).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /whole word/i }));
    badge = await screen.findByText(/2 matches in 1 note/);
    expect(badge).toBeInTheDocument();
  });

  it('case-sensitive toggle filters mixed-case content', async () => {
    const user = userEvent.setup();
    renderWithCtx(<SearchView />, {
      notes: [makeNote({ contentMd: 'Azure\nazure\nAZURE' })],
    });
    await user.type(screen.getByPlaceholderText('Search'), 'Azure');
    expect(screen.getByText(/3 matches/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /match case/i }));
    expect(await screen.findByText(/1 match in 1 note/)).toBeInTheDocument();
  });

  it('regex toggle: invalid pattern surfaces a readable error', async () => {
    const user = userEvent.setup();
    renderWithCtx(<SearchView />, { notes: [makeNote({ contentMd: 'abc' })] });
    await user.click(screen.getByRole('button', { name: /regular expression/i }));
    // `[` is a userEvent keyboard descriptor delimiter — escape with `{[}`.
    await user.type(screen.getByPlaceholderText('Search'), '{[}');
    expect(await screen.findByText(/invalid regular expression/i)).toBeInTheDocument();
  });

  it('clicking a match opens the note', async () => {
    const user = userEvent.setup();
    const openNote = vi.fn();
    const a = makeNote({ title: 'Alpha', contentMd: '# Alpha\nfoo' });
    renderWithCtx(<SearchView />, { notes: [a], openNote });
    await user.type(screen.getByPlaceholderText('Search'), 'foo');
    await user.click(screen.getByText('foo'));
    expect(openNote).toHaveBeenCalledWith(a.id);
  });

  it('Replace All calls api.updateNote for every match and triggers refreshAll (no page reload)', async () => {
    const user = userEvent.setup();
    const a = makeNote({ title: 'A', contentMd: 'aaa foo bbb' });
    const b = makeNote({ title: 'B', contentMd: 'foo foo' });
    const c = makeNote({ title: 'C', contentMd: 'nothing here' });
    const all = [a, b, c];
    const api = makeApiStub(all);
    const updateSpy = vi.spyOn(api, 'updateNote');
    const refreshAll = vi.fn().mockResolvedValue(undefined);
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });

    renderWithCtx(<SearchView />, { notes: all, api, refreshAll });
    await user.type(screen.getByPlaceholderText('Search'), 'foo');
    await user.click(screen.getByRole('button', { name: /show replace/i }));
    await user.type(screen.getByPlaceholderText('Replace'), 'bar');
    // The button label is "Replace (N)" while there are matches.
    await user.click(screen.getByRole('button', { name: /^Replace \(\d+\)$/ }));

    // The confirm dialog uses the default `danger` label ("Delete") for OK.
    const confirm = await screen.findByTestId('confirm-dialog');
    const buttons = within(confirm).getAllByRole('button');
    // The first non-Cancel button is the destructive confirm action.
    const okBtn = buttons.find((b) => b.textContent !== 'Cancel');
    expect(okBtn).toBeDefined();
    await user.click(okBtn!);

    await waitFor(() => expect(refreshAll).toHaveBeenCalled());
    // Only the 2 notes containing "foo" are updated.
    const callTargets = updateSpy.mock.calls.map((c) => c[0]).sort();
    expect(callTargets).toEqual([a.id, b.id].sort());
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
