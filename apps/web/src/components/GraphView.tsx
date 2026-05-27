import { useEffect, useRef, useState } from 'react';
import type { ApiClient, Graph } from '../api';

interface NodeState {
  id: string;
  title: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

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
  const nodesRef = useRef<NodeState[]>([]);
  const dragRef = useRef<{ id: string | null; moved: boolean; sx: number; sy: number }>({
    id: null,
    moved: false,
    sx: 0,
    sy: 0,
  });
  const rafRef = useRef<number | null>(null);

  // Carga del grafo
  useEffect(() => {
    if (spaceId) void api.graph(spaceId).then(setGraph);
  }, [api, spaceId]);

  // Re-inicializa posiciones cuando cambia el grafo (preserva las ya existentes)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.width;
    const H = canvas.height;
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    nodesRef.current = graph.nodes.map((n, i) => {
      const old = prev.get(n.id);
      if (old) return { ...old, title: n.title };
      const a = (2 * Math.PI * i) / Math.max(graph.nodes.length, 1);
      return {
        id: n.id,
        title: n.title,
        x: W / 2 + Math.cos(a) * 140,
        y: H / 2 + Math.sin(a) * 140,
        vx: 0,
        vy: 0,
      };
    });
  }, [graph]);

  // Loop de simulación + render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return; // jsdom: sin canvas real

    const W = canvas.width;
    const H = canvas.height;
    const c = ctx;

    function step() {
      const nodes = nodesRef.current;
      const N = nodes.length;
      const dragging = dragRef.current.id;
      // Repulsión entre nodos
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          const d2 = dx * dx + dy * dy || 1;
          const d = Math.sqrt(d2);
          const f = 1800 / d2;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          if (dragging !== a.id) {
            a.vx += fx;
            a.vy += fy;
          }
          if (dragging !== b.id) {
            b.vx -= fx;
            b.vy -= fy;
          }
        }
      }
      // Atracción por aristas
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const e of graph.edges) {
        const s = byId.get(e.source);
        const t = byId.get(e.target);
        if (!s || !t) continue;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 110) * 0.02;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        if (dragging !== s.id) {
          s.vx += fx;
          s.vy += fy;
        }
        if (dragging !== t.id) {
          t.vx -= fx;
          t.vy -= fy;
        }
      }
      // Gravedad al centro + fricción + integración
      for (const n of nodes) {
        if (dragging === n.id) {
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx += (W / 2 - n.x) * 0.0015;
        n.vy += (H / 2 - n.y) * 0.0015;
        n.vx *= 0.86;
        n.vy *= 0.86;
        n.x += n.vx;
        n.y += n.vy;
      }
      // Render
      c.clearRect(0, 0, W, H);
      c.strokeStyle = 'rgba(0,134,113,0.5)';
      c.lineWidth = 1.5;
      for (const e of graph.edges) {
        const s = byId.get(e.source);
        const t = byId.get(e.target);
        if (!s || !t) continue;
        c.beginPath();
        c.moveTo(s.x, s.y);
        c.lineTo(t.x, t.y);
        c.stroke();
      }
      for (const n of nodes) {
        c.beginPath();
        c.arc(n.x, n.y, 10, 0, Math.PI * 2);
        c.fillStyle = '#008671';
        c.fill();
        c.fillStyle = '#ddd';
        c.font = '12px system-ui, sans-serif';
        c.fillText(n.title, n.x + 14, n.y + 4);
      }
      rafRef.current = requestAnimationFrame(step);
    }
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [graph]);

  function bitmapPos(e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
    };
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const { x, y } = bitmapPos(e);
    const hit = nodesRef.current.find((n) => (x - n.x) ** 2 + (y - n.y) ** 2 < 14 * 14);
    dragRef.current = { id: hit?.id ?? null, moved: false, sx: x, sy: y };
  }
  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    if (!d.id) return;
    const { x, y } = bitmapPos(e);
    const node = nodesRef.current.find((n) => n.id === d.id);
    if (!node) return;
    node.x = x;
    node.y = y;
    if (Math.abs(x - d.sx) + Math.abs(y - d.sy) > 4) d.moved = true;
  }
  function onMouseUp() {
    const d = dragRef.current;
    if (d.id && !d.moved) onOpen(d.id);
    dragRef.current = { id: null, moved: false, sx: 0, sy: 0 };
  }

  return (
    <div className="h-full flex flex-col" data-testid="graph">
      <header className="px-4 py-2 border-b border-line flex items-center justify-between bg-bg-surface text-sm shrink-0">
        <span className="text-ink font-medium">🕸 Knowledge graph</span>
        <span className="text-xs text-ink-muted">
          edges = wikilinks{' '}
          <code className="px-1.5 py-0.5 bg-bg rounded border border-line">[[Note]]</code>{' '}
          · drag to move · click to open
        </span>
      </header>

      <div className="relative flex-1 min-h-0">
        <canvas
          ref={canvasRef}
          width={1200}
          height={800}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          className="absolute inset-0 w-full h-full bg-bg cursor-grab"
        />
        {graph.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-ink-muted text-sm pointer-events-none px-8 text-center">
            No notes yet. Create some and link them with{' '}
            <code className="mx-1 px-1.5 py-0.5 bg-bg rounded border border-line">[[Title]]</code>{' '}
            to see the graph.
          </div>
        )}
      </div>

      {/* Lista accesible (también sirve si el canvas no está disponible, ej. tests). */}
      <ul
        data-testid="graph-nodes"
        className="px-4 py-2 border-t border-line bg-bg-surface flex flex-wrap gap-1 text-xs shrink-0 max-h-32 overflow-auto"
      >
        {graph.nodes.map((n) => (
          <li key={n.id}>
            <button
              onClick={() => onOpen(n.id)}
              className="px-2 py-0.5 rounded bg-brand-soft text-brand border border-line"
            >
              {n.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
