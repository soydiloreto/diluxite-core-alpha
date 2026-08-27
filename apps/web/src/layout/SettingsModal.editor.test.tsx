import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from './SettingsModal';
import { renderWithCtx } from '../../test/render-with-ctx';
import { DEFAULTS } from '../useSettings';
import type { ApiClient } from '../api';

function stubApi(): ApiClient {
  return {} as unknown as ApiClient;
}

function renderEditor(setPref = vi.fn()) {
  renderWithCtx(
    <SettingsModal
      open
      onClose={vi.fn()}
      api={stubApi()}
      spaceId="s"
      prefs={DEFAULTS}
      setPref={setPref}
      tab="editor"
      onTabChange={vi.fn()}
    />,
  );
  return setPref;
}

describe('SettingsModal — Editor tab', () => {
  it('has no preview-layout picker any more — the note body is one mode at a time', () => {
    renderEditor();
    expect(screen.queryByTestId('preview-layout-side')).toBeNull();
    expect(screen.queryByTestId('preview-layout-bottom')).toBeNull();
  });

  it('neighbors picker writes neighborsLayout (the new default-placement control)', async () => {
    const user = userEvent.setup();
    const setPref = renderEditor();
    await user.click(screen.getByTestId('neighbors-layout-side'));
    expect(setPref).toHaveBeenCalledWith('neighborsLayout', 'side');
    await user.click(screen.getByTestId('neighbors-layout-hidden'));
    expect(setPref).toHaveBeenCalledWith('neighborsLayout', 'hidden');
  });
});
