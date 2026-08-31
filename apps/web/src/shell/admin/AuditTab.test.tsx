import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditTab } from './AuditTab';
import type { ApiClient, AuditEvent, OrganizationWithRole } from '../../api';

/**
 * Tests del AuditTab — coverage:
 *  - Loading state al inicio.
 *  - Render de la tabla cuando hay eventos.
 *  - Render de empty state cuando viene la lista vacía.
 *  - Filter por action prefix dispara nuevo fetch.
 *  - "Load more" pagina con beforeId del último evento visible.
 *  - Error de la API se muestra en role=alert.
 *  - El cuerpo de la tabla muestra el id (data-testid="audit-row-N").
 *  - Si total === events.length, "Load more" NO se renderiza.
 *  - metadata aparece serializado JSON en la celda Detail.
 */

const ORG: OrganizationWithRole = {
  id: 'org-1',
  name: 'Test',
  slug: 'test',
  role: 'org_admin',
};

function makeEvent(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 1,
    at: new Date('2026-06-02T10:00:00Z').toISOString(),
    orgId: 'org-1',
    actorId: 'u-1',
    action: 'auth.login.success',
    resource: null,
    ip: '127.0.0.1',
    userAgent: 'Mozilla/5.0',
    metadata: {},
    ...over,
  };
}

function fakeApi(initial: AuditEvent[], total = initial.length): ApiClient {
  const calls: Array<{ orgId: string; query: unknown }> = [];
  return {
    listAuditEvents: vi.fn(async (orgId, query) => {
      calls.push({ orgId, query });
      // If query.action present, filter; if beforeId, paginate.
      let filtered = initial;
      if (query?.action) filtered = filtered.filter((e) => e.action.startsWith(query.action));
      if (query?.beforeId !== undefined) filtered = filtered.filter((e) => e.id < query.beforeId);
      return { events: filtered, total };
    }),
  } as unknown as ApiClient;
}

describe('AuditTab — happy paths', () => {
  it('shows loading then renders the table with the events newest-first', async () => {
    const events = [
      makeEvent({ id: 3, action: 'admin.users.csv_imported' }),
      makeEvent({ id: 2, action: 'auth.logout' }),
      makeEvent({ id: 1, action: 'auth.login.success' }),
    ];
    render(<AuditTab api={fakeApi(events)} org={ORG} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    const table = await screen.findByTestId('audit-table');
    expect(within(table).getByTestId('audit-row-3')).toBeInTheDocument();
    expect(within(table).getByTestId('audit-row-2')).toBeInTheDocument();
    expect(within(table).getByTestId('audit-row-1')).toBeInTheDocument();
    expect(screen.getByText(/Showing 3 of 3/)).toBeInTheDocument();
  });

  it('renders an empty state when no events come back', async () => {
    render(<AuditTab api={fakeApi([])} org={ORG} />);
    await screen.findByTestId('audit-empty');
    expect(screen.queryByTestId('audit-table')).not.toBeInTheDocument();
  });

  it('typing into the filter triggers a new fetch with action=…', async () => {
    const user = userEvent.setup();
    const events = [
      makeEvent({ id: 2, action: 'auth.logout' }),
      makeEvent({ id: 1, action: 'admin.users.csv_imported' }),
    ];
    const api = fakeApi(events);
    render(<AuditTab api={api} org={ORG} />);
    await screen.findByTestId('audit-table');
    const filter = screen.getByTestId('audit-action-filter') as HTMLInputElement;
    await user.type(filter, 'auth');
    await waitFor(() => {
      const calls = (api.listAuditEvents as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls[calls.length - 1][1]).toEqual({ action: 'auth' });
    });
  });

  it('Load more button paginates via beforeId on the last seen event', async () => {
    const user = userEvent.setup();
    const allEvents = Array.from({ length: 8 }, (_, i) =>
      makeEvent({ id: 8 - i, action: `e.${8 - i}` }),
    );
    // First fetch returns only the 3 newest; total claims there are 8.
    const partial = allEvents.slice(0, 3);
    const api: ApiClient = {
      listAuditEvents: vi.fn(async (_orgId, q) => {
        if (q?.beforeId !== undefined) {
          // Older events.
          return { events: allEvents.filter((e) => e.id < q.beforeId).slice(0, 3), total: 8 };
        }
        return { events: partial, total: 8 };
      }),
    } as unknown as ApiClient;
    render(<AuditTab api={api} org={ORG} />);
    await screen.findByTestId('audit-table');
    const loadMore = screen.getByTestId('audit-load-more');
    await user.click(loadMore);
    // Now should have 6 rows (3 original + 3 more).
    await waitFor(() => {
      expect(screen.getByTestId('audit-row-3')).toBeInTheDocument();
    });
    expect(screen.getByTestId('audit-row-8')).toBeInTheDocument();
    expect(screen.getByTestId('audit-row-3')).toBeInTheDocument();
  });

  it('Load more is NOT rendered when total === current count', async () => {
    render(<AuditTab api={fakeApi([makeEvent()], 1)} org={ORG} />);
    await screen.findByTestId('audit-table');
    expect(screen.queryByTestId('audit-load-more')).not.toBeInTheDocument();
  });

  it('metadata is serialised JSON in the Detail cell', async () => {
    const events = [
      makeEvent({
        id: 1,
        action: 'admin.auth_policy.changed',
        metadata: { from: 'allow_unknown_as_member', to: 'deny_unknown' },
      }),
    ];
    render(<AuditTab api={fakeApi(events)} org={ORG} />);
    const row = await screen.findByTestId('audit-row-1');
    expect(row.textContent).toMatch(/"from":"allow_unknown_as_member"/);
    expect(row.textContent).toMatch(/"to":"deny_unknown"/);
  });

  it('actorId null renders as em-dash placeholder, not blank', async () => {
    const events = [
      makeEvent({
        id: 1,
        actorId: null,
        action: 'auth.login.failed',
        metadata: { attemptedEmail: 'x@y.z' },
      }),
    ];
    render(<AuditTab api={fakeApi(events)} org={ORG} />);
    const row = await screen.findByTestId('audit-row-1');
    expect(row.textContent).toContain('—');
  });
});

describe('AuditTab — error paths', () => {
  it('shows error from API in role=alert', async () => {
    const api: ApiClient = {
      listAuditEvents: vi.fn().mockRejectedValue(new Error('forbidden')),
    } as unknown as ApiClient;
    render(<AuditTab api={api} org={ORG} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/forbidden/);
  });
});
