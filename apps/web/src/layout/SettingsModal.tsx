import { useEffect, useState } from 'react';
import type { ApiClient, Info, Stats, TokenInfo } from '../api';
import { resetPrefs, type Prefs } from '../useSettings';
import { Button, Field, IconButton, Input, Modal, Select, useDialogs } from '../ui';
import { LANGS, LANG_LABELS, useT } from '../i18n';
import { SecurityTab } from '../shell/SecurityTab';

export type Tab =
  | 'connect'
  | 'appearance'
  | 'mcp'
  | 'security'
  | 'about';

const TAB_IDS: Tab[] = [
  'connect',
  'appearance',
  'mcp',
  'security',
  'about',
];

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
          {tab === 'mcp' && <McpTab api={api} />}
          {tab === 'security' && <SecurityTab api={api} />}
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
  // Draft local — los cambios NO se aplican hasta que el user clickea Save.
  // Pattern explicit: previene "guardé sin querer" + da feedback visible.
  const [draft, setDraft] = useState<Prefs>(prefs);
  const [saved, setSaved] = useState(false);
  // Re-sincronizar el draft si el padre cambia prefs (e.g. otra tab modificó).
  useEffect(() => {
    setDraft(prefs);
  }, [prefs]);
  const dirty =
    draft.theme !== prefs.theme || draft.accent !== prefs.accent || draft.lang !== prefs.lang;

  function set<K extends keyof Prefs>(k: K, v: Prefs[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
    setSaved(false);
  }
  function save() {
    if (draft.theme !== prefs.theme) setPref('theme', draft.theme);
    if (draft.accent !== prefs.accent) setPref('accent', draft.accent);
    if (draft.lang !== prefs.lang) setPref('lang', draft.lang);
    setSaved(true);
  }

  return (
    <div className="flex flex-col gap-4 max-w-md">
      <h3 className="text-lg font-semibold">{t('settings.appearance.title')}</h3>
      <Field label={t('settings.appearance.theme')}>
        <Select
          aria-label="theme"
          value={draft.theme}
          onChange={(e) => set('theme', e.target.value as Prefs['theme'])}
        >
          <option value="dark">{t('settings.appearance.themeDark')}</option>
          <option value="light">{t('settings.appearance.themeLight')}</option>
        </Select>
      </Field>
      <Field label={t('settings.appearance.accent')}>
        <div className="flex items-center gap-3">
          <input
            aria-label="accent"
            type="color"
            value={draft.accent}
            onChange={(e) => set('accent', e.target.value)}
            className="w-16 h-8 rounded-md border border-line bg-bg"
          />
          <span className="text-xs text-ink-muted">{t('settings.appearance.accentHelp')}</span>
        </div>
      </Field>
      <Field label={t('settings.appearance.language')}>
        <Select
          aria-label="language"
          value={draft.lang}
          onChange={(e) => set('lang', e.target.value as Prefs['lang'])}
        >
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {LANG_LABELS[l]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-center gap-2 mt-2">
        <Button data-testid="appearance-save" onClick={save} disabled={!dirty}>
          {t('settings.appearance.save')}
        </Button>
        <Button
          data-testid="appearance-reset"
          variant="ghost"
          onClick={() => {
            resetPrefs();
            setSaved(false);
          }}
        >
          {t('settings.appearance.reset')}
        </Button>
        {saved && !dirty && (
          <span data-testid="appearance-saved" className="text-xs text-brand">
            ✓ {t('settings.appearance.saved')}
          </span>
        )}
      </div>
    </div>
  );
}


function McpTab({ api }: { api: ApiClient }) {
  const t = useT();
  const dialogs = useDialogs();
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [name, setName] = useState('');
  const [ttlDays, setTtlDays] = useState<string>(''); // empty = no TTL
  const [minted, setMinted] = useState<string | null>(null);
  const mcpUrl = `${window.location.origin}/mcp`;
  useEffect(() => {
    void api.listTokens().then(setTokens);
  }, [api]);
  async function mint() {
    const parsedTtl = ttlDays.trim() === '' ? null : Number.parseInt(ttlDays, 10);
    const ttl = parsedTtl && Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : null;
    const tk = await api.mintToken(name.trim() || 'Claude', ttl);
    setMinted(tk.token);
    setName('');
    setTtlDays('');
    setTokens(await api.listTokens());
  }
  async function revoke(id: string) {
    await api.revokeToken(id);
    setTokens(await api.listTokens());
  }
  async function revokeAll() {
    if (tokens.length === 0) return;
    const ok = await dialogs.confirm(`Revoke ALL ${tokens.length} of your tokens?`, {
      message:
        'Any Claude / Copilot / curl client using one of these tokens will lose access immediately. ' +
        'You can mint a new token after this, but the old ones cannot be recovered. ' +
        'Use this when you suspect a credential leak.',
      danger: true,
      okLabel: 'Revoke all',
    });
    if (!ok) return;
    await api.revokeAllTokens();
    setTokens(await api.listTokens());
  }
  function formatExpiry(iso?: string | null): string {
    if (!iso) return 'never';
    const date = new Date(iso);
    const now = Date.now();
    if (date.getTime() < now) return 'expired';
    return date.toLocaleDateString();
  }
  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <h3 className="text-lg font-semibold">{t('settings.mcp.heading')}</h3>
      <p className="text-sm text-ink-muted">
        {t('settings.mcp.lead')}{' '}
        <code className="px-2 py-0.5 bg-bg rounded" data-testid="mcp-url">{mcpUrl}</code>
      </p>
      <div className="flex gap-2 items-end flex-wrap">
        <Field label={t('settings.mcp.newTokenLabel')}>
          <Input
            aria-label="token name"
            placeholder={t('settings.mcp.newTokenPlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-72"
          />
        </Field>
        <Field label="Expires in (days, optional)">
          <Input
            aria-label="token ttl days"
            type="number"
            inputMode="numeric"
            min={1}
            placeholder="never"
            value={ttlDays}
            onChange={(e) => setTtlDays(e.target.value)}
            className="w-32"
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
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold">{t('settings.mcp.activeTokens')}</h4>
          {tokens.length > 0 && (
            <Button
              variant="danger"
              size="sm"
              onClick={revokeAll}
              aria-label="revoke all tokens"
              data-testid="revoke-all-tokens"
            >
              Revoke all ({tokens.length})
            </Button>
          )}
        </div>
        <ul className="flex flex-col gap-1">
          {tokens.length === 0 && (
            <li className="text-sm text-ink-muted">{t('settings.mcp.noTokens')}</li>
          )}
          {tokens.map((tk) => (
            <li
              key={tk.id}
              className="flex items-center justify-between text-sm border border-line rounded-md px-2 py-1"
            >
              <div className="flex flex-col min-w-0">
                <span className="truncate">{tk.name}</span>
                <span className="text-[10px] text-ink-muted">
                  expires: {formatExpiry(tk.expiresAt)}
                </span>
              </div>
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
