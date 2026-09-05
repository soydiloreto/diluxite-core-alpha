import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchView } from './SearchView';
import { renderWithCtx, makeNote } from '../../../test/render-with-ctx';
import { DialogProvider } from '../../ui';
import { AppProvider } from '../AppContext';
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

/** Render SearchView with a re-render that keeps the same providers + ctx. */
function renderSearch(props: { focusNonce?: number } = {}) {
  const r = renderWithCtx(<SearchView {...props} />, {
    notes: [makeNote({ title: 'Alpha', contentMd: 'azure' })],
  });
  return {
    ...r,
    rerenderWithCtx: (next: { focusNonce?: number }) =>
      r.rerender(
        <DialogProvider>
          <AppProvider value={r.ctx}>
            <SearchView {...next} />
          </AppProvider>
        </DialogProvider>,
      ),
  };
}

/** Type into the search box and wait out the debounce. */
async function typeQuery(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByPlaceholderText('Search'), text);
  await waitFor(() => expect(screen.queryByTestId('search-skeleton')).toBeNull());
}

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

  it('shows a skeleton while the query is settling, then the matches', async () => {
    renderWithCtx(<SearchView />, {
      notes: [makeNote({ title: 'Alpha', contentMd: 'azure is the cloud' })],
    });
    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'azure' } });

    expect(screen.getByTestId('search-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).toBeNull();

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByTestId('search-skeleton')).toBeNull();
  });

  it('clearing the box returns to the hint without flashing a skeleton', async () => {
    renderWithCtx(<SearchView />, {
      notes: [makeNote({ title: 'Alpha', contentMd: 'azure' })],
    });
    const box = screen.getByPlaceholderText('Search');
    fireEvent.change(box, { target: { value: 'azure' } });
    expect(await screen.findByText('Alpha')).toBeInTheDocument();

    fireEvent.change(box, { target: { value: '' } });
    expect(screen.queryByTestId('search-skeleton')).toBeNull();
    expect(screen.getByText(/Type to search across all notes/i)).toBeInTheDocument();
  });

  it('Replace all stays disabled while the query is still settling', async () => {
    const user = userEvent.setup();
    renderWithCtx(<SearchView />, { notes: [makeNote({ contentMd: 'foo' })] });
    await user.click(screen.getByRole('button', { name: /show replace/i }));
    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'foo' } });

    expect(screen.getByRole('button', { name: /^Replace/ })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Replace \(\d+\)$/ })).toBeEnabled(),
    );
  });

  it('focusNonce bumps re-focus the search box and select what is in it', async () => {
    const { rerenderWithCtx } = renderSearch({ focusNonce: 1 });
    const box = screen.getByPlaceholderText('Search') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'azure' } });
    box.blur();
    expect(document.activeElement).not.toBe(box);

    rerenderWithCtx({ focusNonce: 2 });
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe('azure'.length);
  });

  it('caps how many match rows reach the DOM, and Show more raises the cap', async () => {
    const user = userEvent.setup();
    // 500 matching lines. Rendering them all is what froze the panel for
    // seconds — the scan over this is sub-millisecond.
    const body = Array.from({ length: 500 }, (_, i) => `line ${i} azure`).join('\n');
    renderWithCtx(<SearchView />, { notes: [makeNote({ title: 'Big', contentMd: body })] });

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'azure' } });
    expect(await screen.findByText(/500 matches in 1 note/)).toBeInTheDocument();
    expect(screen.getAllByRole('mark')).toHaveLength(100);
    expect(screen.getByText('Showing 100 of 500')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getAllByRole('mark')).toHaveLength(500);
    expect(screen.queryByText(/^Showing /)).toBeNull();
  });

  it('windows a very long matching line instead of rendering all of it', async () => {
    const line = `${'x'.repeat(5000)}azure${'y'.repeat(5000)}`;
    renderWithCtx(<SearchView />, { notes: [makeNote({ title: 'Long', contentMd: line })] });

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'azure' } });
    expect(await screen.findByText(/1 match in 1 note/)).toBeInTheDocument();
    const row = screen.getByRole('mark').closest('button');
    expect(row?.textContent?.length ?? 0).toBeLessThan(400);
    expect(row?.textContent).toContain('…');
  });

  it('lists matches grouped by note with line numbers', async () => {
    const user = userEvent.setup();
    const a = makeNote({ title: 'Alpha', contentMd: '# Alpha\nazure is the cloud' });
    const b = makeNote({ title: 'Bravo', contentMd: 'no match here' });
    renderWithCtx(<SearchView />, { notes: [a, b] });
    await typeQuery(user, 'azure');

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
    await typeQuery(user, 'lake');
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
    await typeQuery(user, 'Azure');
    expect(screen.getByText(/3 matches/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /match case/i }));
    expect(await screen.findByText(/1 match in 1 note/)).toBeInTheDocument();
  });

  it('regex toggle: invalid pattern surfaces a readable error', async () => {
    const user = userEvent.setup();
    renderWithCtx(<SearchView />, { notes: [makeNote({ contentMd: 'abc' })] });
    await user.click(screen.getByRole('button', { name: /regular expression/i }));
    // `[` is a userEvent keyboard descriptor delimiter — escape with `{[}`.
    await typeQuery(user, '{[}');
    expect(await screen.findByText(/invalid regular expression/i)).toBeInTheDocument();
  });

  it('clicking a match opens the note', async () => {
    const user = userEvent.setup();
    const openNote = vi.fn();
    const a = makeNote({ title: 'Alpha', contentMd: '# Alpha\nfoo' });
    renderWithCtx(<SearchView />, { notes: [a], openNote });
    await typeQuery(user, 'foo');
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
    await typeQuery(user, 'foo');
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

  it('Replace All with regex OFF treats "$&" as a literal, not the match', async () => {
    const user = userEvent.setup();
    const a = makeNote({ title: 'A', contentMd: 'foo bar' });
    const all = [a];
    const api = makeApiStub(all);
    const updateSpy = vi.spyOn(api, 'updateNote');
    const refreshAll = vi.fn().mockResolvedValue(undefined);

    renderWithCtx(<SearchView />, { notes: all, api, refreshAll });
    await typeQuery(user, 'foo');
    await user.click(screen.getByRole('button', { name: /show replace/i }));
    // `$&` would normally be interpreted by String.replace as "the match" —
    // with regex OFF the user means the 2 literal characters. `[` etc. aren't
    // special here; type the literal $&.
    await user.type(screen.getByPlaceholderText('Replace'), '$&');
    await user.click(screen.getByRole('button', { name: /^Replace \(\d+\)$/ }));

    const confirm = await screen.findByTestId('confirm-dialog');
    const okBtn = within(confirm)
      .getAllByRole('button')
      .find((b) => b.textContent !== 'Cancel');
    await user.click(okBtn!);

    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    // "foo" → literal "$&", NOT → "foo" (the match re-injected).
    expect(updateSpy).toHaveBeenCalledWith(a.id, { contentMd: '$& bar' });
  });
});
