import { useEffect, useState } from 'react';
import type { ApiClient, TokenInfo } from '../api';

export function Settings({ api }: { api: ApiClient }) {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [nombre, setNombre] = useState('');
  const [minted, setMinted] = useState<string | null>(null);

  const mcpUrl = `${window.location.origin}/mcp`;

  useEffect(() => {
    void api.listTokens().then(setTokens);
  }, [api]);

  async function mint() {
    const { token } = await api.mintToken(nombre.trim() || 'Claude');
    setMinted(token);
    setNombre('');
    setTokens(await api.listTokens());
  }

  async function revoke(id: string) {
    await api.revokeToken(id);
    setTokens(await api.listTokens());
  }

  return (
    <div className="settings">
      <h2>Conectar tu IA (MCP)</h2>
      <p>
        Tu supermemoria se conecta a Claude / Copilot por MCP. Endpoint:&nbsp;
        <code data-testid="mcp-url">{mcpUrl}</code>
      </p>
      <p className="muted">
        En Claude: agregá un conector remoto con esa URL y, si tu instancia pide auth, un token de abajo.
      </p>

      <div className="row">
        <input
          aria-label="nombre token"
          placeholder="Nombre del token (ej: Claude de la notebook)"
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

      <h3>Tokens activos</h3>
      <ul>
        {tokens.length === 0 && <li className="muted">Todavía no generaste ninguno.</li>}
        {tokens.map((t) => (
          <li key={t.id}>
            {t.nombre}
            <button aria-label={`revocar ${t.nombre}`} onClick={() => revoke(t.id)}>
              revocar
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
