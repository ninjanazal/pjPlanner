import { BaseEdge, EdgeLabelRenderer, Position, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { Route, Side } from '../edgeRouting';
import { EDGE_SELECTED, tipPoint } from '../edgeRouting';

// Polyline through the waypoints with rounded corners.
function roundedPath(pts: { x: number; y: number }[], radius: number): string {
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]; const b = pts[i]; const c = pts[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y); const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const p1 = { x: b.x + ((a.x - b.x) / l1) * r, y: b.y + ((a.y - b.y) / l1) * r };
    const p2 = { x: b.x + ((c.x - b.x) / l2) * r, y: b.y + ((c.y - b.y) / l2) * r };
    d += ` L ${p1.x} ${p1.y} Q ${b.x} ${b.y} ${p2.x} ${p2.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

export type RoutedEdgeData = { route?: Route; label?: string; color?: string | null; onLabelClick?: () => void };
export type RoutedEdgeType = Edge<RoutedEdgeData, 'routed'>;

const POS: Record<Side, Position> = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };

export function RoutedEdge(props: EdgeProps<RoutedEdgeType>) {
  const { id, data, selected, markerEnd, interactionWidth } = props;
  const r = data?.route;
  const tip = r ? tipPoint(r) : null;
  const [stepPath] = getSmoothStepPath({
    sourceX: r?.sx ?? props.sourceX, sourceY: r?.sy ?? props.sourceY, sourcePosition: r ? POS[r.sp] : props.sourcePosition,
    targetX: tip?.x ?? props.targetX, targetY: tip?.y ?? props.targetY, targetPosition: r ? POS[r.tp] : props.targetPosition,
    centerX: r?.centerX, centerY: r?.centerY, borderRadius: 10,
  });
  const path = r?.path ? roundedPath(r.path, 10) : stepPath;
  const color = data?.color ?? 'var(--edge)';
  return (
    <>
      {selected && <path d={path} fill="none" stroke={EDGE_SELECTED} strokeWidth={9} strokeOpacity={0.35} strokeLinecap="round" />}
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={interactionWidth}
        style={{ stroke: selected && !data?.color ? EDGE_SELECTED : color }} />
      {data?.label && r?.label && (
        <EdgeLabelRenderer>
          <div className="edge-pill nodrag nopan" onClick={data.onLabelClick}
            style={{ transform: `translate(-50%, -50%) translate(${r.label.x}px, ${r.label.y}px)`, borderColor: color,
              ...(selected ? { borderColor: EDGE_SELECTED } : {}) }}>
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
