import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient, Graph } from '../api';
import { useApp } from '../shell/AppContext';
import { useSettings } from '../useSettings';
import { extractTags } from '../utils/markdown';
import { ExternalLink, Hash, Sparkles, X } from '../icons';

interface NodeState {
  id: string;
  title: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const ALPHA_DECAY = 0.97;
const ALPHA_MIN = 0.01;
const ALPHA_REHEAT_ON_DRAG = 0.4;
const DEFAULT_NODE_BUDGET = 50;
const MIN_NODE_BUDGET = 10;
const MAX_NODE_BUDGET = 250;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const BUDGET_APPLY_DELAY_MS = 150;

/**
 * View modes for the graph (selectable from the header dropdown):
 *
 *  - all      → top-K notes by degree (default; same behaviour as before).
 *  - hubs     → only the most connected notes (degree ≥ 2). "Where the
 *               conversation happens".
 *  - orphans  → notes with zero edges. Surfaces candidates for cleanup or
 *               for linking better.
 *  - cluster  → top-K like `all`, but coloured by folder. Useful to see
 *               which carpetas talk to which.
 *  - ego      → only the selected note and its 1-hop neighbours. The
 *               focus interaction (click "focus" on a node inspector) sets
 *               this mode automatically.
 */
export type GraphViewMode = 'all' | 'hubs' | 'orphans' | 'cluster' | 'ego';

const VIEW_MODES: { id: GraphViewMode; label: string; hint: string }[] = [
  { id: 'all', label: 'All connections', hint: 'Top-N by degree' },
  { id: 'cluster', label: 'Cluster by folder', hint: 'Top-N coloured by folder' },
  { id: 'hubs', label: 'Hubs', hint: 'Most-linked notes only' },
  { id: 'orphans', label: 'Orphans', hint: 'Notes with no links' },
  { id: 'ego', label: 'Ego (selected)', hint: 'Selected note + 1-hop neighbours' },
];

/**
 * Deterministic hash → palette. A folderId (or any stable string) always
 * resolves to the same colour across reloads, so clusters keep their
 * identity when you toggle the view mode.
 */
const CLUSTER_PALETTE = [
  '#008671', '#3b82f6', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6',
  '#ef4444', '#84cc16', '#f97316', '#6366f1', '#06b6d4', '#eab308',
];
function withAlpha(color: string, a: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (ch) => ch + ch) : m[1];
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function clusterColor(key: string | null | undefined): string {
  if (!key) return '#6b7280'; // root / unassigned → grey
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return CLUSTER_PALETTE[Math.abs(h) % CLUSTER_PALETTE.length];
}

/**
 * Knowledge graph view.
 *
 * The graph is for orientation, not editing: it surfaces clusters
 * (groups of notes that talk about the same thing), hubs (notes
 * connected to many others — usually the ones worth opening first),
 * and orphans (no edges — candidates for archival or for being
 * connected better). The AI side uses the same data to fetch a
 * note's neighbourhood when answering questions about its memory.
 *
 * Interactions, by design:
 *  - wheel: zoom anchored at the cursor (so density-high views are
 *    still legible — zoom in instead of culling).
 *  - drag empty background: pan the camera.
 *  - drag a node: move just that node (it's released by the physics
 *    when you let go).
 *  - single-click a node: selects it; an inspector slides in on the
 *    right with the note's tags, immediate neighbours, and actions.
 *  - double-click a node (or hit "Open note" in the inspector):
 *    opens that note as a Dockview tab.
 *  - "Focus on neighbourhood" in the inspector: trims the visible
 *    set to the selected node + its direct neighbours; the slider /
 *    pan / zoom keep working on top.
 *
 * Performance:
 *  - The visible subgraph is bounded by the slider (default 60
 *    nodes, top-K by degree). At ≤250 nodes the O(n²) repulsion is
 *    fine (~31 k ops/frame).
 *  - The sim auto-pauses once total kinetic energy is below
 *    SETTLED_THRESHOLD. Any pointer interaction re-energises it.
 */
export function GraphView({
  api,
  spaceId,
  onOpen,
}: {
  api: ApiClient;
  spaceId: string | null;
  onOpen: (id: string) => void;
}) {
  const { notes } = useApp();
  const { prefs } = useSettings();

  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [budget, setBudget] = useState(DEFAULT_NODE_BUDGET);
  const [appliedBudget, setAppliedBudget] = useState(DEFAULT_NODE_BUDGET);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<GraphViewMode>('all');
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });

  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<NodeState[]>([]);
  const paletteRef = useRef({
    ink: '#e5e5e5',
    bg: '#1a1a1a',
    brand: '#008671',
    edge: 'rgba(0,134,113,0.45)',
    selected: '#facc15',
    focused: '#34d399',
  });
  const dragRef = useRef<{ id: string | null; moved: boolean; sx: number; sy: number }>({
    id: null,
    moved: false,
    sx: 0,
    sy: 0,
  });
  const panRef = useRef<{ active: boolean; sx: number; sy: number; vx0: number; vy0: number } | null>(
    null,
  );
  const rafRef = useRef<number | null>(null);
  const alphaRef = useRef(1);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    if (!spaceId) return;
    let cancelled = false;
    api
      .graph(spaceId)
      .then((g) => {
        if (!cancelled) setGraph(g);
      })
      // Swallow the rejection (and ignore stale responses): a workspace switch
      // mid-flight must not paint another space's graph, and a failed fetch
      // shouldn't surface as an unhandled rejection.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, spaceId]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      setSize((s) => (s.w === w && s.h === h && s.dpr === dpr ? s : { w, h, dpr }));
    };
    measure();
    window.addEventListener('resize', measure);
    if (typeof ResizeObserver === 'undefined') {
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const cs = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) =>
      cs.getPropertyValue(name).trim() || fallback;
    const light = prefs.theme === 'light';
    const brand = read('--c-brand', '#008671');
    paletteRef.current = {
      ink: read('--c-ink', light ? '#1f2937' : '#e5e5e5'),
      bg: read('--c-bg', light ? '#ffffff' : '#1a1a1a'),
      brand,
      edge: withAlpha(brand, light ? 0.6 : 0.45),
      selected: light ? '#b45309' : '#facc15',
      focused: light ? '#047857' : '#34d399',
    };
    alphaRef.current = Math.max(alphaRef.current, ALPHA_MIN * 2);
  }, [prefs.theme, prefs.accent]);

  useEffect(() => {
    if (budget === appliedBudget) return;
    const t = setTimeout(() => setAppliedBudget(budget), BUDGET_APPLY_DELAY_MS);
    return () => clearTimeout(t);
  }, [budget, appliedBudget]);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of graph.edges) {
      d.set(e.source, (d.get(e.source) ?? 0) + 1);
      d.set(e.target, (d.get(e.target) ?? 0) + 1);
    }
    return d;
  }, [graph]);

  const visible = useMemo(() => {
    if (graph.nodes.length === 0)
      return { nodes: [] as Graph['nodes'], edges: [] as Graph['edges'] };

    // `focusId` (set when the user clicks "focus on this note" in the inspector)
    // pins us to an ego-network view regardless of the viewMode dropdown.
    const effectiveMode: GraphViewMode = focusId ? 'ego' : viewMode;

    let ids: Set<string>;
    switch (effectiveMode) {
      case 'ego': {
        const center = focusId ?? selectedId;
        if (!center) {
          // No node to centre on yet — fall back to top-K so the canvas
          // isn't empty when the user lands here.
          const ranked = [...graph.nodes].sort(
            (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0),
          );
          ids = new Set(ranked.slice(0, Math.min(20, appliedBudget)).map((n) => n.id));
        } else {
          ids = new Set<string>([center]);
          for (const e of graph.edges) {
            if (e.source === center) ids.add(e.target);
            else if (e.target === center) ids.add(e.source);
          }
        }
        break;
      }
      case 'hubs': {
        const ranked = [...graph.nodes]
          .filter((n) => (degree.get(n.id) ?? 0) >= 2)
          .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
        ids = new Set(ranked.slice(0, appliedBudget).map((n) => n.id));
        break;
      }
      case 'orphans': {
        // No edges at all — useful for "what needs to be linked / archived".
        ids = new Set(graph.nodes.filter((n) => (degree.get(n.id) ?? 0) === 0).map((n) => n.id));
        // Cap to budget so a workspace with thousands of orphans doesn't
        // implode the canvas.
        if (ids.size > appliedBudget) {
          ids = new Set([...ids].slice(0, appliedBudget));
        }
        break;
      }
      case 'cluster':
      case 'all':
      default: {
        const ranked = [...graph.nodes].sort(
          (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0),
        );
        ids = new Set(ranked.slice(0, appliedBudget).map((n) => n.id));
      }
    }
    const nodes = graph.nodes.filter((n) => ids.has(n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    return { nodes, edges };
  }, [graph, degree, focusId, selectedId, viewMode, appliedBudget]);

  const budgetControl = useMemo(() => {
    const total = graph.nodes.length;
    return {
      max: Math.min(MAX_NODE_BUDGET, Math.max(MIN_NODE_BUDGET, total)),
      enabled: !focusId && viewMode !== 'orphans' && viewMode !== 'ego' && total > MIN_NODE_BUDGET,
    };
  }, [graph.nodes.length, focusId, viewMode]);

  useEffect(() => {
    const W = sizeRef.current.w || 800;
    const H = sizeRef.current.h || 600;
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    nodesRef.current = visible.nodes.map((n, i) => {
      const old = prev.get(n.id);
      if (old) return { ...old, title: n.title };
      const a = (2 * Math.PI * i) / Math.max(visible.nodes.length, 1);
      return {
        id: n.id,
        title: n.title,
        x: W / 2 + Math.cos(a) * 160,
        y: H / 2 + Math.sin(a) * 160,
        vx: 0,
        vy: 0,
      };
    });
    // Reheat the simulation so the new layout has time to settle.
    alphaRef.current = 1;
  }, [visible]);

  // Drop the selection only if the selected note no longer exists in the
  // full graph (it was deleted somewhere else). Selecting a neighbour that
  // happens to live outside the current top-K is fine — we'd rather show
  // the inspector with a hint than slam it shut as soon as the user picks
  // a "Connected to" entry that didn't make the visible cut.
  useEffect(() => {
    if (selectedId && !graph.nodes.some((n) => n.id === selectedId)) {
      setSelectedId(null);
    }
  }, [graph, selectedId]);

  const selectedNodeInVisible = useMemo(
    () => !!selectedId && visible.nodes.some((n) => n.id === selectedId),
    [selectedId, visible],
  );

  // Simulation + render. Uses the view transform so pan/zoom are
  // independent from the physics — nodes live in their own "world"
  // coordinates regardless of where the camera is.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    const c = ctx;
    const cv = canvas;

    function render(nodes: NodeState[], byId: Map<string, NodeState>) {
      const v = viewRef.current;
      const { dpr } = sizeRef.current;
      const k = v.zoom * dpr;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
      c.setTransform(k, 0, 0, k, v.x * dpr, v.y * dpr);

      // Style sizes are picked at "natural" zoom = 1; the camera transform
      // scales them uniformly with the nodes — zoom in and the labels grow
      // alongside the dots, like in Excalidraw / Figma / Miro. We do NOT
      // divide by `v.zoom`: that would keep labels at a fixed screen size,
      // which is the opposite of what the user expects when they zoom in
      // to read.
      const palette = paletteRef.current;
      c.strokeStyle = palette.edge;
      c.lineWidth = 1.5;
      for (const e of visible.edges) {
        const s = byId.get(e.source);
        const t = byId.get(e.target);
        if (!s || !t) continue;
        c.beginPath();
        c.moveTo(s.x, s.y);
        c.lineTo(t.x, t.y);
        c.stroke();
      }
      c.font = '13px system-ui, sans-serif';
      c.textBaseline = 'middle';
      const folderByNoteId = new Map(graph.nodes.map((g) => [g.id, g.folderId]));
      for (const n of nodes) {
        const focused = focusId === n.id;
        const selected = selectedId === n.id;
        c.beginPath();
        c.arc(n.x, n.y, focused ? 12 : selected ? 11 : 9, 0, Math.PI * 2);
        // Colour: focused/selected always pop with the same hues; otherwise
        // the cluster mode paints per-folder, every other mode keeps the
        // brand colour so users don't see colours change on filter switch.
        const baseColor =
          viewMode === 'cluster' ? clusterColor(folderByNoteId.get(n.id)) : palette.brand;
        c.fillStyle = focused ? palette.focused : selected ? palette.selected : baseColor;
        c.fill();
        if (selected) {
          c.strokeStyle = palette.selected;
          c.lineWidth = 2;
          c.stroke();
        }
        // Halo in the page background so labels stay readable over edges.
        c.lineWidth = 3;
        c.lineJoin = 'round';
        c.strokeStyle = palette.bg;
        c.strokeText(n.title, n.x + 16, n.y);
        c.fillStyle = palette.ink;
        c.fillText(n.title, n.x + 16, n.y);
      }
      c.restore();
    }

    function step() {
      const nodes = nodesRef.current;
      const W = sizeRef.current.w || 800;
      const H = sizeRef.current.h || 600;
      const N = nodes.length;
      const dragging = dragRef.current.id;
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const alpha = alphaRef.current;

      // Once the cooldown reaches its floor and nothing is being interacted
      // with, freeze: skip the integration but keep the RAF loop alive so
      // the next interaction can re-heat instantly.
      if (alpha < ALPHA_MIN && !dragging && !panRef.current?.active) {
        rafRef.current = requestAnimationFrame(step);
        return;
      }

      // All forces are scaled by alpha — that's the D3-force trick to
      // guarantee convergence regardless of how connected the subgraph is.
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy || 1;
          const d = Math.sqrt(d2);
          const f = (2200 / d2) * alpha;
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

      for (const e of visible.edges) {
        const s = byId.get(e.source);
        const t = byId.get(e.target);
        if (!s || !t) continue;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 120) * 0.025 * alpha;
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

      for (const n of nodes) {
        if (dragging === n.id) {
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx += (W / 2 - n.x) * 0.0018 * alpha;
        n.vy += (H / 2 - n.y) * 0.0018 * alpha;
        n.vx *= 0.82;
        n.vy *= 0.82;
        n.x += n.vx;
        n.y += n.vy;
      }
      // Cooldown — converges in ~150 frames at 60 fps (≈ 2.5 s).
      alphaRef.current = alpha * ALPHA_DECAY;

      render(nodes, byId);
      rafRef.current = requestAnimationFrame(step);
    }

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [visible, focusId, selectedId, viewMode, graph.nodes]);

  // Force a re-paint when the camera moves (the sim might be paused, we
  // still want the canvas to reflect the new transform). A tiny alpha
  // pulse is enough; it decays back to rest immediately.
  useEffect(() => {
    alphaRef.current = Math.max(alphaRef.current, ALPHA_MIN * 2);
  }, [view, size]);

  function screenOf(e: { clientX: number; clientY: number }) {
    const r = canvasRef.current!.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  }

  /** Screen pixel → world coords (apply the inverse of the camera). */
  function worldOf(e: React.MouseEvent<HTMLCanvasElement>) {
    const { px, py } = screenOf(e);
    const v = viewRef.current;
    return { x: (px - v.x) / v.zoom, y: (py - v.y) / v.zoom, px, py };
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    // Holding shift makes the browser report the wheel on deltaX instead.
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    if (delta === 0) return;

    if (e.shiftKey) {
      if (!budgetControl.enabled) return;
      const step = Math.max(1, Math.round((budgetControl.max - MIN_NODE_BUDGET) * 0.1));
      const dir = delta < 0 ? 1 : -1;
      setBudget((b) =>
        Math.max(MIN_NODE_BUDGET, Math.min(budgetControl.max, b + dir * step)),
      );
      return;
    }

    const { px, py } = screenOf(e);
    const v = viewRef.current;
    const factor = delta < 0 ? 1.12 : 1 / 1.12;
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.zoom * factor));
    // Anchor zoom on the cursor's world point.
    const wx = (px - v.x) / v.zoom;
    const wy = (py - v.y) / v.zoom;
    setView({ x: px - wx * newZoom, y: py - wy * newZoom, zoom: newZoom });
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const { x, y } = worldOf(e);
    const hit = nodesRef.current.find((n) => (x - n.x) ** 2 + (y - n.y) ** 2 < 14 * 14);
    if (hit) {
      dragRef.current = { id: hit.id, moved: false, sx: x, sy: y };
      alphaRef.current = Math.max(alphaRef.current, ALPHA_REHEAT_ON_DRAG);
    } else {
      const v = viewRef.current;
      const { px, py } = screenOf(e);
      panRef.current = { active: true, sx: px, sy: py, vx0: v.x, vy0: v.y };
    }
  }
  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (panRef.current?.active) {
      const { px, py } = screenOf(e);
      setView((v) => ({
        ...v,
        x: panRef.current!.vx0 + (px - panRef.current!.sx),
        y: panRef.current!.vy0 + (py - panRef.current!.sy),
      }));
      return;
    }
    const d = dragRef.current;
    if (!d.id) return;
    const { x, y } = worldOf(e);
    const node = nodesRef.current.find((n) => n.id === d.id);
    if (!node) return;
    node.x = x;
    node.y = y;
    if (Math.abs(x - d.sx) + Math.abs(y - d.sy) > 4 / viewRef.current.zoom) d.moved = true;
  }
  function onMouseUp() {
    if (panRef.current?.active) {
      panRef.current = null;
      return;
    }
    const d = dragRef.current;
    if (d.id && !d.moved) setSelectedId(d.id);
    else if (!d.id && !d.moved) setSelectedId(null);
    dragRef.current = { id: null, moved: false, sx: 0, sy: 0 };
  }

  /**
   * Cursor leaving the canvas — usually because the user is heading for
   * the inspector. Cancel any in-flight drag / pan so the next mousedown
   * starts clean, but DO NOT touch the selection: that would slam the
   * inspector shut every time the user tries to interact with it.
   */
  function onMouseLeave() {
    panRef.current = null;
    dragRef.current = { id: null, moved: false, sx: 0, sy: 0 };
  }
  function onDoubleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const { x, y } = worldOf(e);
    const hit = nodesRef.current.find((n) => (x - n.x) ** 2 + (y - n.y) ** 2 < 14 * 14);
    if (hit) onOpen(hit.id);
  }

  const resetView = useCallback(() => {
    const nodes = nodesRef.current;
    const { w: W, h: H } = sizeRef.current;
    if (nodes.length === 0 || W === 0 || H === 0) {
      setView({ x: 0, y: 0, zoom: 1 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      // Labels hang off the right of each dot; reserve room so they don't clip.
      maxX = Math.max(maxX, n.x + 140);
      maxY = Math.max(maxY, n.y);
    }
    const pad = 48;
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const zoom = Math.max(
      ZOOM_MIN,
      Math.min(ZOOM_MAX, 1, (W - pad * 2) / bw, (H - pad * 2) / bh),
    );
    setView({
      x: W / 2 - ((minX + maxX) / 2) * zoom,
      y: H / 2 - ((minY + maxY) / 2) * zoom,
      zoom,
    });
  }, []);

  const selectedNode = useMemo(
    () => (selectedId ? graph.nodes.find((n) => n.id === selectedId) ?? null : null),
    [selectedId, graph],
  );

  const selectedTags = useMemo(() => {
    if (!selectedNode) return [];
    const full = notes.find((n) => n.id === selectedNode.id);
    return full ? extractTags(full.contentMd) : [];
  }, [selectedNode, notes]);

  const selectedNeighbors = useMemo(() => {
    if (!selectedNode) return [] as Graph['nodes'];
    const ids = new Set<string>();
    for (const e of graph.edges) {
      if (e.source === selectedNode.id) ids.add(e.target);
      else if (e.target === selectedNode.id) ids.add(e.source);
    }
    return graph.nodes.filter((n) => ids.has(n.id));
  }, [selectedNode, graph]);

  const visibleCount = visible.nodes.length;
  const totalCount = graph.nodes.length;

  return (
    <div className="h-full flex flex-col" data-testid="graph">
      <header className="px-4 py-2 border-b border-line flex items-center justify-between gap-3 bg-bg-surface text-xs shrink-0">
        <div className="flex items-center gap-2 text-ink min-w-0">
          <span className="font-medium shrink-0">🕸 Knowledge graph</span>
          {focusId ? (
            <>
              <span className="text-ink-muted">·</span>
              <button
                onClick={() => setFocusId(null)}
                className="px-2 py-0.5 rounded border border-line bg-bg hover:border-brand/40 text-ink-muted hover:text-ink shrink-0"
              >
                ← Overview
              </button>
              <span className="text-ink-muted truncate">
                focused on «{graph.nodes.find((n) => n.id === focusId)?.title}»
              </span>
            </>
          ) : (
            <>
              <span className="text-ink-muted">·</span>
              <span className="text-ink-muted truncate">
                {visibleCount} of {totalCount} nodes · scroll to zoom
                {budgetControl.enabled ? ' · shift+scroll for more nodes' : ''} · drag empty space
                to pan
              </span>
            </>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <div ref={wrapRef} className="relative flex-1 min-w-0">
          <canvas
            ref={canvasRef}
            width={Math.max(1, Math.round(size.w * size.dpr))}
            height={Math.max(1, Math.round(size.h * size.dpr))}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseLeave}
            onDoubleClick={onDoubleClick}
            onWheel={onWheel}
            className="absolute inset-0 w-full h-full bg-bg cursor-grab active:cursor-grabbing"
          />
          {graph.nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-ink-muted text-sm pointer-events-none px-8 text-center">
              No notes yet. Create some and link them with{' '}
              <code className="mx-1 px-1.5 py-0.5 bg-bg rounded border border-line">[[Title]]</code>{' '}
              to see the graph.
            </div>
          )}
        </div>

        {/* The controls live in their own column now. They were a strip along
            the top of the canvas, where a dropdown and a slider competed with
            the breadcrumb for the same line and the graph lost height to
            chrome on every screen. A panel also lets the view modes be a list
            with their hints visible, instead of a select nobody opens. */}
        <aside
          data-testid="graph-controls"
          className="w-56 shrink-0 h-full border-l border-line bg-bg-surface flex flex-col text-sm overflow-y-auto"
        >
          <div className="px-3 py-2 border-b border-line shrink-0 text-[10px] uppercase tracking-wider text-ink-muted">
            View
          </div>

          <div className="p-2 flex flex-col gap-0.5 border-b border-line">
            {VIEW_MODES.map((m) => {
              const on = focusId ? m.id === 'ego' : m.id === viewMode;
              return (
                <button
                  key={m.id}
                  onClick={() => setViewMode(m.id)}
                  // Focus is its own mode: while a node is focused the graph
                  // IS the ego view, and offering to leave it from here would
                  // duplicate the ← Overview button that already does it.
                  disabled={!!focusId}
                  title={m.hint}
                  className={`text-left px-2 py-1 rounded text-xs disabled:opacity-50 ${
                    on ? 'bg-brand text-white' : 'text-ink hover:bg-bg'
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          {budgetControl.enabled && (
            <label className="p-3 border-b border-line flex flex-col gap-1.5 text-ink-muted">
              <span className="text-[11px]">
                Nodes shown{' '}
                <span className="tabular-nums text-ink">
                  {budget} <span className="opacity-70">/ {totalCount}</span>
                </span>
              </span>
              <input
                type="range"
                min={MIN_NODE_BUDGET}
                max={budgetControl.max}
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
                aria-label="nodes shown"
                className="w-full accent-[color:var(--brand)]"
              />
              <span className="text-[10px] leading-snug">
                The most-connected notes first. Shift+scroll on the canvas does
                the same.
              </span>
            </label>
          )}

          <div className="p-3 flex items-center gap-2 border-b border-line">
            <button
              onClick={resetView}
              title="Fit the graph into the panel"
              className="px-2 py-1 rounded border border-line bg-bg hover:border-brand/40 text-ink-muted hover:text-ink text-xs"
            >
              Fit view
            </button>
            <span className="text-ink-muted text-[11px] tabular-nums">
              {Math.round(view.zoom * 100)}%
            </span>
          </div>

          {selectedNode && (
            <div data-testid="graph-inspector" className="flex flex-col min-h-0">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-line shrink-0">
              <Sparkles size={12} className="text-brand shrink-0" />
              <span className="text-[10px] uppercase tracking-wider text-ink-muted flex-1">
                Selected
              </span>
              <button
                onClick={() => setSelectedId(null)}
                aria-label="close inspector"
                className="p-0.5 rounded hover:bg-bg text-ink-muted hover:text-ink"
              >
                <X size={12} />
              </button>
            </div>

            <div className="px-3 py-2 border-b border-line shrink-0">
              <h3 className="font-medium text-ink truncate" title={selectedNode.title}>
                {selectedNode.title}
              </h3>
              <p className="text-[11px] text-ink-muted mt-0.5">
                {selectedNeighbors.length} direct connection
                {selectedNeighbors.length === 1 ? '' : 's'}
              </p>
              {!selectedNodeInVisible && (
                <p className="text-[11px] text-amber-700 dark:text-yellow-300/90 mt-2 px-2 py-1 rounded bg-yellow-500/10 border border-yellow-500/30">
                  Not on the current canvas. Widen the slider above or hit{' '}
                  <em>Focus on neighbourhood</em> below to bring it in.
                </p>
              )}
              {selectedTags.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap mt-2">
                  {selectedTags.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded border border-line bg-bg text-ink-muted"
                    >
                      <Hash size={9} />
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="px-3 py-2 flex flex-col gap-1 border-b border-line shrink-0">
              <button
                onClick={() => onOpen(selectedNode.id)}
                className="w-full flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded bg-brand text-white hover:bg-brand/80"
              >
                <ExternalLink size={12} /> Open note
              </button>
              {focusId === selectedNode.id ? (
                <button
                  onClick={() => setFocusId(null)}
                  className="w-full text-xs px-2 py-1.5 rounded border border-line bg-bg text-ink-muted hover:text-ink hover:border-brand/40"
                >
                  Exit focus
                </button>
              ) : (
                <button
                  onClick={() => setFocusId(selectedNode.id)}
                  className="w-full text-xs px-2 py-1.5 rounded border border-line bg-bg text-ink-muted hover:text-ink hover:border-brand/40"
                >
                  Focus on neighbourhood
                </button>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-ink-muted">
                Connected to
              </div>
              {selectedNeighbors.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-ink-muted leading-relaxed">
                  No connections — this note is an orphan. Mention another note with{' '}
                  <code className="px-1 py-0.5 bg-bg rounded">[[Title]]</code> or get someone to
                  mention this one.
                </p>
              ) : (
                <ul className="flex flex-col">
                  {selectedNeighbors.map((n) => (
                    <li key={n.id}>
                      <button
                        onClick={() => setSelectedId(n.id)}
                        onDoubleClick={() => onOpen(n.id)}
                        title="Click to select · double-click to open"
                        className="w-full text-left text-xs px-3 py-1 hover:bg-bg text-ink"
                      >
                        {n.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          )}
        </aside>
      </div>
    </div>
  );
}
