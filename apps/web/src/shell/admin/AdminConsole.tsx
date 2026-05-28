import type { OrganizationWithRole } from '../../api';
import { Settings } from '../../icons';
import { OrganizationTab } from './OrganizationTab';
import { OrgMembersTab } from './OrgMembersTab';
import { WorkspacesTab } from './WorkspacesTab';
import { ApiKeysTab } from './ApiKeysTab';

export type AdminSection = 'organization' | 'members' | 'workspaces' | 'api-keys' | 'audit';

/**
 * Admin Console **content area** — just the section body. The corresponding
 * navigation lives in `<AdminSidebar />`, which renders in the same slot as
 * the Explorer (no two-sidebar layout). The active section is driven by the
 * URL (`/admin/<section>`) and falls back to "organization".
 *
 * The active organization is controlled from the TopBar OrgIndicator. The
 * console receives it via props — no internal picker, single source of truth.
 */
export function AdminConsole({
  org,
  section,
}: {
  org: OrganizationWithRole | null;
  section: AdminSection;
}) {
  return (
    <div data-testid="admin-console" className="h-full w-full bg-bg text-ink overflow-y-auto p-4 sm:p-6">
      {!org ? (
        <div className="text-sm text-ink-muted">
          Select an organisation from the top-right indicator.
        </div>
      ) : section === 'organization' ? (
        <OrganizationTab org={org} />
      ) : section === 'members' ? (
        <OrgMembersTab org={org} />
      ) : section === 'workspaces' ? (
        <WorkspacesTab org={org} />
      ) : section === 'api-keys' ? (
        <ApiKeysTab />
      ) : section === 'audit' ? (
        <AuditPlaceholder />
      ) : null}
    </div>
  );
}

function AuditPlaceholder() {
  return (
    <div className="max-w-xl">
      <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
        <Settings size={16} /> Audit log
      </h2>
      <p className="text-sm text-ink-muted leading-relaxed">
        Coming next — an immutable trail of who created / renamed / deleted what and when,
        scoped to the active organisation. Surface here, queryable via API + MCP.
      </p>
    </div>
  );
}
