import { useEffect, useState } from 'react';
import type { OrganizationWithRole } from '../../api';
import { useApp } from '../AppContext';
import { useDialogs, Button, Field, Input } from '../../ui';
import { Building2, Trash2 } from '../../icons';

/**
 * Admin · Organization — rename + danger-zone delete.
 *
 * Mutations go through `api.*` and then call the matching invalidator on
 * AppContext (`refreshOrgs` / `refreshSpaces`). The local `name` state is
 * synced from props via the effect below so it picks up upstream changes
 * (e.g. another admin renaming the org in a different session).
 */
export function OrganizationTab({ org }: { org: OrganizationWithRole }) {
  const { api, refreshOrgs, refreshSpaces } = useApp();
  const dialogs = useDialogs();
  const [name, setName] = useState(org.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed local state when the org prop changes (switch org / refresh).
  useEffect(() => setName(org.name), [org.name]);

  const canRename = org.role === 'super_admin';
  const canDelete = org.role === 'super_admin';

  async function save() {
    if (!name.trim() || name === org.name) return;
    setSaving(true);
    setError(null);
    try {
      await api.renameOrganization(org.id, name.trim());
      await refreshOrgs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function destroy() {
    const ok = await dialogs.confirm(`Delete organization "${org.name}"?`, {
      message:
        'This permanently removes every workspace, note, folder, member and token under this organization. Cannot be undone.',
      danger: true,
      okLabel: 'Delete organization',
    });
    if (!ok) return;
    setSaving(true);
    try {
      await api.deleteOrganization(org.id);
      // Tell the rest of the app the org is gone — current org will fall back
      // to the next one available; workspaces are filtered through that.
      await Promise.all([refreshOrgs(), refreshSpaces()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold flex items-center gap-2 text-ink">
          <Building2 size={16} className="text-brand" /> Organization
        </h2>
        <p className="text-xs text-ink-muted mt-1">
          The top-level container — owns workspaces, members, billing and tokens. Slug{' '}
          <code className="px-1 py-0.5 rounded bg-bg-surface border border-line text-[10px]">
            {org.slug}
          </code>
          {' '}is immutable.
        </p>
      </header>

      <Field label="Name">
        <div className="flex items-center gap-2">
          <Input
            aria-label="organization name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canRename || saving}
            className="flex-1"
          />
          <Button onClick={save} disabled={!canRename || saving || name === org.name || !name.trim()}>
            Save
          </Button>
        </div>
        {!canRename && (
          <p className="text-[11px] text-ink-muted mt-1">Only super_admins can rename.</p>
        )}
      </Field>

      {error && (
        <p className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2">
          {error}
        </p>
      )}

      {canDelete && (
        <div className="border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-red-300 mb-1">Danger zone</h3>
          <p className="text-xs text-ink-muted mb-3">
            Deleting an organization removes every workspace, note, folder, member and token under it.
            There is no undo.
          </p>
          <Button variant="danger" size="sm" onClick={destroy} disabled={saving}>
            <Trash2 size={13} /> Delete organization
          </Button>
        </div>
      )}
    </div>
  );
}
