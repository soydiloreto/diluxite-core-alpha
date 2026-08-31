import { useEffect, useMemo, useState } from 'react';
import type { OrgMember, OrgRole, OrganizationWithRole } from '../../api';
import { useApp } from '../AppContext';
import { Button, Field, Input, useDialogs } from '../../ui';
import { Search as SearchIcon, Trash2, UserPlus, Users } from '../../icons';

const ROLE_LABEL: Record<OrgRole, string> = {
  org_admin: 'Admin',
  org_member: 'Member',
};
const ROLE_HINT: Record<OrgRole, string> = {
  org_admin: 'Full control of this organisation: members, workspaces, its embedding provider, and deleting it.',
  org_member: 'Belongs to the organisation; access to a workspace still needs its own membership.',
};

/**
 * Admin · Members — list, invite, change role, remove. Designed to scale to
 * hundreds of users via a client-side filter (we can paginate later).
 */
export function OrgMembersTab({ org }: { org: OrganizationWithRole }) {
  // Role changes can affect the current user (e.g. self-demotion), so we
  // invalidate the org list too — the TopBar OrgIndicator re-derives the
  // active role from it. See docs/PATTERNS.md.
  const { api, refreshOrgs, authMode } = useApp();
  const dialogs = useDialogs();
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<OrgRole>('org_member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Local single-user mode has exactly one user (you), so changing roles or
  // removing members is meaningless — only enable management in server mode.
  const serverMode = authMode === 'server';
  const canManage = serverMode && (org.role === 'org_admin');


  async function reload() {
    setLoading(true);
    try {
      setMembers(await api.listOrgMembers(org.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, [api, org.id]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? members.filter((m) => m.email.toLowerCase().includes(q)) : members;
  }, [members, filter]);

  async function invite() {
    if (!newEmail.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addOrgMember(org.id, newEmail.trim().toLowerCase(), newRole);
      setNewEmail('');
      setNewRole('org_member');
      await reload();
      await refreshOrgs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(m: OrgMember, role: OrgRole) {
    setBusy(true);
    setError(null);
    try {
      await api.updateOrgMember(org.id, m.userId, role);
      await reload();
      await refreshOrgs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: OrgMember) {
    const ok = await dialogs.confirm(`Remove ${m.email}?`, {
      message: 'They will lose access to every workspace inside this organization.',
      danger: true,
      okLabel: 'Remove',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeOrgMember(org.id, m.userId);
      await reload();
      await refreshOrgs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold flex items-center gap-2 text-ink">
          <Users size={16} className="text-brand" /> Members of {org.name}
        </h2>
        <p className="text-xs text-ink-muted mt-1">
          {members.length} total · invite by email · changes take effect immediately. Per-workspace
          access is granted separately under <em>Workspaces</em>.
        </p>
      </header>

      {!serverMode && (
        <div
          data-testid="members-local-note"
          role="note"
          className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-ink"
        >
          🔒 You're in <strong>local single-user mode</strong>, so there's only one member (you) —
          changing roles and removing members are disabled. They're available in{' '}
          <strong>server mode</strong> (multi-user), which you can switch to with the installer.
        </div>
      )}

      {canManage && (
        <section className="rounded-md border border-line bg-bg-surface p-3 flex items-end gap-2">
          <Field label="Invite by email" className="flex-1">
            <Input
              aria-label="invite email"
              type="email"
              placeholder="name@company.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void invite();
              }}
            />
          </Field>
          <Field label="Role">
            <select
              aria-label="invite role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as OrgRole)}
              className="text-sm h-9 px-2 rounded border border-line bg-bg text-ink"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <Button onClick={invite} disabled={busy || !newEmail.trim()}>
            <UserPlus size={14} /> Invite
          </Button>
        </section>
      )}

      <div className="relative">
        <SearchIcon
          size={12}
          aria-hidden
          className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none"
        />
        <input
          aria-label="filter members"
          placeholder="Filter by email…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-72 text-xs pl-7 pr-2 py-1.5 rounded border border-line bg-bg text-ink"
        />
      </div>

      {error && (
        <p className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2">
          {error}
        </p>
      )}

      <div className="rounded-md border border-line overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-surface text-[11px] uppercase tracking-wider text-ink-muted">
            <tr>
              <th className="text-left px-3 py-2">Email</th>
              <th className="text-left px-3 py-2 w-44">Role</th>
              <th className="text-left px-3 py-2 w-40">Joined</th>
              <th className="text-right px-3 py-2 w-24">{canManage ? 'Actions' : ''}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="text-center text-ink-muted py-6 text-xs">
                  Loading…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center text-ink-muted py-6 text-xs">
                  No members match.
                </td>
              </tr>
            ) : (
              visible.map((m) => (
                <tr key={m.userId} className="border-t border-line">
                  <td className="px-3 py-2 truncate">{m.email}</td>
                  <td className="px-3 py-2">
                    {canManage ? (
                      <select
                        aria-label={`role of ${m.email}`}
                        value={m.role}
                        onChange={(e) => void changeRole(m, e.target.value as OrgRole)}
                        disabled={busy}
                        title={ROLE_HINT[m.role]}
                        className="text-xs px-2 py-1 rounded border border-line bg-bg text-ink"
                      >
                        <option value="org_member">{ROLE_LABEL.org_member}</option>
                        <option value="org_admin">{ROLE_LABEL.org_admin}</option>
                      </select>
                    ) : (
                      <span title={ROLE_HINT[m.role]}>{ROLE_LABEL[m.role]}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-muted">
                    {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => void remove(m)}
                        aria-label={`remove ${m.email}`}
                        title="Remove from organization"
                        disabled={busy}
                        className="text-ink-muted hover:text-red-400 p-1 rounded"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
