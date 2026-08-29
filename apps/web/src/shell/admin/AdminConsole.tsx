import { useEffect, useState } from 'react';
import type { OrganizationWithRole } from '../../api';
import type { Prefs } from '../../useSettings';
import { useApp } from '../AppContext';
import { Settings } from '../../icons';
import { OrganizationTab } from './OrganizationTab';
import { OrgMembersTab } from './OrgMembersTab';
import { WorkspacesTab } from './WorkspacesTab';
import { ApiKeysTab } from './ApiKeysTab';
import { OrgTokensTab } from './OrgTokensTab';
import { AuditTab } from './AuditTab';
import { SearchConfigTab } from './SearchConfigTab';
import { CurrentWorkspaceTab } from './CurrentWorkspaceTab';

export type AdminSection =
  | 'organization'
  | 'members'
  | 'workspaces'
  | 'current-workspace'
  | 'api-keys'
  | 'org-tokens'
  | 'ai'
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
        <AiConfigTab />
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

/**
 * Admin · AI — current embedder for this Diluxite instance.
 *
 * Embeddings are an *instance-wide* concern (the model dictates the vector
 * dimension, which is fixed at schema level). So the config lives at the
 * container/env level, not per-user. This panel surfaces what's currently
 * wired and the env vars to change it; rotating to a different model
 * implies a re-index and a restart, which is deliberately a CLI op.
 */
function AiConfigTab() {
  const { api } = useApp();
  const [info, setInfo] = useState<{ embedder: string } | null>(null);
  useEffect(() => {
    api.info().then((i) => setInfo({ embedder: i.embedder ?? 'unknown' }));
  }, [api]);

  return (
    <div className="max-w-2xl">
      <header className="mb-4">
        <h2 className="text-lg font-semibold flex items-center gap-2 text-ink">
          <Settings size={16} className="text-brand" /> AI / Embeddings
        </h2>
        <p className="text-xs text-ink-muted mt-1">
          The semantic engine for this organisation. Configured at install time via
          environment variables; changing it requires a restart and a re-index.
        </p>
      </header>

      <section className="rounded border border-line bg-bg-surface p-4 mb-4">
        <div className="text-[10px] uppercase tracking-wider text-ink-muted mb-1">Active provider</div>
        <div className="text-base font-mono text-ink">{info?.embedder ?? '…'}</div>
      </section>

      <section className="text-sm text-ink-muted leading-relaxed space-y-3">
        <p>
          Priority: <code className="text-ink">AZURE_OPENAI_*</code> → <code className="text-ink">OLLAMA_*</code> → deterministic fallback.
          Set the relevant env vars on the <code className="text-ink">api</code> container and restart.
        </p>
        <pre className="bg-bg p-3 rounded text-xs text-ink overflow-x-auto border border-line">{`# Ollama (recommended)
OLLAMA_EMBEDDING_MODEL=mxbai-embed-large:335m
OLLAMA_EMBEDDING_DIMENSIONS=1024
OLLAMA_ENDPOINT=http://host.docker.internal:11434

# Azure OpenAI (overrides Ollama if all three are set)
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=text-embedding-3-large`}</pre>
      </section>
    </div>
  );
}

