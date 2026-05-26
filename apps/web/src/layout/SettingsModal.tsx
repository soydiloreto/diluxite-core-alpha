import { useEffect, useState } from 'react';
import type { ApiClient, Info, Stats, TokenInfo } from '../api';
import type { Prefs } from '../useSettings';
import { Button, Field, IconButton, Input, Modal, Select } from '../ui';

type Tab = 'connect' | 'appearance' | 'search' | 'ai' | 'mcp' | 'space' | 'about';

const TABS: { id: Tab; label: string }[] = [
  { id: 'connect', label: 'Conectar IA' },
  { id: 'appearance', label: 'Apariencia' },
  { id: 'search', label: 'Búsqueda' },
  { id: 'ai', label: 'IA / Embeddings' },
  { id: 'mcp', label: 'Conexión MCP' },
  { id: 'space', label: 'Espacio' },
  { id: 'about', label: 'Acerca de' },
];

export function SettingsModal({
  open,
  onClose,
  api,
  spaceId,
  prefs,
  setPref,
  initialTab = 'connect',
}: {
  open: boolean;
  onClose: () => void;
  api: ApiClient;
  spaceId: string | null;
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  return (
    <Modal open={open} onClose={onClose} title="Ajustes" size="xl">
      <div className="flex h-[70vh] min-h-[420px]" data-testid="settings-modal">
        <nav className="w-48 shrink-0 border-r border-line p-2 flex flex-col gap-0.5 bg-bg">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              data-testid={`settings-tab-${t.id}`}
              className={`text-left text-sm px-3 py-2 rounded-md ${
                tab === t.id ? 'bg-brand text-white' : 'text-ink hover:bg-bg-surface'
              }`}
            >
              {t.label}
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
  const [token, setToken] = useState<string | null>(null);
  const mcpUrl = `${window.location.origin}/mcp`;
  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <h3 className="text-lg font-semibold">Conectá tu IA en 3 pasos</h3>
      <p className="text-sm text-ink-muted leading-relaxed">
        Diluxite es la <strong>memoria de tu IA</strong>. Esto permite que Claude / Copilot lean,
        escriban y busquen en tu memoria por significado — recordando entre sesiones.
      </p>
      <ol className="space-y-3 list-decimal pl-5 text-sm">
        <li>
          Copiá el endpoint MCP: <code className="px-2 py-0.5 bg-bg rounded" data-testid="mcp-url">{mcpUrl}</code>
        </li>
        <li>
          Generá un token de acceso:{' '}
          <Button onClick={async () => setToken((await api.mintToken('Mi IA')).token)}>
            Generar token
          </Button>
          {token && (
            <p className="mt-2 p-3 rounded-md border border-brand bg-brand-soft text-xs" data-testid="home-token">
              Copialo ahora (no se vuelve a mostrar):{' '}
              <code className="break-all">{token}</code>
            </p>
          )}
        </li>
        <li>Pegá la URL y el token en Claude / Copilot como conector remoto. Listo.</li>
      </ol>
      <p className="text-xs text-ink-muted">
        Tip: en Claude Code, agregá a tu <code>CLAUDE.md</code>: <em>"Antes de responder, buscá con
        buscar_memoria; cuando algo aporte, guardalo con escribir_nota."</em>
      </p>
    </div>
  );
}

function AppearanceTab({ prefs, setPref }: { prefs: Prefs; setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void }) {
  return (
    <div className="flex flex-col gap-4 max-w-md">
      <h3 className="text-lg font-semibold">Apariencia</h3>
      <p className="text-sm text-ink-muted">Tema y color de marca de la interfaz.</p>
      <Field label="Tema">
        <Select aria-label="tema" value={prefs.theme} onChange={(e) => setPref('theme', e.target.value as Prefs['theme'])}>
          <option value="oscuro">Oscuro</option>
          <option value="claro">Claro</option>
        </Select>
      </Field>
      <Field label="Color de marca">
        <input
          aria-label="color"
          type="color"
          value={prefs.accent}
          onChange={(e) => setPref('accent', e.target.value)}
          className="w-16 h-8 rounded-md border border-line bg-bg"
        />
      </Field>
    </div>
  );
}

function SearchTab({ prefs, setPref }: { prefs: Prefs; setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void }) {
  return (
    <div className="flex flex-col gap-4 max-w-md">
      <h3 className="text-lg font-semibold">Búsqueda</h3>
      <p className="text-sm text-ink-muted">
        Cómo busca tu IA en la memoria. <strong>Híbrida</strong> combina palabra + significado
        (recomendada). Solo-palabra es literal. Solo-significado ignora la palabra exacta.
      </p>
      <Field label="Modo">
        <Select
          aria-label="modo búsqueda"
          value={prefs.searchMode}
          onChange={(e) => setPref('searchMode', e.target.value as Prefs['searchMode'])}
        >
          <option value="hybrid">Híbrida</option>
          <option value="keyword">Solo palabra</option>
          <option value="semantic">Solo significado</option>
        </Select>
      </Field>
      <Field label="Cantidad de resultados (topK)">
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
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    void api.info().then(setInfo);
  }, [api]);
  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <h3 className="text-lg font-semibold">IA / Embeddings</h3>
      <p className="text-sm text-ink-muted leading-relaxed">
        El motor que convierte tus notas en significado buscable. <strong>local</strong> funciona
        sin claves (calidad razonable, ideal para arrancar). <strong>azure</strong> (Azure OpenAI)
        da mejor calidad y se activa por variables de entorno:
      </p>
      <pre className="text-xs bg-bg p-3 rounded-md border border-line whitespace-pre">{`AZURE_OPENAI_ENDPOINT=...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=text-embedding-3-large`}</pre>
      <p className="text-sm">
        Motor activo: <strong data-testid="embedder">{info?.embedder ?? '…'}</strong>
      </p>
    </div>
  );
}

