import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchConfigTab } from './SearchConfigTab';
import type { Prefs } from '../../useSettings';

const PREFS: Prefs = {
  theme: 'dark',
  accent: '#008671',
  searchMode: 'hybrid',
  topK: 5,
  lang: 'en',
  sidebarWidth: 288,
  previewLayout: 'side',
  previewSplitPct: 50,
  neighborsLayout: 'hidden',
  neighborsWidth: 320,
  neighborsTab: 'backlinks',
  neighborsHeight: 260,
};

describe('SearchConfigTab', () => {
  it('renders the search panel with current prefs', () => {
    render(<SearchConfigTab prefs={PREFS} setPref={vi.fn()} />);
    expect(screen.getByTestId('admin-search-tab')).toBeInTheDocument();
    expect(screen.getByLabelText(/search mode/i)).toHaveValue('hybrid');
    expect(screen.getByLabelText(/topK/i)).toHaveValue(5);
  });

  it('Save is disabled until a value changes', () => {
    render(<SearchConfigTab prefs={PREFS} setPref={vi.fn()} />);
    expect(screen.getByTestId('search-save')).toBeDisabled();
  });

  it('changing the mode then saving calls setPref with the new mode', async () => {
    const user = userEvent.setup();
    const setPref = vi.fn();
    render(<SearchConfigTab prefs={PREFS} setPref={setPref} />);
    await user.selectOptions(screen.getByLabelText(/search mode/i), 'keyword');
    const save = screen.getByTestId('search-save');
    expect(save).not.toBeDisabled();
    await user.click(save);
    expect(setPref).toHaveBeenCalledWith('searchMode', 'keyword');
  });

  it('changing topK then saving calls setPref with the new topK', async () => {
    const user = userEvent.setup();
    const setPref = vi.fn();
    render(<SearchConfigTab prefs={PREFS} setPref={setPref} />);
    const input = screen.getByLabelText(/topK/i);
    fireEvent.change(input, { target: { value: '8' } });
    await user.click(screen.getByTestId('search-save'));
    expect(setPref).toHaveBeenCalledWith('topK', 8);
  });
});
