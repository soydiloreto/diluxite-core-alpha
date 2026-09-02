import type { OrganizationWithRole } from '../../api';
import type { Prefs } from '../../useSettings';
import { useApp } from '../AppContext';
import { OrganizationTab } from './OrganizationTab';
import { OrgMembersTab } from './OrgMembersTab';
import { WorkspacesTab } from './WorkspacesTab';
import { ApiKeysTab } from './ApiKeysTab';
import { OrgTokensTab } from './OrgTokensTab';
import { AuditTab } from './AuditTab';
import { SearchConfigTab } from './SearchConfigTab';
import { AiConfigTab } from './AiConfigTab';
import { CurrentWorkspaceTab } from './CurrentWorkspaceTab';
import { ConnectorsTab } from './ConnectorsTab';

export type AdminSection =
  | 'organization'
  | 'members'
  | 'workspaces'
  | 'current-workspace'
  | 'api-keys'
  | 'org-tokens'
  | 'ai'
  | 'connectors'
  | 'search'
  | 'audit';

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
  prefs,
  setPref,
}: {
  org: OrganizationWithRole | null;
  section: AdminSection;
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
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
      ) : section === 'current-workspace' ? (
        <CurrentWorkspaceTab />
      ) : section === 'api-keys' ? (
        <ApiKeysTab />
      ) : section === 'org-tokens' ? (
        <OrgTokensTab org={org} />
      ) : section === 'ai' ? (
        <AiConfigTab org={org} />
      ) : section === 'connectors' ? (
        <ConnectorsTab org={org} />
      ) : section === 'search' ? (
        <SearchConfigTab org={org} />
      ) : section === 'audit' ? (
        <AuditTabWrapper org={org} />
      ) : null}
    </div>
  );
}

function AuditTabWrapper({ org }: { org: OrganizationWithRole }) {
  const { api } = useApp();
  return <AuditTab api={api} org={org} />;
}


