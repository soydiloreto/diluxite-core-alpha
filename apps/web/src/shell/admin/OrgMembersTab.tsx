import { useEffect, useMemo, useState } from 'react';
import type { OrgMember, OrgRole, OrganizationWithRole } from '../../api';
import { useApp } from '../AppContext';
import { Button, Field, Input, useDialogs } from '../../ui';
import { Search as SearchIcon, Trash2, UserPlus, Users } from '../../icons';

const ROLE_LABEL: Record<OrgRole, string> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  member: 'Member',
};
const ROLE_HINT: Record<OrgRole, string> = {
  super_admin: 'Full control of the organization (billing, rename, delete, promote anyone).',
  admin: 'Manage workspaces and members; cannot touch billing or delete the org.',
  member: 'Belongs to the org; per-workspace access still required.',
};

/**
 * Admin · Members — list, invite, change role, remove. Designed to scale to
 * hundreds of users via a client-side filter (we can paginate later).
 */
export function OrgMembersTab({ org }: { org: OrganizationWithRole }) {
  const { api } = useApp();
  const dialogs = useDialogs();
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<OrgRole>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = org.role === 'super_admin' || org.role === 'admin';
  const canMintSuperAdmin = org.role === 'super_admin';

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
      setNewRole('member');
      await reload();
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
              {canMintSuperAdmin && <option value="super_admin">Super admin</option>}
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
                        <option value="member">{ROLE_LABEL.member}</option>
                        <option value="admin">{ROLE_LABEL.admin}</option>
                        {canMintSuperAdmin && (
                          <option value="super_admin">{ROLE_LABEL.super_admin}</option>
                        )}
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
