import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DialogProvider, useDialogs } from './dialogs';

/**
 * The confirm dialog must move focus off the button that opened it. Without an
 * autoFocus on Cancel, the trigger button keeps DOM focus and an Enter press
 * re-dispatches it (re-opening the dialog and dangling the prior Promise).
 */
function Harness() {
  const dialogs = useDialogs();
  return (
    <button onClick={() => void dialogs.confirm('Sure?', { message: 'Body' })}>
      open confirm
    </button>
  );
}

describe('confirm dialog focus', () => {
  it('auto-focuses the Cancel button so focus leaves the trigger', async () => {
    const user = userEvent.setup();
    render(
      <DialogProvider>
        <Harness />
      </DialogProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'open confirm' });
    await user.click(trigger);
    const dlg = await screen.findByTestId('confirm-dialog');
    const cancel = within(dlg).getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());
    // The trigger no longer holds focus, so an Enter wouldn't re-fire it.
    expect(trigger).not.toHaveFocus();
  });
});
