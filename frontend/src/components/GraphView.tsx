import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, Controls, MarkerType, MiniMap, Panel, ReactFlow, ViewportPortal, getViewportForBounds, useEdgesState, useReactFlow, useStore, useNodesState,
  type Connection, type Edge, type EdgeMouseHandler, type NodeMouseHandler, type OnNodesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Graph } from '../types';
import type { Theme } from '../theme';
import { autoLayout, cardHeight, cardWidth } from '../layout';
import { dropGroup, groupBoxes, groupChain, translateGroup, type Rect } from '../groupBoxes';
import { GroupNode, type GroupFlowNode } from './GroupNode';
import { snapGuides, GUIDE_THRESHOLD, type Guide } from '../snapGuides';
import { markerFor, routeEdges } from '../edgeRouting';
import { RoutedEdge } from './RoutedEdge';
import { cardHighlightClass, edgeHighlightClass, groupHighlightClass, normalizeHighlight, type HighlightIds } from '../highlight';
import type { Heat, OwnerLoad } from '../heatmap';
import { ModuleCard, type CardNode } from './ModuleCard';

interface Props {
  theme: Theme;
  graph: Graph;
  selected: { kind: 'module' | 'link'; id: number } | null;
  onNodeClick: (id: number) => void;
  onLinkClick: (id: number) => void;
  onPaneClick: () => void;
  onSelectionChange?: (ids: number[]) => void; // ids of the selected cards (shift-drag or ctrl-click for several)
  onConnect: (sourceId: number, targetId: number) => void;
  onMove: (id: number, x: number, y: number) => void | Promise<unknown>;
  onMoveMany: (positions: { id: number; x: number; y: number }[]) => Promise<boolean>;
  onAssignGroup: (id: number, groupId: number | null) => void;
  focusId?: number | null;
  highlightedModuleIds?: HighlightIds;
  tools?: React.ReactNode; // extra toolbar items for the page, shown beside Auto layout / Snap
  person?: Map<number, OwnerLoad> | null; // one person's map (wins over the heatmap)
  heat?: Map<number, Heat> | null; // per-module sprint load; modules missing from it are cold
}

// Initial zoom never drops below FIT.minZoom so text stays readable; a diagram wider than the viewport
// is anchored at its left edge (where the flow starts) and panned, rather than shrunk or cropped on both sides.
const FIT = { padding: 0.06, minZoom: 0.7, maxZoom: 1.1 };
const nodeTypes = { card: ModuleCard, groupBox: GroupNode };
const edgeTypes = { routed: RoutedEdge };
const GRID = 20;
const SNAP_KEY = 'pjplanner-snap';
const snapTo = (v: number) => Math.round(v / GRID) * GRID;
const readSnap = () => { try { return localStorage.getItem(SNAP_KEY) === '1'; } catch { return false; } };

function FitInitial({ skip }: { skip: boolean }) {
  const { getNodes, setViewport, getNodesBounds } = useReactFlow();
  // Only cards are measured by React Flow reliably; group boxes carry explicit sizes.
  const ready = useStore((st) => { const c = st.nodes.filter((n) => n.type === 'card'); return c.length > 0 && c.every((n) => n.measured?.width); });
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current || skip) return;
    // Group boxes are derived from measured cards and appear one render later, so let them settle first.
    const t = setTimeout(() => {
      const el = document.querySelector('.graph .react-flow');
      if (!el || done.current) return;
      done.current = true;
      const { width, height } = el.getBoundingClientRect();
      const b = getNodesBounds(getNodes());
      const raw = getViewportForBounds(b, width, height, 0.05, FIT.maxZoom, FIT.padding);
      if (raw.zoom >= FIT.minZoom) { setViewport(raw); return; }
      setViewport({ zoom: FIT.minZoom, x: 24 - b.x * FIT.minZoom, y: height / 2 - (b.y + b.height / 2) * FIT.minZoom });
    }, 120);
    return () => clearTimeout(t);
  }, [ready, skip, getNodes, setViewport, getNodesBounds]);
  return null;
}

