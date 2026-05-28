import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OrganizationWithRole, Space, WorkspaceMember, WorkspaceRole } from '../../api';
import { useApp } from '../AppContext';
import { Button, Field, Input, useDialogs } from '../../ui';
import { ChevronDown, ChevronRight, Folder, Plus, Trash2, UserPlus, Users } from '../../icons';

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

/**
 * Admin · Workspaces — list workspaces inside the org, create new ones,
 * rename / delete, and manage per-workspace member ACL (admin / editor /
 * viewer). Each workspace row expands into its member panel.
 */
export function WorkspacesTab({ org }: { org: OrganizationWithRole }) {
  // refreshAll covers notes/tags inside the active workspace; refreshSpaces
  // refetches the global list so the WorkspaceSelector + OrgIndicator + this
  // tab all stay in sync after create/rename/delete (the invalidation pattern,
  // see docs/PATTERNS.md).
  const { api, refreshAll, refreshSpaces } = useApp();
  const dialogs = useDialogs();
  const [workspaces, setWorkspaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const canManage = org.role === 'super_admin' || org.role === 'admin';

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setWorkspaces(await api.listOrgWorkspaces(org.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, org.id]);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function createOne() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await api.createWorkspace(org.id, newName.trim());
      setNewName('');
      await reload();
      await Promise.all([refreshSpaces(), refreshAll()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function destroy(ws: Space) {
    const ok = await dialogs.confirm(`Delete workspace "${ws.name}"?`, {
      message: 'Removes every note, folder and member of this workspace. Cannot be undone.',
      danger: true,
      okLabel: 'Delete workspace',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteWorkspace(ws.id);
      await reload();
      await Promise.all([refreshSpaces(), refreshAll()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rename(ws: Space) {
    const name = await dialogs.prompt('Rename workspace', { defaultValue: ws.name, okLabel: 'Save' });
    if (!name || name.trim() === ws.name) return;
    setBusy(true);
    try {
      await api.renameWorkspace(ws.id, name.trim());
      await reload();
      await Promise.all([refreshSpaces(), refreshAll()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setExpanded((s) => {
      const ns = new Set(s);
      ns.has(id) ? ns.delete(id) : ns.add(id);
      return ns;
    });
  }

  return (
    <div className="max-w-4xl flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold flex items-center gap-2 text-ink">
          <Folder size={16} className="text-brand" /> Workspaces in {org.name}
        </h2>
        <p className="text-xs text-ink-muted mt-1">
          {workspaces.length} total · each workspace has its own notes, folders, tags and member list.
        </p>
      </header>

      {canManage && (
        <section className="rounded-md border border-line bg-bg-surface p-3 flex items-end gap-2">
          <Field label="New workspace" className="flex-1">
            <Input
              aria-label="new workspace name"
              placeholder="e.g. Platform team"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createOne();
              }}
            />
          </Field>
          <Button onClick={createOne} disabled={busy || !newName.trim()}>
            <Plus size={14} /> Create
          </Button>
        </section>
      )}

      {error && (
        <p className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2">
          {error}
        </p>
      )}

      <div className="rounded-md border border-line overflow-hidden">
        {loading ? (
          <div className="text-xs text-ink-muted text-center py-6">Loading…</div>
        ) : workspaces.length === 0 ? (
          <div className="text-xs text-ink-muted text-center py-6">No workspaces yet.</div>
        ) : (
          workspaces.map((ws) => (
            <WorkspaceRow
              key={ws.id}
              ws={ws}
              orgRole={org.role}
              expanded={expanded.has(ws.id)}
              onToggle={() => toggle(ws.id)}
              onRename={() => void rename(ws)}
              onDelete={() => void destroy(ws)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function WorkspaceRow({
  ws,
  orgRole,
  expanded,
  onToggle,
  onRename,
  onDelete,
}: {
  ws: Space;
  orgRole: OrganizationWithRole['role'];
  expanded: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const Chev = expanded ? ChevronDown : ChevronRight;
  const canManage = orgRole === 'super_admin' || orgRole === 'admin';
  return (
    <div className="border-t border-line first:border-t-0">
      <div className="flex items-center gap-2 px-3 py-2 hover:bg-bg-surface">
        <button
          onClick={onToggle}
          aria-label={expanded ? 'collapse workspace' : 'expand workspace'}
          className="p-1 text-ink-muted hover:text-ink"
        >
          <Chev size={14} />
        </button>
        <Folder size={14} className="text-ink-muted shrink-0" />
        <span className="flex-1 truncate text-sm text-ink">{ws.name}</span>
        {canManage && (
          <>
            <button
              onClick={onRename}
              className="text-[11px] px-2 py-1 rounded hover:bg-bg text-ink-muted hover:text-ink"
            >
              Rename
            </button>
            <button
              onClick={onDelete}
              className="text-[11px] px-2 py-1 rounded hover:bg-red-500/10 text-red-400"
            >
              Delete
            </button>
          </>
        )}
      </div>
      {expanded && (
        <div className="px-3 pb-3">
          <WorkspaceMembersPanel ws={ws} canManage={canManage} />
        </div>
      )}
    </div>
  );
}

function WorkspaceMembersPanel({
  ws,
  canManage,
}: {
  ws: Space;
  canManage: boolean;
}) {
  const { api } = useApp();
  const dialogs = useDialogs();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<WorkspaceRole>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setMembers(await api.listWorkspaceMembers(ws.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, ws.id]);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function invite() {
    if (!newEmail.trim()) return;
    setBusy(true);
    try {
      await api.addWorkspaceMember(ws.id, newEmail.trim().toLowerCase(), newRole);
      setNewEmail('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function changeRole(m: WorkspaceMember, role: WorkspaceRole) {
    setBusy(true);
    try {
      await api.updateWorkspaceMember(ws.id, m.userId, role);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(m: WorkspaceMember) {
    const ok = await dialogs.confirm(`Remove ${m.email} from "${ws.name}"?`, {
      danger: true,
      okLabel: 'Remove',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.removeWorkspaceMember(ws.id, m.userId);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const noMembers = useMemo(() => !loading && members.length === 0, [loading, members.length]);

  return (
    <div className="ml-7 mt-1 flex flex-col gap-2 rounded border border-line bg-bg/40 p-3">
      <div className="flex items-center gap-2 text-[11px] text-ink-muted uppercase tracking-wider">
        <Users size={12} /> Members
      </div>
      {canManage && (
        <div className="flex items-end gap-2">
          <Field label="Invite" className="flex-1">
            <Input
              aria-label={`invite to ${ws.name}`}
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
              aria-label={`new member role for ${ws.name}`}
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as WorkspaceRole)}
              className="text-sm h-9 px-2 rounded border border-line bg-bg text-ink"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <Button size="sm" onClick={invite} disabled={busy || !newEmail.trim()}>
            <UserPlus size={12} /> Add
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {loading ? (
        <div className="text-[11px] text-ink-muted">Loading members…</div>
      ) : noMembers ? (
        <div className="text-[11px] text-ink-muted">No members yet.</div>
      ) : (
        <ul className="flex flex-col">
          {members.map((m) => (
            <li
              key={m.userId}
              className="flex items-center gap-2 text-sm py-1 border-t border-line first:border-t-0"
            >
              <span className="flex-1 truncate">{m.email}</span>
              {canManage ? (
                <select
                  aria-label={`role of ${m.email} in ${ws.name}`}
                  value={m.role}
                  onChange={(e) => void changeRole(m, e.target.value as WorkspaceRole)}
                  disabled={busy}
                  className="text-xs px-2 py-0.5 rounded border border-line bg-bg text-ink"
                >
                  <option value="viewer">{ROLE_LABEL.viewer}</option>
                  <option value="editor">{ROLE_LABEL.editor}</option>
                  <option value="admin">{ROLE_LABEL.admin}</option>
                </select>
              ) : (
                <span className="text-xs text-ink-muted">{ROLE_LABEL[m.role]}</span>
              )}
              {canManage && (
                <button
                  onClick={() => void remove(m)}
                  aria-label={`remove ${m.email}`}
                  disabled={busy}
                  className="p-1 text-ink-muted hover:text-red-400 rounded"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
