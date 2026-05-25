import { useEffect, useState } from 'react';
import type { ApiClient, Info, Stats, TokenInfo } from '../api';
import type { Prefs } from '../useSettings';

export function Settings({
  api,
  spaceId,
  prefs,
  setPref,
}: {
  api: ApiClient;
  spaceId: string | null;
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
}) {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [nombre, setNombre] = useState('');
  const [minted, setMinted] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const mcpUrl = `${window.location.origin}/mcp`;

  useEffect(() => {
    void api.listTokens().then(setTokens);
    void api.info().then(setInfo);
  }, [api]);
  useEffect(() => {
    if (spaceId) void api.stats(spaceId).then(setStats);
  }, [api, spaceId]);

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
    <div className="settings">
      <h2>Ajustes</h2>

      <section>
        <h3>Apariencia</h3>
        <p className="muted">Tema y color de marca de la interfaz.</p>
        <div className="row">
          <label>
            Tema{' '}
            <select
              aria-label="tema"
              value={prefs.theme}
              onChange={(e) => setPref('theme', e.target.value as Prefs['theme'])}
            >
              <option value="oscuro">Oscuro</option>
              <option value="claro">Claro</option>
            </select>
          </label>
          <label>
            Color{' '}
            <input
              aria-label="color"
              type="color"
              value={prefs.accent}
              onChange={(e) => setPref('accent', e.target.value)}
            />
          </label>
        </div>
      </section>

      <section>
        <h3>Búsqueda</h3>
        <p className="muted">
          Cómo busca tu IA en la memoria. <strong>Híbrida</strong> combina palabra exacta +
          significado (recomendado). Solo-palabra es literal; solo-significado ignora la palabra
          exacta.
        </p>
        <div className="row">
          <label>
            Modo{' '}
            <select
              aria-label="modo búsqueda"
              value={prefs.searchMode}
              onChange={(e) => setPref('searchMode', e.target.value as Prefs['searchMode'])}
            >
              <option value="hybrid">Híbrida</option>
              <option value="keyword">Solo palabra</option>
              <option value="semantic">Solo significado</option>
            </select>
          </label>
          <label>
            Resultados (topK){' '}
            <input
              aria-label="topK"
              type="number"
              min={1}
              max={20}
              value={prefs.topK}
              onChange={(e) => setPref('topK', Number(e.target.value) || 5)}
            />
          </label>
        </div>
      </section>

      <section>
        <h3>IA / Embeddings</h3>
        <p className="muted">
          El motor que convierte tus notas en significado buscable. <strong>local</strong> funciona
          sin claves; <strong>azure</strong> (Azure OpenAI) da mejor calidad y se activa por
          variables de entorno <code>AZURE_OPENAI_*</code>.
        </p>
        <p>
          Motor activo: <strong data-testid="embedder">{info?.embedder ?? '…'}</strong>
        </p>
      </section>

      <section>
        <h3>Conexión MCP</h3>
        <p className="muted">
          Conectá Claude / Copilot a tu memoria. Endpoint: <code data-testid="mcp-url">{mcpUrl}</code>
        </p>
        <div className="row">
          <input
            aria-label="nombre token"
            placeholder="Nombre (ej: Claude de la notebook)"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
          />
          <button onClick={mint}>Generar token</button>
        </div>
        {minted && (
          <p className="token-nuevo" data-testid="nuevo-token">
            Copialo ahora (no se vuelve a mostrar): <code>{minted}</code>
          </p>
        )}
        <ul>
          {tokens.length === 0 && <li className="muted">Sin tokens.</li>}
          {tokens.map((t) => (
            <li key={t.id}>
              {t.nombre}
              <button aria-label={`revocar ${t.nombre}`} onClick={() => revoke(t.id)}>
                revocar
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Espacio</h3>
        <p className="muted" data-testid="space-stats">
          {stats?.notas ?? 0} notas · {stats?.tags ?? 0} tags · {stats?.links ?? 0} enlaces
        </p>
        <button onClick={exportar}>Exportar notas (JSON)</button>
      </section>

      <section>
        <h3>Acerca de</h3>
        <p className="muted">
          Diluxite v{info?.version ?? '0.1.0'} · open-core (AGPL-3.0). La memoria de tu IA.
        </p>
      </section>
    </div>
  );
}
