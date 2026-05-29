import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useApp } from '../AppContext';
import { Button, useContextMenu } from '../../ui';
import { useT } from '../../i18n';
import {
  Database,
  FileText,
  Folder,
  Hash,
  Link2,
  Network,
  Plug,
  Plus,
  Settings,
  Star,
} from '../../icons';

/**
 * Welcome / dashboard panel. Opened on every click on the brand mark (so
 * it doubles as a "home" surface), and as the default initial tab.
 *
 * Beyond the empty-state hero, it surfaces a stats grid for the active
 * workspace and (when known) the workspace's name — answers the question
 * "where am I and what's in here" without making the user dig.
 */
export function WelcomePanel(_props: IDockviewPanelProps) {
  const { api, spaceId, spaces, notes, folders, tags, openSettings, openGraph } = useApp();
  const t = useT();
  const ctx = useContextMenu();

  const [linksCount, setLinksCount] = useState<number | null>(null);
  // The notes / tags / folders the panel needs are already in AppContext.
  // Links are only exposed by the per-space stats endpoint; load lazily.
  useEffect(() => {
    if (!spaceId) return;
    let cancelled = false;
    void api.stats(spaceId).then((s) => {
      if (!cancelled) setLinksCount(s.links);
    });
    return () => {
      cancelled = true;
    };
  }, [api, spaceId]);

  function startNewNote() {
    window.dispatchEvent(new CustomEvent('diluxite:new-note'));
  }

  const workspace = spaces.find((s) => s.id === spaceId) ?? null;
  const favoritesCount = notes.filter((n) => n.favorite).length;

  return (
    <div
      className="h-full overflow-y-auto bg-bg"
      onContextMenu={(e) =>
        ctx.open(e, [
          { label: 'New note', icon: <Plus size={13} />, onSelect: startNewNote },
          { label: 'Connect AI…', icon: <Plug size={13} />, onSelect: () => openSettings('connect') },
          { label: 'Settings', icon: <Settings size={13} />, onSelect: () => openSettings() },
        ])
      }
    >
      <div className="max-w-3xl mx-auto px-6 sm:px-10 py-10 sm:py-16 flex flex-col gap-10">
        {/* Hero */}
        <header className="flex flex-col items-center text-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-brand-soft text-brand flex items-center justify-center">
            <Database size={28} />
          </div>
          <h1 className="text-2xl font-semibold text-ink">{t('empty.title')}</h1>
          <p className="text-sm text-ink-muted leading-relaxed max-w-md">{t('empty.desc')}</p>
          <div className="flex gap-2 mt-2 flex-wrap justify-center">
            <Button onClick={startNewNote}>
              <Plus size={16} /> {t('empty.newNote')}
            </Button>
            <Button variant="secondary" onClick={() => openSettings('connect')}>
              <Plug size={16} /> {t('empty.connect')}
            </Button>
            <Button variant="ghost" onClick={openGraph}>
              <Network size={16} /> Open graph
            </Button>
          </div>
        </header>

        {/* Workspace context — keeps the user oriented across many spaces. */}
        {workspace && (
          <div
            data-testid="workspace-context"
            className="flex items-center justify-center gap-2 text-sm text-ink-muted"
          >
            You are in workspace{' '}
            <span className="px-2 py-0.5 rounded border border-line bg-bg-surface text-ink font-medium">
              <Folder size={12} className="inline mr-1 -mt-0.5 text-brand" />
              {workspace.name}
            </span>
          </div>
        )}

        {/* Stats grid */}
        <section data-testid="welcome-stats" aria-label="Workspace statistics">
          <h2 className="text-[11px] uppercase tracking-wider text-ink-muted mb-3">Workspace overview</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatCard label="Notes" value={notes.length} icon={<FileText size={14} />} />
            <StatCard label="Folders" value={folders.length} icon={<Folder size={14} />} />
            <StatCard label="Tags" value={tags.length} icon={<Hash size={14} />} />
            <StatCard
              label="Wikilinks"
              value={linksCount ?? '…'}
              icon={<Link2 size={14} />}
              hint="Internal links between notes"
            />
            <StatCard label="Favorites" value={favoritesCount} icon={<Star size={14} />} />
          </div>
        </section>

        {/* Quick links */}
        <section>
          <h2 className="text-[11px] uppercase tracking-wider text-ink-muted mb-3">
            Quick actions
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <QuickLink
              onClick={() => openSettings('mcp')}
              icon={<Plug size={14} className="text-emerald-400" />}
              title="Connect an AI"
              desc="Generate a token and wire Claude or Copilot via MCP."
            />
            <QuickLink
              onClick={() => openSettings('space')}
              icon={<Folder size={14} className="text-brand" />}
              title="Manage workspace"
              desc="Rename, export, or share this workspace."
            />
            <QuickLink
              onClick={openGraph}
              icon={<Network size={14} className="text-brand" />}
              title="Explore the graph"
              desc="See how your notes connect and where the clusters live."
            />
          </div>
        </section>
      </div>
      <ctx.Menu />
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  hint,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  hint?: string;
}) {
  return (
    <div
      className="rounded-md border border-line bg-bg-surface p-3 flex flex-col gap-1"
      title={hint}
    >
      <div className="flex items-center gap-1.5 text-ink-muted text-[11px] uppercase tracking-wider">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-2xl font-semibold text-ink leading-none">{value}</div>
    </div>
  );
}

function QuickLink({
  onClick,
  icon,
  title,
  desc,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <button
      onClick={onClick}
      className="text-left rounded-md border border-line bg-bg-surface p-3 hover:border-brand/40 hover:bg-bg transition-colors flex flex-col gap-1"
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="font-medium text-ink text-sm">{title}</span>
      </div>
      <span className="text-xs text-ink-muted leading-relaxed">{desc}</span>
    </button>
  );
}
