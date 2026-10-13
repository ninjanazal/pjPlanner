import { CARD_API_MAX, cardWidth } from '../layout';
import { heatColor, type Heat, type OwnerLoad } from '../heatmap';
import type { ApiKind } from '../types';
import { Handle, Position, useConnection, type Node, type NodeProps } from '@xyflow/react';

export interface CardData extends Record<string, unknown> {
  name: string; owners: string[]; color: string | null; icon: string | null;
  apiItems: { kind: ApiKind; name: string; signature: string }[];
  textColor?: string | null; strokeColor?: string | null; strokeStyle?: string;
  heat?: Heat | null; // set while a sprint heatmap is shown
  person?: OwnerLoad | null; // set while one person's map is shown
}
export type CardNode = Node<CardData, 'card'>;

const METHOD = /^(GET|POST|PUT|PATCH|DELETE)\b/;

function ApiRow({ item }: { item: CardData['apiItems'][number] }) {
  const m = item.kind === 'endpoint' ? METHOD.exec(item.name) : null;
  const title = item.signature ? `${item.name}: ${item.signature}` : item.name;
  return (
    <div className="card-api-row" title={title} data-testid="card-api-row">
      <span className={`dot k-${item.kind}`} />
      {m && <span className={`method m-${m[1]}`}>{m[1]}</span>}
      <span className="api-name">{m ? item.name.slice(m[1].length).trim() || item.name : item.name}</span>
      {item.signature && <code className="api-sig">{item.signature}</code>}
    </div>
  );
}

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left];

export function ModuleCard({ data, selected }: NodeProps<CardNode>) {
  const connecting = useConnection((c) => c.inProgress);
  // Custom background keeps the dark default text for legibility; an explicit text colour wins.
  const vars: Record<string, string> = {};
  if (data.color) { vars['--card-bg'] = data.color; vars['--card-fg'] = '#111'; }
  if (data.heat) { vars['--card-bg'] = data.heat.open ? heatColor(data.heat.level) : 'var(--cold)'; vars['--card-fg'] = '#111'; }
  if (data.person) {
    const c = data.person.color ?? '#4f7cff';
    vars['--card-bg'] = data.person.owned ? c : data.person.open || data.person.done ? `color-mix(in srgb, ${c} 35%, var(--surface))` : 'var(--cold)';
    vars['--card-fg'] = data.person.owned ? '#fff' : '#111';
  }
  if (data.textColor && !data.heat && !data.person) vars['--card-fg'] = data.textColor;
  if (data.strokeColor) vars['--card-bc'] = data.strokeColor;
  if (data.strokeStyle && data.strokeStyle !== 'solid') vars['--card-bs'] = data.strokeStyle;
  const style = { ...vars, width: cardWidth(data.name, data.icon) } as React.CSSProperties;
  const ownersText = `Owners: ${data.owners.length ? data.owners.join(', ') : '-'}`;
  return (
    <div className={`card${selected ? ' selected' : ''}${data.heat && !data.heat.open ? ' cold' : ''}${data.person && !data.person.owned && !data.person.open && !data.person.done ? ' cold' : ''}`} style={style} data-testid="module-card">
      {SIDES.map((p) => <Handle key={p} id={p} type="source" position={p} className="card-handle" />)}
      <Handle id="drop" type="target" position={Position.Left} isConnectableStart={false}
        className="card-drop" style={{ pointerEvents: connecting ? 'all' : 'none' }} />
      <div className="card-name" title={data.name}>{data.icon && <span className="card-icon">{data.icon} </span>}{data.name}</div>
      {data.heat && <div className="card-heat" data-testid="card-heat">{data.heat.open} open{data.heat.done ? ` · ${data.heat.done} done` : ''}</div>}
      {data.person && (data.person.owned || data.person.open > 0 || data.person.done > 0) && (
        <div className="card-heat" data-testid="card-person">{data.person.owned ? '★ owner' : 'helps'} · {data.person.open} open{data.person.done ? ` · ${data.person.done} done` : ''}</div>
      )}
      <div className="card-owners" title={ownersText}>{ownersText}</div>
      {data.apiItems.length > 0 && (
        <div className="card-api-list">
          {data.apiItems.slice(0, CARD_API_MAX).map((it, i) => <ApiRow key={i} item={it} />)}
          {data.apiItems.length > CARD_API_MAX && (
            <div className="card-api-row more">+{data.apiItems.length - CARD_API_MAX} more</div>
          )}
        </div>
      )}
    </div>
  );
}
