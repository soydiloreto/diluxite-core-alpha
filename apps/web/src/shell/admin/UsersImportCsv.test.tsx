import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsersImportCsv } from './UsersImportCsv';
import { createFakeApi } from '../../fakeApi';
import { DialogProvider } from '../../ui';

/**
 * UI tests del wizard de CSV import.
 *
 * Cubrimos:
 *  - Render inicial: dropzone vacío, textarea vacío, sin preview ni apply.
 *  - Paste CSV → click Preview → tabla con rows.
 *  - CSV con errors → bloque de errors visible.
 *  - Apply solo se habilita después de un Preview exitoso.
 *  - Apply muestra resumen + invoca onImported.
 *  - CSV solo header → Preview muestra 0 rows, Apply queda deshabilitado.
 *  - Pasted text se preserva entre Preview y Apply (no se borra).
 *  - Errors largos no rompen el layout (capped a la lista visible).
 */

function renderImport(onImported?: () => void) {
  const api = createFakeApi();
  render(
    <DialogProvider>
      <UsersImportCsv api={api} orgId="org-1" onImported={onImported} />
    </DialogProvider>,
  );
  return api;
}

/**
 * Drive the controlled textarea atomically. `user.type()` with long strings
 * under CPU load drops keystrokes (root cause of the historical flake on
 * "paste CSV → Preview"). The component is a real "paste" target — fireEvent
 * matches the user gesture and is timing-free.
 */
function pasteCsv(value: string) {
  const ta = screen.getByLabelText(/csv text/i) as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value } });
  return ta;
}

describe('UsersImportCsv — initial render', () => {
  it('shows the heading + dropzone + textarea, no preview yet', () => {
    renderImport();
    expect(screen.getByTestId('users-import-csv')).toBeInTheDocument();
    expect(screen.getByTestId('csv-dropzone')).toBeInTheDocument();
    expect(screen.getByLabelText(/csv text/i)).toBeInTheDocument();
    expect(screen.queryByTestId('preview-section')).not.toBeInTheDocument();
  });

  it('Preview button is disabled while textarea is empty', () => {
    renderImport();
    const btn = screen.getByRole('button', { name: /preview/i });
    expect(btn).toBeDisabled();
  });
});

describe('UsersImportCsv — happy path', () => {
  it('paste CSV → Preview → shows the rows in a table', async () => {
    const user = userEvent.setup();
    renderImport();
    pasteCsv('email,first_name\nana@x.com,Ana\nbob@x.com,Bob');
    await user.click(screen.getByRole('button', { name: /preview/i }));
    const section = await screen.findByTestId('preview-section');
    expect(within(section).getByText('ana@x.com')).toBeInTheDocument();
    expect(within(section).getByText('bob@x.com')).toBeInTheDocument();
    // Apply button now visible.
    expect(screen.getByTestId('apply-import')).toBeInTheDocument();
  });

  it('Apply → calls api.importUsersCsv(dryRun:false), shows result, invokes onImported', async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    renderImport(onImported);
    pasteCsv('email\nana@x.com');
    await user.click(screen.getByRole('button', { name: /preview/i }));
    await user.click(await screen.findByTestId('apply-import'));
    const result = await screen.findByTestId('apply-result');
    expect(result.textContent).toMatch(/Created:\s*1/);
    expect(onImported).toHaveBeenCalledTimes(1);
  });
});

describe('UsersImportCsv — error reporting', () => {
  it('CSV with malformed emails shows the errors section', async () => {
    const user = userEvent.setup();
    renderImport();
    pasteCsv('email,first_name\nana@x.com,Ana\nbad-email,B');
    await user.click(screen.getByRole('button', { name: /preview/i }));
    const errors = await screen.findByTestId('preview-errors');
    expect(errors.textContent).toMatch(/L3/); // line 3
    expect(errors.textContent).toMatch(/invalid email/i);
    // Good row is still in the preview table.
    expect(screen.getByText('ana@x.com')).toBeInTheDocument();
  });

  it('CSV with missing email header → preview shows the fatal error, no Apply', async () => {
    const user = userEvent.setup();
    renderImport();
    pasteCsv('firstname\nAna');
    await user.click(screen.getByRole('button', { name: /preview/i }));
    const errors = await screen.findByTestId('preview-errors');
    expect(errors.textContent).toMatch(/no "email" column/i);
    // Apply must be hidden because rows=0.
    expect(screen.queryByTestId('apply-import')).not.toBeInTheDocument();
  });
});

describe('UsersImportCsv — guards', () => {
  it('Apply is hidden when preview yields 0 rows (header-only CSV)', async () => {
    const user = userEvent.setup();
    renderImport();
    pasteCsv('email');
    await user.click(screen.getByRole('button', { name: /preview/i }));
    await screen.findByTestId('preview-section');
    expect(screen.queryByTestId('apply-import')).not.toBeInTheDocument();
  });

  it('CSV stays in the textarea between Preview and Apply', async () => {
    const user = userEvent.setup();
    renderImport();
    const ta = pasteCsv('email\nana@x.com');
    await user.click(screen.getByRole('button', { name: /preview/i }));
    await screen.findByTestId('preview-section');
    expect(ta.value).toContain('ana@x.com');
  });

  it('editing the textarea after a Preview hides Apply (forces a re-Preview)', async () => {
    const user = userEvent.setup();
    renderImport();
    pasteCsv('email\nana@x.com');
    await user.click(screen.getByRole('button', { name: /preview/i }));
    // Apply is available right after a successful dry-run…
    expect(await screen.findByTestId('apply-import')).toBeInTheDocument();
    // …but editing the CSV invalidates the dry-run: the preview + Apply vanish
    // so the admin can't ship content the server never dry-ran.
    pasteCsv('email\nana@x.com\nbob@x.com');
    expect(screen.queryByTestId('apply-import')).not.toBeInTheDocument();
    expect(screen.queryByTestId('preview-section')).not.toBeInTheDocument();
  });
});

describe('UsersImportCsv — adversarial / robustness', () => {
  it('separator is shown in the preview header (auto-detected ;)', async () => {
    const user = userEvent.setup();
    renderImport();
    pasteCsv('email;first_name\nana@x.com;Ana');
    await user.click(screen.getByRole('button', { name: /preview/i }));
    const section = await screen.findByTestId('preview-section');
    expect(section.textContent).toMatch(/separator/i);
    expect(within(section).getByText(';')).toBeInTheDocument();
  });

  it('caps the preview table at 100 rows + "X more" hint', async () => {
    const user = userEvent.setup();
    renderImport();
    const lines = ['email'];
    for (let i = 0; i < 150; i++) lines.push(`u${i}@x.com`);
    pasteCsv(lines.join('\n'));
    await user.click(screen.getByRole('button', { name: /preview/i }));
    const section = await screen.findByTestId('preview-section');
    expect(section.textContent).toMatch(/150 rows/);
    expect(section.textContent).toMatch(/Showing first 100.*more will be imported/);
  });
});
