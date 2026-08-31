import type { OrganizationWithRole } from '../../api';
import type { AdminSection } from './AdminConsole';
import { Building2, Folder, Layers, Plug, Shield, Users } from '../../icons';

const TABS: {
  id: AdminSection;
  label: string;
  short: string;
  icon: React.ReactNode;
  minRole: 'org_admin' | 'org_member';
}[] = [
  { id: 'organization', label: 'Organization', short: 'Org', icon: <Building2 size={16} />, minRole: 'org_admin' },
  { id: 'members', label: 'Members', short: 'Members', icon: <Users size={16} />, minRole: 'org_admin' },
  { id: 'workspaces', label: 'Workspaces', short: 'Spaces', icon: <Folder size={16} />, minRole: 'org_member' },
  { id: 'api-keys', label: 'API Keys', short: 'Keys', icon: <Plug size={16} />, minRole: 'org_admin' },
  { id: 'audit', label: 'Audit log', short: 'Audit', icon: <Layers size={16} />, minRole: 'org_admin' },
];
const ROLE_ORDER = { org_admin: 2, org_member: 1 } as const;

/**
 * Mobile-only admin navigation: horizontal icon+label strip at the top of
 * the admin main area. Replaces the drawer pattern on small screens where
 * the backdrop-dismiss model would leave the user with no way to switch
 * sections (the bug Pablo flagged as "desaparece la barra").
 *
 * Each tab is large enough to tap (h-12, ~48px), shows icon + short label,
 * and highlights the active section with a brand-coloured underline.
 * Sections the user can't see (per their org role) are hidden entirely.
 */
export function AdminTabBar({
  org,
  section,
  onSection,
}: {
  org: OrganizationWithRole | null;
  section: AdminSection;
  onSection: (s: AdminSection) => void;
}) {
  function canSee(min: 'org_admin' | 'org_member'): boolean {
    if (!org) return false;
    return ROLE_ORDER[org.role] >= ROLE_ORDER[min];
  }
  const visible = TABS.filter((t) => canSee(t.minRole));

  return (
    <div
      data-testid="admin-tabbar"
      className="shrink-0 border-b border-line bg-bg-surface"
    >
      {/* Context line — keeps the user oriented on which org they're editing. */}
      {org && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-ink-muted border-b border-line">
          <Shield size={12} className="text-brand shrink-0" />
          <span className="font-medium text-ink truncate">{org.name}</span>
          <span aria-hidden>·</span>
          <span className="uppercase tracking-wider text-[10px]">
            {org.role.replace('_', ' ')}
          </span>
        </div>
      )}
      {/* Horizontal scroll if the user's role unlocks all five sections —
          on phones below 360px the row still fits without thumb-stretch. */}
      <nav
        role="tablist"
        aria-label="Admin sections"
        className="flex overflow-x-auto no-scrollbar"
      >
        {visible.length === 0 && (
          <div className="px-3 py-3 text-[11px] text-ink-muted">
            You don't belong to any organization yet.
          </div>
        )}
        {visible.map((t) => {
          const active = section === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => onSection(t.id)}
              className={`
                shrink-0 flex flex-col items-center gap-0.5 px-3 py-2 min-w-[64px]
                text-[10px] uppercase tracking-wider transition-colors
                ${active
                  ? 'text-brand border-b-2 border-brand'
                  : 'text-ink-muted hover:text-ink border-b-2 border-transparent'}
              `}
            >
              {t.icon}
              <span>{t.short}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
