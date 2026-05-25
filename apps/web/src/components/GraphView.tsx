import { useEffect, useRef, useState } from 'react';
import type { ApiClient, Graph } from '../api';

export function GraphView({
  api,
  spaceId,
  onOpen,
}: {
  api: ApiClient;
  spaceId: string | null;
  onOpen: (id: string) => void;
}) {
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (spaceId) void api.graph(spaceId).then(setGraph);
  }, [api, spaceId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null; // jsdom no implementa canvas
    }
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2 - 60;
    const pos = new Map<string, { x: number; y: number }>();
    graph.nodes.forEach((n, i) => {
      const a = (2 * Math.PI * i) / Math.max(graph.nodes.length, 1);
      pos.set(n.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    });
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(0,134,113,0.5)';
    ctx.lineWidth = 1.5;
    for (const e of graph.edges) {
      const s = pos.get(e.source);
      const t = pos.get(e.target);
      if (s && t) {
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();
      }
    }
    for (const n of graph.nodes) {
      const p = pos.get(n.id)!;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, 2 * Math.PI);
      ctx.fillStyle = '#008671';
      ctx.fill();
      ctx.fillStyle = '#ddd';
      ctx.font = '12px sans-serif';
      ctx.fillText(n.titulo, p.x + 11, p.y + 4);
    }
  }, [graph]);

  return (
    <div className="graph" data-testid="graph">
      <canvas ref={canvasRef} width={800} height={600} />
      <ul className="graph-nodes" data-testid="graph-nodes">
        {graph.nodes.length === 0 && <li className="muted">Grafo vacío. Enlazá notas con [[...]].</li>}
        {graph.nodes.map((n) => (
          <li key={n.id}>
            <button onClick={() => onOpen(n.id)}>{n.titulo}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