function McpTab({ api }: { api: ApiClient }) {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [nombre, setNombre] = useState('');
  const [minted, setMinted] = useState<string | null>(null);
  const mcpUrl = `${window.location.origin}/mcp`;
  useEffect(() => {
    void api.listTokens().then(setTokens);
  }, [api]);
  async function mint() {
    const t = await api.mintToken(nombre.trim() || 'Claude');
    setMinted(t.token);
    setNombre('');
    setTokens(await api.listTokens());
  }
  async function revoke(id: string) {
    await api.revokeToken(id);
    setTokens(await api.listTokens());
  }
  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <h3 className="text-lg font-semibold">Conexión MCP</h3>
      <p className="text-sm text-ink-muted">
        Conectá Claude / Copilot a tu memoria. Endpoint:{' '}
        <code className="px-2 py-0.5 bg-bg rounded" data-testid="mcp-url">{mcpUrl}</code>
      </p>
      <div className="flex gap-2 items-end">
        <Field label="Nuevo token">
          <Input
            aria-label="nombre token"
            placeholder="Ej: Claude del trabajo"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="w-72"
          />
        </Field>
        <Button onClick={mint}>Generar</Button>
      </div>
      {minted && (
        <p className="p-3 rounded-md border border-brand bg-brand-soft text-xs" data-testid="nuevo-token">
          Copialo ahora (no se vuelve a mostrar): <code className="break-all">{minted}</code>
        </p>
      )}
      <div>
        <h4 className="text-sm font-semibold mb-2">Tokens activos</h4>
        <ul className="flex flex-col gap-1">
          {tokens.length === 0 && <li className="text-sm text-ink-muted">Sin tokens todavía.</li>}
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between text-sm border border-line rounded-md px-2 py-1">
              <span>{t.nombre}</span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => revoke(t.id)}
                aria-label={`revocar ${t.nombre}`}
              >
                revocar
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SpaceTab({ api, spaceId }: { api: ApiClient; spaceId: string | null }) {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    if (spaceId) void api.stats(spaceId).then(setStats);
  }, [api, spaceId]);
  async function exportar() {
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
      <h3 className="text-lg font-semibold">Espacio</h3>
      <p className="text-sm text-ink-muted" data-testid="space-stats">
        {stats?.notas ?? 0} notas · {stats?.tags ?? 0} tags · {stats?.links ?? 0} enlaces
      </p>
      <div>
        <Button onClick={exportar}>Exportar notas (JSON)</Button>
      </div>
    </div>
  );
}

function AboutTab({ api }: { api: ApiClient }) {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    void api.info().then(setInfo);
  }, [api]);
  return (
    <div className="flex flex-col gap-3 max-w-xl">
      <h3 className="text-lg font-semibold">Acerca de</h3>
      <p className="text-sm text-ink-muted">
        Diluxite v{info?.version ?? '0.2.0'} · open-core (AGPL-3.0). La memoria de tu IA.
      </p>
      <p className="text-sm text-ink-muted">
        Usuario activo: <strong>{info?.user?.email ?? 'admin local'}</strong>
      </p>
    </div>
  );
}