// Centres the viewport on a module once, after nodes have been laid out and measured.
function FocusOnMount({ id }: { id: number | null }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (id == null) return;
    const t = setTimeout(() => fitView({ nodes: [{ id: String(id) }], maxZoom: 1, duration: 300, padding: 1.5 }), 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

const miniColor = (n: { type?: string; data: Record<string, unknown> }) => {
  const c = typeof n.data.color === 'string' ? n.data.color : null;
  if (n.type === 'groupBox') return c ? `${c}55` : '#8b949e55';
  return c ?? '#8b9bb4';
};

export function GraphView({ theme, graph, selected, onNodeClick, onLinkClick, onPaneClick, onSelectionChange, onConnect, onMove, onMoveMany, onAssignGroup, focusId = null, highlightedModuleIds = null, heat = null, person = null, tools = null }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const auto = useMemo(() => autoLayout(graph), [graph]);
  const [snap, setSnap] = useState(readSnap);
  const [guides, setGuides] = useState<Guide[]>([]);
  const zoom = useRef(1);
  const toggleSnap = () => setSnap((v) => {
    try { localStorage.setItem(SNAP_KEY, v ? '0' : '1'); } catch { /* storage unavailable */ }
    return !v;
  });
  const autoRef = useRef(auto);
  autoRef.current = auto;

  // Merge server data into local nodes while keeping current on-screen positions, so a refresh
  // after any mutation never moves cards or the viewport.
  useEffect(() => {
    const ownerName = new Map(graph.owners.map((o) => [o.id, o.icon ? `${o.icon} ${o.name}` : o.name]));
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return graph.modules.map((m) => {
        const id = String(m.id);
        const position = old.get(id)?.position
          ?? (m.x != null && m.y != null ? { x: m.x, y: m.y } : auto.get(m.id)!);
        return {
          id, type: 'card' as const, position,
          selected: old.get(id)?.selected ?? false,
          data: {
            name: m.name, color: m.color, icon: m.icon, textColor: m.textColor, strokeColor: m.strokeColor, strokeStyle: m.strokeStyle, apiItems: m.apiItems.map(({ kind, name, signature }) => ({ kind, name, signature })),
            owners: m.ownerIds.map((o) => ownerName.get(o)).filter((n): n is string => !!n),
            person: person?.get(m.id) ?? null,
            heat: !person && heat ? (heat.get(m.id) ?? { open: 0, done: 0, level: 0 }) : null,
          },
        };
      });
    });
  }, [graph, auto, heat, person, setNodes]);

  const cardRects = useMemo(() => {
    const mod = new Map(graph.modules.map((m) => [String(m.id), m]));
    return nodes.flatMap((n) => {
      const m = mod.get(n.id);
      if (!m) return [];
      return [{ id: m.id, x: n.position.x, y: n.position.y, w: n.measured?.width ?? cardWidth(m.name, m.icon), h: n.measured?.height ?? cardHeight(m.apiItems.length) }];
    });
  }, [nodes, graph]);
  const rectMap = useMemo(() => new Map<number, Rect>(cardRects.map((r) => [r.id, r])), [cardRects]);

  // Routes depend on card positions, so edges are rebuilt whenever a card moves (live follow while dragging).
  const routes = useMemo(() => routeEdges(cardRects.map((r) => ({ ...r, id: String(r.id) })), graph.relations), [cardRects, graph]);

  // Group containers follow their members; they are rendered as extra non-interactive nodes behind the cards.
  const groupNodes = useMemo<GroupFlowNode[]>(() => {
    const boxes = groupBoxes(graph.modules, graph.groups ?? [], rectMap);
    return (graph.groups ?? []).flatMap((g) => {
      const b = boxes.get(g.id);
      if (!b) return [];
      return [{
        id: `group-${g.id}`, type: 'groupBox' as const, position: { x: b.x, y: b.y }, width: b.w, height: b.h,
        zIndex: groupChain(graph.groups ?? [], g.id).length - 10, dragHandle: '.group-grab',
        draggable: true, selectable: false, focusable: false, connectable: false,
        data: { name: g.name, color: g.color, icon: g.icon },
      }];
    });
  }, [graph, rectMap]);
  const hl = useMemo(() => normalizeHighlight(highlightedModuleIds), [highlightedModuleIds]);
  const allNodes = useMemo(() => [
    ...groupNodes.map((n) => (hl ? { ...n, className: groupHighlightClass(hl) } : n)),
    ...nodes.map((n) => (hl ? { ...n, className: cardHighlightClass(hl, Number(n.id)) } : n)),
  ], [groupNodes, nodes, hl]);

  useEffect(() => {
    setEdges(graph.relations.map((r) => {
      const isSel = selected?.kind === 'link' && selected.id === r.id;
      return {
        id: `r${r.id}`, source: String(r.sourceId), target: String(r.targetId),
        type: 'routed', interactionWidth: 24, selected: isSel, className: edgeHighlightClass(hl, r.sourceId, r.targetId),
        data: { route: routes.get(r.id), label: r.label ?? undefined, color: r.color, onLabelClick: () => onLinkClick(r.id) },
        markerEnd: markerFor(r.color, isSel),
      };
    }));
  }, [graph, selected, routes, onLinkClick, setEdges, hl]);

  // Keep React Flow's own selection in step with the app's selection.
  const syncSelection = useCallback(() => {
    const id = selected?.kind === 'module' ? String(selected.id) : null;
    setNodes((ns) => ns.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })));
  }, [selected, setNodes]);
  useEffect(syncSelection, [syncSelection]);

  const nodeClick: NodeMouseHandler = useCallback((_, n) => {
    if (n.type === 'card') onNodeClick(Number(n.id));
  }, [onNodeClick]);
  const edgeClick: EdgeMouseHandler = useCallback((_, e) => onLinkClick(Number(e.id.slice(1))), [onLinkClick]);
  const connect = useCallback((c: Connection) => {
    if (c.source && c.target && c.source !== c.target) onConnect(Number(c.source), Number(c.target));
  }, [onConnect]);

  // Card positions at the start of a group drag; a failed save restores them.
  const dragStart = useRef<{ origin: { x: number; y: number }; cards: Map<number, { x: number; y: number }> } | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const cardPositions = () => new Map(nodesRef.current.map((n) => [Number(n.id), { ...n.position }]));
  const applyPositions = (pos: Map<number, { x: number; y: number }>) =>
    setNodes((ns) => ns.map((n) => { const p = pos.get(Number(n.id)); return p ? { ...n, position: p } : n; }));
  const groupId = (n: { id: string }) => Number(n.id.slice('group-'.length));

  const saveAll = async (next: Map<number, { x: number; y: number }>, prev: Map<number, { x: number; y: number }>) => {
    const ok = await onMoveMany([...next].map(([id, p]) => ({ id, x: p.x, y: p.y })));
    if (!ok) applyPositions(new Map([...next.keys()].map((id) => [id, prev.get(id)!])));
  };

  const relayout = () => {
    const prev = cardPositions();
    applyPositions(autoRef.current);
    saveAll(autoRef.current, prev);
  };

  const dragGroup = (n: { id: string; position: { x: number; y: number } }) => {
    const s = dragStart.current;
    if (!s) return;
    applyPositions(groupMove(s, n));
  };
  // Cards of a dragged group, shifted by the drag delta (a whole number of grid cells when snapping).
  const groupMove = (s: { origin: { x: number; y: number }; cards: Map<number, { x: number; y: number }> }, n: { id: string; position: { x: number; y: number } }) => {
    const step = (d: number) => (snap ? snapTo(d) : d);
    const moved = translateGroup(graph.modules, graph.groups ?? [], s.cards, groupId(n), step(n.position.x - s.origin.x), step(n.position.y - s.origin.y));
    if (snap) moved.forEach((p, id) => moved.set(id, { x: snapTo(p.x), y: snapTo(p.y) }));
    return moved;
  };

  // Alignment guides: snap a dragged card to other cards' edges/centres (off with grid snap or Alt held).
  const guideDrag = (e: { altKey?: boolean }, n: { id: string; position: { x: number; y: number } }) => {
    const id = Number(n.id);
    const r = rectMap.get(id);
    if (snap || e.altKey || !r) { setGuides([]); return; }
    const others = [...rectMap].filter(([k]) => k !== id).map(([, o]) => o);
    const res = snapGuides({ ...r, x: n.position.x, y: n.position.y }, others, GUIDE_THRESHOLD / zoom.current);
    setGuides(res.guides);
    if (res.x !== n.position.x || res.y !== n.position.y) applyPositions(new Map([[id, { x: res.x, y: res.y }]]));
  };

  return (
    <div className="graph">
      <ReactFlow
        nodes={allNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange as unknown as OnNodesChange<CardNode | GroupFlowNode>} onEdgesChange={onEdgesChange}
        deleteKeyCode={null} onSelectionChange={({ nodes: ns }) => onSelectionChange?.(ns.filter((n) => n.type === 'card').map((n) => Number(n.id)))}
        onNodeClick={nodeClick} onEdgeClick={edgeClick} onPaneClick={onPaneClick} onConnect={connect}
        onNodeDragStart={(_, n) => { if (n.type === 'groupBox') dragStart.current = { origin: { ...n.position }, cards: cardPositions() }; }}
        onNodeDrag={(e, n) => { if (n.type === 'groupBox') dragGroup(n); else guideDrag(e, n); }}
        onMove={(_, vp) => { zoom.current = vp.zoom; }}
        snapToGrid={snap} snapGrid={[GRID, GRID]}
        nodeDragThreshold={5}
        onNodeDragStop={async (e, n) => {
          if (n.type === 'groupBox') {
            const s = dragStart.current;
            dragStart.current = null;
            if (!s) return;
            const next = groupMove(s, n);
            applyPositions(next);
            if (next.size) saveAll(next, s.cards);
            return;
          }
          setGuides([]);
          const id = Number(n.id);
          const round = snap ? snapTo : Math.round;
          // The stop event carries the raw pointer position, so re-apply the alignment snap shown during the drag.
          const r0 = rectMap.get(id);
          if (!snap && !e.altKey && r0) {
            const g = snapGuides({ ...r0, x: n.position.x, y: n.position.y }, [...rectMap].filter(([k]) => k !== id).map(([, o]) => o), GUIDE_THRESHOLD / zoom.current);
            n = { ...n, position: { x: g.x, y: g.y } };
          }
          // Save the position first so the group change's graph refetch cannot overwrite it.
          const saved = onMove(id, round(n.position.x), round(n.position.y));
          const m = graph.modules.find((x) => x.id === id);
          const r = rectMap.get(id);
          if (!m || !r) return;
          const target = dropGroup(graph.modules, graph.groups ?? [], new Map(rectMap).set(id, { ...r, x: n.position.x, y: n.position.y }), id);
          if (target !== m.groupId) { await saved; onAssignGroup(id, target); }
        }}
        colorMode={theme} minZoom={0.2} maxZoom={2} proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'routed' }}
      >
        <FitInitial skip={focusId != null} />
        <FocusOnMount id={focusId} />
        <Background gap={snap ? GRID : 24} />
        <ViewportPortal>
          {guides.map((g, i) => (
            <div key={i} className="snap-guide" data-testid="snap-guide" style={g.axis === 'v'
              ? { left: g.pos, top: g.from, width: 1, height: g.to - g.from }
              : { left: g.from, top: g.pos, width: g.to - g.from, height: 1 }} />
          ))}
        </ViewportPortal>
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeStrokeWidth={2} nodeColor={miniColor} nodeStrokeColor={theme === 'dark' ? '#8b949e' : '#57606a'}
          maskColor={theme === 'dark' ? 'rgba(13,17,23,.65)' : 'rgba(240,242,245,.7)'} />
        <Panel position="top-left" className="graph-tools">
          <button className="toolbar-btn" onClick={relayout}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="1.5" y="2" width="5" height="4" rx="1" /><rect x="9.5" y="10" width="5" height="4" rx="1" /><path d="M6.5 4h3v8h0" /></svg>
            Auto layout
          </button>
          <button className="toolbar-btn" aria-pressed={snap} onClick={toggleSnap}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M1.5 5.5h13M1.5 10.5h13M5.5 1.5v13M10.5 1.5v13" /></svg>
            Snap to grid
          </button>
          {tools}
        </Panel>
      </ReactFlow>
    </div>
  );
}
