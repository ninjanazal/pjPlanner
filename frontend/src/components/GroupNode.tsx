import type { Node, NodeProps } from '@xyflow/react';

export interface GroupData extends Record<string, unknown> { name: string; color: string | null; icon: string | null }
export type GroupFlowNode = Node<GroupData, 'groupBox'>;

// Container drawn behind its cards; only the header and border strips (.group-grab) take drags, so cards stay clickable.
export function GroupNode({ data }: NodeProps<GroupFlowNode>) {
  const style = data.color ? ({ '--group-c': data.color } as React.CSSProperties) : undefined;
  return (
    <div className="group-box" style={style} data-testid="group-box">
      <div className="group-title group-grab" title={data.name}>{data.icon && <span>{data.icon} </span>}{data.name}</div>
      {['t', 'b', 'l', 'r'].map((s) => <div key={s} className={`group-edge group-grab ${s}`} />)}
    </div>
  );
}
