import type { OrganizationWithRole } from '../../api';
import type { AdminSection } from './AdminConsole';
import { Building2, Folder, Layers, Plug, Settings, Shield, Users } from '../../icons';

const SECTIONS: {
  id: AdminSection;
  label: string;
  icon: React.ReactNode;
  minRole: 'super_admin' | 'admin' | 'member';
}[] = [
  { id: 'organization', label: 'Organization', icon: <Building2 size={14} />, minRole: 'admin' },
  { id: 'members', label: 'Members', icon: <Users size={14} />, minRole: 'admin' },
  { id: 'workspaces', label: 'Workspaces', icon: <Folder size={14} />, minRole: 'member' },
  { id: 'api-keys', label: 'API Keys', icon: <Plug size={14} />, minRole: 'admin' },
  { id: 'ai', label: 'AI / Embeddings', icon: <Settings size={14} />, minRole: 'admin' },
  { id: 'audit', label: 'Audit log', icon: <Layers size={14} />, minRole: 'admin' },
];
const ROLE_ORDER = { super_admin: 3, admin: 2, member: 1 } as const;

/**
 * Sidebar rendered in the **same slot as the Explorer** when the user is in
 * the admin route. Avoids the "two-sidebar" smell — VS Code's Source Control
 * / Search activities work the same way (one sidebar that swaps contents).
 *
 * Sections that the current user can't see (per their org role) are hidden
 * from the list entirely.
 */
export function AdminSidebar({
  org,
  section,
  onSection,
}: {
  org: OrganizationWithRole | null;
  section: AdminSection;
  onSection: (s: AdminSection) => void;
}) {
  function canSee(min: 'super_admin' | 'admin' | 'member'): boolean {
    if (!org) return false;
    return ROLE_ORDER[org.role] >= ROLE_ORDER[min];
  }
  const visible = SECTIONS.filter((s) => canSee(s.minRole));

  return (
    <div
      data-testid="admin-sidebar"
      className="h-full w-full flex flex-col bg-bg-surface text-ink min-w-0"
    >
      <div className="px-3 py-2 border-b border-line shrink-0 flex items-center gap-2">
        <Shield size={14} className="text-brand shrink-0" />
        <span className="text-[11px] uppercase tracking-wider text-ink-muted flex-1">Admin</span>
      </div>

      {/* Org label — the active org is chosen from the TopBar OrgIndicator. */}
      {org && (
        <div className="px-3 py-2 border-b border-line shrink-0 flex items-center gap-2 text-xs text-ink">
          <Building2 size={12} className="text-brand shrink-0" />
          <span className="font-medium truncate flex-1">{org.name}</span>
          <span className="text-[10px] uppercase tracking-wider text-ink-muted">
            {org.role.replace('_', ' ')}
          </span>
        </div>
      )}

      <nav className="flex-1 min-h-0 overflow-y-auto p-1">
        {visible.length === 0 && (
          <div className="text-[11px] text-ink-muted px-3 py-3 leading-relaxed">
            You don't belong to any organization yet.
          </div>
        )}
        {visible.map((s) => (
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

      <div className="p-2 text-[10px] text-ink-muted border-t border-line shrink-0 leading-relaxed">
        Switch organisation from the top-right indicator. Use the Explorer icon
        on the activity bar to go back to notes.
      </div>
    </div>
  );
}
