import { useEffect, useMemo, useState } from 'react';
import type { OrganizationWithRole } from '../../api';
import { useApp } from '../AppContext';
import { Building2, Folder, Layers, Plug, Settings, Shield, Users } from '../../icons';
import { OrganizationTab } from './OrganizationTab';
import { OrgMembersTab } from './OrgMembersTab';
import { WorkspacesTab } from './WorkspacesTab';
import { ApiKeysTab } from './ApiKeysTab';

export type AdminSection = 'organization' | 'members' | 'workspaces' | 'api-keys' | 'audit';

/**
 * Admin Console — full-screen view that replaces the editor area when the
 * user opens `Admin` from the Activity Bar. VS Code-style internal layout:
 *
 *   ┌── Admin sidebar ──┬────── Section content ─────────────────────────┐
 *   │ Organization      │                                                │
 *   │ Members           │  (lives in /admin/<section> for deep links)    │
 *   │ Workspaces        │                                                │
 *   │ API Keys          │                                                │
 *   │ Audit             │                                                │
 *   └───────────────────┴───────────────────────────────────────────────┘
 *
 * Sections are gated by role. Super-admins see everything; org admins see
 * Members + Workspaces + API Keys; org members see just Workspaces.
 */
export function AdminConsole({
  section,
  onSection,
}: {
  section: AdminSection;
  onSection: (s: AdminSection) => void;
}) {
  const { api } = useApp();
  const [orgs, setOrgs] = useState<OrganizationWithRole[]>([]);
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listOrganizations()
      .then((rows) => {
        setOrgs(rows);
        if (rows.length > 0 && !currentOrgId) setCurrentOrgId(rows[0].id);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [api]);

  const currentOrg = useMemo(
    () => orgs.find((o) => o.id === currentOrgId) ?? null,
    [orgs, currentOrgId],
  );

  const sections: { id: AdminSection; label: string; icon: React.ReactNode; minRole: 'super_admin' | 'admin' | 'member' }[] = [
    { id: 'organization', label: 'Organization', icon: <Building2 size={14} />, minRole: 'admin' },
    { id: 'members', label: 'Members', icon: <Users size={14} />, minRole: 'admin' },
    { id: 'workspaces', label: 'Workspaces', icon: <Folder size={14} />, minRole: 'member' },
    { id: 'api-keys', label: 'API Keys', icon: <Plug size={14} />, minRole: 'admin' },
    { id: 'audit', label: 'Audit log', icon: <Layers size={14} />, minRole: 'admin' },
  ];

  function canSee(min: 'super_admin' | 'admin' | 'member'): boolean {
    if (!currentOrg) return false;
    const order = { super_admin: 3, admin: 2, member: 1 } as const;
    return order[currentOrg.role] >= order[min];
  }
  const visibleSections = sections.filter((s) => canSee(s.minRole));

  return (
    <div data-testid="admin-console" className="h-full w-full bg-bg text-ink flex">
      {/* Inner sidebar */}
      <aside className="w-60 shrink-0 h-full border-r border-line bg-bg-surface flex flex-col">
        <div className="px-3 py-2 border-b border-line flex items-center gap-2 shrink-0">
          <Shield size={14} className="text-brand" />
          <span className="text-[11px] uppercase tracking-wider text-ink-muted flex-1">Admin</span>
        </div>

        {/* Organization picker (shown once for multi-org users) */}
        {orgs.length > 0 && (
          <div className="p-2 border-b border-line shrink-0">
            <label className="text-[10px] uppercase text-ink-muted block px-1 mb-1">
              Organization
            </label>
            <select
              aria-label="organization selector"
              value={currentOrgId ?? ''}
              onChange={(e) => setCurrentOrgId(e.target.value)}
              className="w-full text-xs px-2 py-1 rounded border border-line bg-bg text-ink"
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {o.role}
                </option>
              ))}
            </select>
          </div>
        )}

        <nav className="flex-1 min-h-0 overflow-y-auto p-1">
          {visibleSections.map((s) => (
            <button
              key={s.id}
              onClick={() => onSection(s.id)}
              aria-current={section === s.id ? 'page' : undefined}
              className={`w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-sm ${
                section === s.id ? 'bg-brand text-white' : 'text-ink hover:bg-bg'
              }`}
            >
              {s.icon}
              <span className="flex-1 truncate">{s.label}</span>
            </button>
          ))}
        </nav>

        <div className="p-2 text-[10px] text-ink-muted border-t border-line shrink-0">
          {currentOrg ? (
            <>
              You are <strong className="text-ink">{currentOrg.role.replace('_', ' ')}</strong> of{' '}
              <strong className="text-ink">{currentOrg.name}</strong>.
            </>
          ) : loadError ? (
            <>Failed to load orgs: {loadError}</>
          ) : (
            <>Loading…</>
          )}
        </div>
      </aside>

      {/* Section content */}
      <section className="flex-1 min-w-0 h-full overflow-y-auto p-6">
        {!currentOrg ? (
          <div className="text-sm text-ink-muted">
            {loadError ? `Couldn't load organisations: ${loadError}` : 'Loading organisations…'}
          </div>
        ) : section === 'organization' ? (
          <OrganizationTab org={currentOrg} onChanged={(name) => {
            setOrgs((prev) => prev.map((o) => (o.id === currentOrg.id ? { ...o, name } : o)));
          }} />
        ) : section === 'members' ? (
          <OrgMembersTab org={currentOrg} />
        ) : section === 'workspaces' ? (
          <WorkspacesTab org={currentOrg} />
        ) : section === 'api-keys' ? (
          <ApiKeysTab />
        ) : section === 'audit' ? (
          <AuditPlaceholder />
        ) : null}
      </section>
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
