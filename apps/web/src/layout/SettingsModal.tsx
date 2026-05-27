import { useEffect, useState } from 'react';
import type { ApiClient, Info, Stats, TokenInfo } from '../api';
import type { Prefs } from '../useSettings';
import { Button, Field, IconButton, Input, Modal, Select } from '../ui';
import { LANGS, useT } from '../i18n';

export type Tab = 'connect' | 'appearance' | 'search' | 'ai' | 'mcp' | 'space' | 'about';

const TAB_IDS: Tab[] = ['connect', 'appearance', 'search', 'ai', 'mcp', 'space', 'about'];

export function SettingsModal({
  open,
  onClose,
  api,
  spaceId,
  prefs,
  setPref,
  tab,
  onTabChange,
}: {
  open: boolean;
  onClose: () => void;
  api: ApiClient;
  spaceId: string | null;
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
  tab: Tab;
  onTabChange: (t: Tab) => void;
}) {
  const setTab = onTabChange;
  const t = useT();

  return (
    <Modal open={open} onClose={onClose} title={t('settings.title')} size="xl">
      <div className="flex h-[70vh] min-h-[420px]" data-testid="settings-modal">
        <nav className="w-48 shrink-0 border-r border-line p-2 flex flex-col gap-0.5 bg-bg">
          {TAB_IDS.map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              data-testid={`settings-tab-${id}`}
              className={`text-left text-sm px-3 py-2 rounded-md ${
                tab === id ? 'bg-brand text-white' : 'text-ink hover:bg-bg-surface'
              }`}
            >
              {t(`settings.tab.${id}`)}
            </button>
          ))}
        </nav>
        <div className="flex-1 min-w-0 overflow-auto p-5">
          {tab === 'connect' && <ConnectTab api={api} />}
          {tab === 'appearance' && <AppearanceTab prefs={prefs} setPref={setPref} />}
          {tab === 'search' && <SearchTab prefs={prefs} setPref={setPref} />}
          {tab === 'ai' && <AiTab api={api} />}
          {tab === 'mcp' && <McpTab api={api} />}
          {tab === 'space' && <SpaceTab api={api} spaceId={spaceId} />}
          {tab === 'about' && <AboutTab api={api} />}
        </div>
      </div>
    </Modal>
  );
}

function ConnectTab({ api }: { api: ApiClient }) {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const mcpUrl = `${window.location.origin}/mcp`;
  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <h3 className="text-lg font-semibold">{t('settings.connect.heading')}</h3>
      <p
        className="text-sm text-ink-muted leading-relaxed"
        dangerouslySetInnerHTML={{ __html: t('settings.connect.lead') }}
      />
      <ol className="space-y-3 list-decimal pl-5 text-sm">
        <li>
          {t('settings.connect.step1')}{' '}
          <code className="px-2 py-0.5 bg-bg rounded" data-testid="mcp-url">{mcpUrl}</code>
        </li>
        <li>
          {t('settings.connect.step2')}{' '}
          <Button onClick={async () => setToken((await api.mintToken('Mi IA')).token)}>
            {t('settings.connect.step2Button')}
          </Button>
          {token && (
            <p className="mt-2 p-3 rounded-md border border-brand bg-brand-soft text-xs" data-testid="home-token">
              {t('settings.connect.step2Hint')}{' '}
              <code className="break-all">{token}</code>
            </p>
          )}
        </li>
        <li>{t('settings.connect.step3')}</li>
      </ol>
      <p
        className="text-xs text-ink-muted"
        dangerouslySetInnerHTML={{ __html: t('settings.connect.tip') }}
      />
    </div>
  );
}

