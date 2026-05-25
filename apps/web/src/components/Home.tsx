import { useEffect, useState } from 'react';
import type { ApiClient, Info, Stats } from '../api';

export function Home({
  api,
  spaceId,
  onGoEditor,
  onGoSettings,
}: {
  api: ApiClient;
  spaceId: string | null;
  onGoEditor: () => void;
  onGoSettings: () => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const mcpUrl = `${window.location.origin}/mcp`;

  useEffect(() => {
    void api.info().then(setInfo);
  }, [api]);
  useEffect(() => {
    if (spaceId) void api.stats(spaceId).then(setStats);
  }, [api, spaceId]);

  async function generar() {
    const t = await api.mintToken('Mi IA');
    setToken(t.token);
  }

  return (
    <div className="home">
      <section className="hero">
        <h1>🪨 Diluxite</h1>
        <p className="lead">
          La <strong>memoria de tu IA</strong>. Guardá conocimiento una vez; Claude, Copilot y otros
          asistentes lo recuerdan, lo amplían y lo encuentran por <em>significado</em> — no por
          palabra exacta. Algo que un archivo suelto no te da.
        </p>
      </section>

      <section className="connect" data-testid="connect">
        <h2>Conectá tu IA en 3 pasos</h2>
        <ol>
          <li>
            Copiá el endpoint MCP: <code data-testid="mcp-url">{mcpUrl}</code>
          </li>
          <li>
            Generá un token de acceso: <button onClick={generar}>Generar token</button>
            {token && (
              <>
                {' '}
                <code data-testid="home-token">{token}</code>
              </>
            )}
          </li>
          <li>Pegalos en Claude / Copilot como conector remoto. Listo: tu IA ya tiene memoria.</li>
        </ol>
      </section>

      <section className="stats home-stats" data-testid="home-stats">
        <div>
          <strong>{stats?.notas ?? 0}</strong>
          <span>notas</span>
        </div>
        <div>
          <strong>{stats?.tags ?? 0}</strong>
          <span>tags</span>
        </div>
        <div>
          <strong>{stats?.links ?? 0}</strong>
          <span>enlaces</span>
        </div>
        <div>
          <strong>{info?.embedder ?? '—'}</strong>
          <span>motor IA</span>
        </div>
      </section>

      <section className="quick">
        <button onClick={onGoEditor}>Ir a mis notas</button>
        <button onClick={onGoSettings}>Ir a Ajustes</button>
      </section>
    </div>
  );
}
