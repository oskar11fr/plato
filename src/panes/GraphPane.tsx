// The wiki as a graph: pages as nodes, links as edges, laid out by a force
// simulation and drawn on a canvas. Hover a page to see what it links with,
// click to open it, drag to move it; scroll to zoom, drag the background to pan.
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { filesChanged } from "../lib/bus";
import { buildGraph, NODE_KINDS, type GraphNode, type NodeKind, type WikiGraph } from "../lib/graph";
import { listWikiPages } from "../lib/wiki";
import { currentFileIndex } from "../lib/wikilinks";
import { openFile } from "./open";

type SimNode = GraphNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode> & { source: SimNode | string; target: SimNode | string };

const radius = (n: GraphNode) => 4 + Math.sqrt(n.degree) * 1.8;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 6;
const SHOW_MISSING_KEY = "plato.graph.showMissing";

function readPref(): boolean {
  try {
    return localStorage.getItem(SHOW_MISSING_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Colors from the theme's CSS tokens, read at draw time so a theme switch shows at once. */
function themeColors(el: Element) {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    paper: v("--paper"),
    ink: v("--ink"),
    ink2: v("--ink-2"),
    muted: v("--muted"),
    rule: v("--rule-strong"),
    kinds: {
      source: v("--graph-source"),
      book: v("--graph-book"),
      concept: v("--graph-concept"),
      other: v("--graph-other"),
      missing: v("--muted"),
    } as Record<NodeKind, string>,
    font: v("--font-ui"),
  };
}

export function GraphPane({ containerApi }: IDockviewPanelProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [graph, setGraph] = useState<WikiGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMissing, setShowMissing] = useState(readPref);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<{ node: SimNode; x: number; y: number } | null>(null);

  // Drawing state lives in refs: the simulation redraws on every tick without re-rendering React.
  const sim = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodes = useRef<SimNode[]>([]);
  const links = useRef<SimLink[]>([]);
  const neighbors = useRef(new Map<string, Set<string>>());
  const view = useRef({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 0, h: 0 });
  const hoverId = useRef<string | null>(null);
  const queryRef = useRef("");
  const fitted = useRef(false);
  const drag = useRef<{ node: SimNode | null; x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const pages = await listWikiPages();
      setGraph(buildGraph(pages, currentFileIndex(), { missing: showMissing }));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [showMissing]);

  useEffect(() => {
    void load();
    return filesChanged.subscribe(() => void load());
  }, [load]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { w, h } = size.current;
    const dpr = window.devicePixelRatio || 1;
    const c = themeColors(canvas);
    const { x: vx, y: vy, k } = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.paper;
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * vx, dpr * vy);

    const focus = hoverId.current;
    const near = focus ? (neighbors.current.get(focus) ?? new Set<string>()) : null;
    const q = queryRef.current.trim().toLowerCase();
    const matches = (n: GraphNode) => !q || n.title.toLowerCase().includes(q);
    const lit = (n: GraphNode) => (focus ? n.id === focus || near!.has(n.id) : matches(n));

    // Edges: thin and recessive; the hovered page's edges in ink.
    ctx.lineWidth = 1 / k;
    for (const l of links.current) {
      const s = l.source as SimNode;
      const t = l.target as SimNode;
      if (s.x === undefined || t.x === undefined) continue;
      const hot = focus !== null && (s.id === focus || t.id === focus);
      ctx.strokeStyle = hot ? c.ink2 : c.rule;
      ctx.globalAlpha = hot ? 0.9 : focus || q ? 0.15 : 0.7;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y!);
      ctx.lineTo(t.x, t.y!);
      ctx.stroke();
    }

    // Nodes, with a ring in the background color so overlapping ones stay apart.
    for (const n of nodes.current) {
      if (n.x === undefined) continue;
      const r = radius(n);
      ctx.globalAlpha = lit(n) ? 1 : 0.2;
      ctx.beginPath();
      ctx.arc(n.x, n.y!, r, 0, Math.PI * 2);
      if (n.kind === "missing") {
        ctx.fillStyle = c.paper;
        ctx.fill();
        ctx.strokeStyle = c.kinds.missing;
        ctx.lineWidth = 1.5 / k;
        ctx.stroke();
      } else {
        ctx.fillStyle = c.kinds[n.kind];
        ctx.fill();
        ctx.strokeStyle = c.paper;
        ctx.lineWidth = 2 / k;
        ctx.stroke();
      }
      if (n.id === focus) {
        ctx.beginPath();
        ctx.arc(n.x, n.y!, r + 3 / k, 0, Math.PI * 2);
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 1.5 / k;
        ctx.stroke();
      }
    }

    // Labels: the hovered page and its neighbors, search matches, the best-linked pages, and everything once zoomed in.
    const zoomAlpha = Math.max(0, Math.min(1, (k - 0.9) / 0.6));
    const hub = Math.max(4, nodes.current.reduce((m, n) => Math.max(m, n.degree), 0) * 0.5);
    ctx.font = `${11 / k}px ${c.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    // Most important first (the hovered page, then the best-linked); a label that would overlap one already drawn is skipped.
    const candidates: { n: SimNode; alpha: number }[] = [];
    for (const n of nodes.current) {
      if (n.x === undefined) continue;
      let alpha = Math.max(zoomAlpha, n.degree >= hub ? 0.9 : 0);
      if (focus) alpha = lit(n) ? 1 : alpha * 0.15;
      else if (q) alpha = matches(n) ? 1 : alpha * 0.15;
      if (alpha >= 0.05) candidates.push({ n, alpha });
    }
    candidates.sort((a, b) => Number(b.n.id === focus) - Number(a.n.id === focus) || b.alpha - a.alpha || b.n.degree - a.n.degree);
    const placed: [number, number, number, number][] = [];
    const lineHeight = 13 / k;
    for (const { n, alpha } of candidates) {
      const label = n.title.length > 42 ? `${n.title.slice(0, 41)}…` : n.title;
      const width = ctx.measureText(label).width;
      const y = n.y! + radius(n) + 3 / k;
      const box: [number, number, number, number] = [n.x! - width / 2, y, n.x! + width / 2, y + lineHeight];
      if (n.id !== focus && placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      placed.push(box);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = c.paper;
      ctx.lineWidth = 3 / k;
      ctx.strokeText(label, n.x!, y);
      ctx.fillStyle = n.id === focus ? c.ink : c.ink2;
      ctx.fillText(label, n.x!, y);
    }
    ctx.globalAlpha = 1;
  }, []);

  /** Zoom and pan so every node is in view. */
  const fit = useCallback(() => {
    const ns = nodes.current.filter((n) => n.x !== undefined);
    const { w, h } = size.current;
    if (!ns.length || !w || !h) return;
    const xs = ns.map((n) => n.x!);
    const ys = ns.map((n) => n.y!);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = 60;
    const k = Math.max(MIN_ZOOM, Math.min(2, (w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0)));
    view.current = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
    draw();
  }, [draw]);

  // A new graph: keep the positions of pages already shown, lay out the rest.
  useEffect(() => {
    if (!graph) return;
    const old = new Map(nodes.current.map((n) => [n.id, n]));
    const next: SimNode[] = graph.nodes.map((n) => {
      const prev = old.get(n.id);
      return prev ? { ...n, x: prev.x, y: prev.y, vx: 0, vy: 0 } : { ...n };
    });
    const byId = new Map(next.map((n) => [n.id, n]));
    const nbrs = new Map<string, Set<string>>();
    for (const l of graph.links) {
      nbrs.set(l.source, (nbrs.get(l.source) ?? new Set()).add(l.target));
      nbrs.set(l.target, (nbrs.get(l.target) ?? new Set()).add(l.source));
    }
    // New pages start next to a page they link with, if it's already placed.
    for (const n of next) {
      if (n.x !== undefined) continue;
      const anchor = [...(nbrs.get(n.id) ?? [])].map((id) => byId.get(id)).find((m) => m?.x !== undefined);
      if (anchor) {
        n.x = anchor.x! + (Math.random() - 0.5) * 40;
        n.y = anchor.y! + (Math.random() - 0.5) * 40;
      }
    }
    nodes.current = next;
    links.current = graph.links.map((l) => ({ source: l.source, target: l.target }));
    neighbors.current = nbrs;

    sim.current?.stop();
    const s = forceSimulation<SimNode, SimLink>(next)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links.current)
          .id((d) => d.id)
          .distance(55)
          .strength(0.5),
      )
      .force("charge", forceManyBody<SimNode>().strength(-180).distanceMax(500))
      .force("collide", forceCollide<SimNode>((d) => radius(d) + 6))
      // Pages without links would drift off; hold them closer.
      .force("x", forceX<SimNode>(0).strength((d) => (d.degree === 0 ? 0.25 : 0.05)))
      .force("y", forceY<SimNode>(0).strength((d) => (d.degree === 0 ? 0.25 : 0.05)))
      .on("tick", draw);
    if (!fitted.current) {
      // First layout: settle it before showing it, then fit it to the pane.
      s.alpha(1).stop();
      s.tick(200);
      fit();
      fitted.current = true;
      s.alpha(0.05).restart();
    } else {
      s.alpha(old.size ? 0.4 : 1).restart();
    }
    sim.current = s;
    return () => void s.stop();
  }, [graph, draw, fit]);

  // Keep the canvas the size of the pane, sharp on high-density screens.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const { width, height } = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const first = size.current.w === 0;
      size.current = { w: width, h: height };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if (first) fit();
      else draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    resize();
    return () => observer.disconnect();
  }, [draw, fit]);

  // Redraw when the theme changes.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", draw);
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => {
      media.removeEventListener("change", draw);
      observer.disconnect();
    };
  }, [draw]);

  useEffect(() => {
    queryRef.current = query;
    draw();
  }, [query, draw]);

  function toWorld(clientX: number, clientY: number) {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const { x, y, k } = view.current;
    return { sx, sy, x: (sx - x) / k, y: (sy - y) / k };
  }

  function nodeAt(wx: number, wy: number): SimNode | null {
    const slop = 4 / view.current.k;
    let best: SimNode | null = null;
    let bestDist = Infinity;
    for (const n of nodes.current) {
      if (n.x === undefined) continue;
      const d = Math.hypot(n.x - wx, n.y! - wy);
      if (d <= radius(n) + slop && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }

  function setHovered(node: SimNode | null, sx = 0, sy = 0) {
    if (hoverId.current !== (node?.id ?? null)) {
      hoverId.current = node?.id ?? null;
      draw();
    }
    setHover(node ? { node, x: sx, y: sy } : null);
  }

  function open(node: GraphNode) {
    if (node.kind !== "missing") openFile(containerApi, node.path);
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return;
    const p = toWorld(e.clientX, e.clientY);
    const node = nodeAt(p.x, p.y);
    drag.current = { node, x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = toWorld(e.clientX, e.clientY);
    const d = drag.current;
    if (!d) {
      const node = nodeAt(p.x, p.y);
      setHovered(node, p.sx, p.sy);
      e.currentTarget.style.cursor = node ? "pointer" : "grab";
      return;
    }
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    d.moved = true;
    if (d.node) {
      d.node.fx = p.x;
      d.node.fy = p.y;
      sim.current?.alphaTarget(0.25).restart();
      setHovered(d.node, p.sx, p.sy);
    } else {
      view.current = { ...view.current, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y };
      e.currentTarget.style.cursor = "grabbing";
      setHovered(null);
      draw();
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.node) {
      d.node.fx = null;
      d.node.fy = null;
      sim.current?.alphaTarget(0);
      if (!d.moved) open(d.node);
    }
    e.currentTarget.style.cursor = "grab";
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    const { sx, sy } = toWorld(e.clientX, e.clientY);
    const { x, y, k } = view.current;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k * Math.exp(-e.deltaY * 0.0015)));
    view.current = { k: next, x: sx - (sx - x) * (next / k), y: sy - (sy - y) * (next / k) };
    setHovered(null);
    draw();
  }

  /** Center the view on the first page matching the search. */
  function findFirst() {
    const q = query.trim().toLowerCase();
    const n = q && nodes.current.find((m) => m.title.toLowerCase().includes(q) && m.x !== undefined);
    if (!n) return;
    const { w, h } = size.current;
    const k = Math.max(view.current.k, 1.2);
    view.current = { k, x: w / 2 - n.x! * k, y: h / 2 - n.y! * k };
    draw();
  }

  function toggleMissing(on: boolean) {
    setShowMissing(on);
    try {
      localStorage.setItem(SHOW_MISSING_KEY, on ? "1" : "0");
    } catch {
      // the preference just isn't remembered
    }
  }

  const counts = new Map<NodeKind, number>();
  for (const n of graph?.nodes ?? []) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  const pageCount = (graph?.nodes.length ?? 0) - (counts.get("missing") ?? 0);
  const hovered = hover?.node;
  const linkCount = hovered ? (neighbors.current.get(hovered.id)?.size ?? 0) : 0;

  return (
    <div className="graph-pane">
      <div className="graph-toolbar">
        <input
          type="search"
          placeholder="Find a page…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") findFirst();
            if (e.key === "Escape") setQuery("");
          }}
          aria-label="Find a page"
        />
        <label className="checkbox small">
          <input type="checkbox" checked={showMissing} onChange={(e) => toggleMissing(e.target.checked)} />
          Pages not written yet
        </label>
        <span className="spacer" />
        <span className="muted small">
          {pageCount} pages · {graph?.links.length ?? 0} links
        </span>
        <button onClick={fit} title="Show the whole graph">
          Fit
        </button>
      </div>
      <div className="graph-canvas" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => !drag.current && setHovered(null)}
          onWheel={onWheel}
          onDoubleClick={(e) => {
            const p = toWorld(e.clientX, e.clientY);
            if (!nodeAt(p.x, p.y)) fit();
          }}
          aria-label="Graph of the wiki's pages and the links between them"
          role="img"
        />
        {error && <div className="graph-message error">{error}</div>}
        {graph && graph.nodes.length === 0 && (
          <div className="graph-message muted">The wiki has no pages yet. Summarize a document to start it.</div>
        )}
        {hovered && hover && (
          <div className="graph-tooltip">
            <strong>{hovered.title}</strong>
            <span className="muted">
              {NODE_KINDS.find((k) => k.kind === hovered.kind)?.label} ·{" "}
              {hovered.kind === "missing"
                ? `linked from ${linkCount} page${linkCount === 1 ? "" : "s"}`
                : `${linkCount} linked page${linkCount === 1 ? "" : "s"} · click to open`}
            </span>
          </div>
        )}
        <ul className="graph-legend" aria-label="Legend">
          {NODE_KINDS.filter((k) => counts.get(k.kind)).map((k) => (
            <li key={k.kind}>
              <span className={`graph-swatch ${k.kind}`} />
              {k.label} <span className="muted">{counts.get(k.kind)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