function AppearanceTab({
  prefs,
  setPref,
}: {
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4 max-w-md">
      <h3 className="text-lg font-semibold">{t('settings.appearance.title')}</h3>
      <Field label={t('settings.appearance.theme')}>
        <Select
          aria-label="theme"
          value={prefs.theme}
          onChange={(e) => setPref('theme', e.target.value as Prefs['theme'])}
        >
          <option value="dark">{t('settings.appearance.themeDark')}</option>
          <option value="light">{t('settings.appearance.themeLight')}</option>
        </Select>
      </Field>
      <Field label={t('settings.appearance.accent')}>
        <input
          aria-label="accent"
          type="color"
          value={prefs.accent}
          onChange={(e) => setPref('accent', e.target.value)}
          className="w-16 h-8 rounded-md border border-line bg-bg"
        />
      </Field>
      <Field label={t('settings.appearance.language')}>
        <Select
          aria-label="language"
          value={prefs.lang}
          onChange={(e) => setPref('lang', e.target.value as Prefs['lang'])}
        >
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {l === 'en' ? 'English' : 'Español'}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

function SearchTab({ prefs, setPref }: { prefs: Prefs; setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4 max-w-md">
      <h3 className="text-lg font-semibold">{t('settings.search.heading')}</h3>
      <p
        className="text-sm text-ink-muted"
        dangerouslySetInnerHTML={{ __html: t('settings.search.lead') }}
      />
      <Field label={t('settings.search.modeLabel')}>
        <Select
          aria-label="search mode"
          value={prefs.searchMode}
          onChange={(e) => setPref('searchMode', e.target.value as Prefs['searchMode'])}
        >
          <option value="hybrid">{t('settings.search.modeHybrid')}</option>
          <option value="keyword">{t('settings.search.modeKeyword')}</option>
          <option value="semantic">{t('settings.search.modeSemantic')}</option>
        </Select>
      </Field>
      <Field label={t('settings.search.topKLabel')}>
        <Input
          aria-label="topK"
          type="number"
          min={1}
          max={20}
          value={prefs.topK}
          onChange={(e) => setPref('topK', Number(e.target.value) || 5)}
          className="w-24"
        />
      </Field>
    </div>
  );
}

function AiTab({ api }: { api: ApiClient }) {
  const t = useT();
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    void api.info().then(setInfo);
  }, [api]);
  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <h3 className="text-lg font-semibold">{t('settings.ai.heading')}</h3>
      <p
        className="text-sm text-ink-muted leading-relaxed"
        dangerouslySetInnerHTML={{ __html: t('settings.ai.lead') }}
      />
      <pre className="text-xs bg-bg p-3 rounded-md border border-line whitespace-pre">{`AZURE_OPENAI_ENDPOINT=...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=text-embedding-3-large`}</pre>
      <p className="text-sm">
        {t('settings.ai.active')} <strong data-testid="embedder">{info?.embedder ?? '…'}</strong>
      </p>
    </div>
  );
}

function McpTab({ api }: { api: ApiClient }) {
  const t = useT();
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<string | null>(null);
  const mcpUrl = `${window.location.origin}/mcp`;
  useEffect(() => {
    void api.listTokens().then(setTokens);
  }, [api]);
  async function mint() {
    const t = await api.mintToken(name.trim() || 'Claude');
    setMinted(t.token);
    setName('');
    setTokens(await api.listTokens());
  }
  async function revoke(id: string) {
    await api.revokeToken(id);
    setTokens(await api.listTokens());
  }
  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <h3 className="text-lg font-semibold">{t('settings.mcp.heading')}</h3>
      <p className="text-sm text-ink-muted">
        {t('settings.mcp.lead')}{' '}
        <code className="px-2 py-0.5 bg-bg rounded" data-testid="mcp-url">{mcpUrl}</code>
      </p>
      <div className="flex gap-2 items-end">
        <Field label={t('settings.mcp.newTokenLabel')}>
          <Input
            aria-label="token name"
            placeholder={t('settings.mcp.newTokenPlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-72"
          />
        </Field>
        <Button onClick={mint}>{t('settings.mcp.generate')}</Button>
      </div>
      {minted && (
        <p className="p-3 rounded-md border border-brand bg-brand-soft text-xs" data-testid="nuevo-token">
          {t('settings.mcp.minted')} <code className="break-all">{minted}</code>
        </p>
      )}
      <div>
        <h4 className="text-sm font-semibold mb-2">{t('settings.mcp.activeTokens')}</h4>
        <ul className="flex flex-col gap-1">
          {tokens.length === 0 && (
            <li className="text-sm text-ink-muted">{t('settings.mcp.noTokens')}</li>
          )}
          {tokens.map((tk) => (
            <li key={tk.id} className="flex items-center justify-between text-sm border border-line rounded-md px-2 py-1">
              <span>{tk.name}</span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => revoke(tk.id)}
                aria-label={`revoke ${tk.name}`}
              >
                {t('settings.mcp.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SpaceTab({ api, spaceId }: { api: ApiClient; spaceId: string | null }) {
  const t = useT();
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    if (spaceId) void api.stats(spaceId).then(setStats);
  }, [api, spaceId]);
  async function exportNotes() {
    if (!spaceId) return;
    const notes = await api.listNotes(spaceId);
    const blob = new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'diluxite-export.json';
    a.click();
  }
  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <h3 className="text-lg font-semibold">{t('settings.space.heading')}</h3>
      <p className="text-sm text-ink-muted" data-testid="space-stats">
        {t('settings.space.stats', {
          notes: stats?.notes ?? 0,
          tags: stats?.tags ?? 0,
          links: stats?.links ?? 0,
        })}
      </p>
      <div>
        <Button onClick={exportNotes}>{t('settings.space.export')}</Button>
      </div>
    </div>
  );
}

function AboutTab({ api }: { api: ApiClient }) {
  const t = useT();
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    void api.info().then(setInfo);
  }, [api]);
  return (
    <div className="flex flex-col gap-3 max-w-xl">
      <h3 className="text-lg font-semibold">{t('settings.about.heading')}</h3>
      <p className="text-sm text-ink-muted">
        {t('settings.about.version', { version: info?.version ?? '4.0.0-alpha.0' })}
      </p>
      <p className="text-sm text-ink-muted">
        {t('settings.about.user')}{' '}
        <strong>{info?.user?.email ?? t('settings.about.userFallback')}</strong>
      </p>
    </div>
  );
}
