import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecentView } from './RecentView';
import { renderWithCtx, makeNote, buildCtx } from '../../../test/render-with-ctx';
import { DialogProvider } from '../../ui';
import { AppProvider } from '../AppContext';
import type { Note } from '../../api';

// We avoid `vi.useFakeTimers()` here because it interferes with userEvent's
// internal scheduling (typing/clicking) and was making interactive tests
// time out. Instead, every test computes its dates relative to *real* `new
// Date()` so labels like "Today" / "Yesterday" stay deterministic.

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}
const iso = (d: Date) => d.toISOString();

describe('RecentView', () => {
  it('renders an empty hint when there are no notes', () => {
    renderWithCtx(<RecentView />, { notes: [] });
    expect(screen.getByText(/No activity yet/i)).toBeInTheDocument();
  });

  it('groups activities by day with localised labels (Today / Yesterday)', () => {
    renderWithCtx(<RecentView />, {
      notes: [
        makeNote({ title: 'TodayNote', createdAt: iso(daysAgo(0)), updatedAt: iso(daysAgo(0)) }),
        makeNote({ title: 'YesterdayNote', createdAt: iso(daysAgo(1)), updatedAt: iso(daysAgo(1)) }),
        makeNote({ title: 'OlderNote', createdAt: iso(daysAgo(7)), updatedAt: iso(daysAgo(7)) }),
      ],
    });
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByText('OlderNote')).toBeInTheDocument();
  });

  it('TZ-safe: a note created today stays included with from=to=today (West-of-UTC regression)', () => {
    renderWithCtx(<RecentView />, {
      notes: [makeNote({ title: 'TodayNote', createdAt: iso(daysAgo(0)), updatedAt: iso(daysAgo(0)) })],
    });
    expect(screen.getByText('TodayNote')).toBeInTheDocument();
  });

  it('classifies a same-timestamp note as "created" and a re-saved one as "edited"', () => {
    const created = daysAgo(0);
    const edited = new Date(created.getTime() + 10_000); // > 5s window
    renderWithCtx(<RecentView />, {
      notes: [
        makeNote({ title: 'Fresh', createdAt: iso(created), updatedAt: iso(created) }),
        makeNote({ title: 'Edited', createdAt: iso(created), updatedAt: iso(edited) }),
      ],
    });
    expect(screen.getByText('Fresh')).toBeInTheDocument();
    expect(screen.getByText('Edited')).toBeInTheDocument();
  });

  it('filter by title narrows the list', async () => {
    const user = userEvent.setup();
    renderWithCtx(<RecentView />, {
      notes: [
        makeNote({ title: 'Azure', createdAt: iso(daysAgo(0)), updatedAt: iso(daysAgo(0)) }),
        makeNote({ title: 'Kubernetes', createdAt: iso(daysAgo(0)), updatedAt: iso(daysAgo(0)) }),
      ],
    });
    await user.type(screen.getByPlaceholderText('Filter notes…'), 'azure');
    expect(screen.getByText('Azure')).toBeInTheDocument();
    expect(screen.queryByText('Kubernetes')).toBeNull();
  });

  it('clicking a row opens the note', async () => {
    const user = userEvent.setup();
    const openNote = vi.fn();
    const note = makeNote({
      title: 'Pick me',
      createdAt: iso(daysAgo(0)),
      updatedAt: iso(daysAgo(0)),
    });
    renderWithCtx(<RecentView />, { notes: [note], openNote });
    await user.click(screen.getByText('Pick me'));
    expect(openNote).toHaveBeenCalledWith(note.id);
  });

  it('Collapse all hides everything except today; Expand all brings it back', async () => {
    const user = userEvent.setup();
    renderWithCtx(<RecentView />, {
      notes: [
        makeNote({ title: 'TodayNote', createdAt: iso(daysAgo(0)), updatedAt: iso(daysAgo(0)) }),
        makeNote({ title: 'YesterdayNote', createdAt: iso(daysAgo(1)), updatedAt: iso(daysAgo(1)) }),
      ],
    });

    expect(screen.getByText('TodayNote')).toBeInTheDocument();
    expect(screen.getByText('YesterdayNote')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /collapse all/i }));
    // Today stays visible; yesterday is hidden.
    expect(screen.getByText('TodayNote')).toBeInTheDocument();
    expect(screen.queryByText('YesterdayNote')).toBeNull();

    await user.click(screen.getByRole('button', { name: /expand all/i }));
    expect(screen.getByText('YesterdayNote')).toBeInTheDocument();
  });

  it('From/To date pickers seed from the workspace range', () => {
    const old = daysAgo(7);
    renderWithCtx(<RecentView />, {
      notes: [makeNote({ createdAt: iso(old), updatedAt: iso(old) })],
    });
    const from = screen.getByLabelText(/from date/i) as HTMLInputElement;
    const to = screen.getByLabelText(/to date/i) as HTMLInputElement;
    // Both ends collapse to the same day (we only have one activity).
    const expected = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}`;
    expect(from.value).toBe(expected);
    expect(to.value).toBe(expected);
  });

  it('extends the to-bound when newer activity appears after first mount (no longer frozen)', () => {
    // Regression: the from/to range was seeded once at mount, so a note created
    // afterwards (newer than the seeded `to`) silently dropped off the
    // timeline. The view now extends the auto `to` to cover newer activity.
    const old = daysAgo(2);
    const fresh = daysAgo(0);
    function Tree({ notes }: { notes: Note[] }) {
      return (
        <DialogProvider>
          <AppProvider value={buildCtx({ notes })}>
            <RecentView />
          </AppProvider>
        </DialogProvider>
      );
    }
    const initial = [makeNote({ title: 'OldOne', createdAt: iso(old), updatedAt: iso(old) })];
    const { rerender } = render(<Tree notes={initial} />);
    // Newest at mount is `old`, so `to` seeds there.
    const to = screen.getByLabelText(/to date/i) as HTMLInputElement;
    const oldStr = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}`;
    expect(to.value).toBe(oldStr);

    // A newer note shows up (e.g. user created one). It must remain visible.
    const next = [
      ...initial,
      makeNote({ title: 'BrandNew', createdAt: iso(fresh), updatedAt: iso(fresh) }),
    ];
    rerender(<Tree notes={next} />);
    expect(screen.getByText('BrandNew')).toBeInTheDocument();
  });

  it('changing the to-date excludes activities after it', async () => {
    const today = daysAgo(0);
    const week = daysAgo(7);
    renderWithCtx(<RecentView />, {
      notes: [
        makeNote({ title: 'Old', createdAt: iso(week), updatedAt: iso(week) }),
        makeNote({ title: 'New', createdAt: iso(today), updatedAt: iso(today) }),
      ],
    });
    const cutoff = daysAgo(3);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
    const to = screen.getByLabelText(/to date/i) as HTMLInputElement;
    fireEvent.change(to, { target: { value: cutoffStr } });
    expect(screen.getByText('Old')).toBeInTheDocument();
    expect(screen.queryByText('New')).toBeNull();
  });
});
