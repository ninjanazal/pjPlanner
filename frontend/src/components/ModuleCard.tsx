import { CARD_OPEN_W, cardWidth, type CardTier } from '../layout';
import { heatColor, type Heat, type OwnerLoad } from '../heatmap';
import { API_KINDS, type ApiKind, type TestStatus } from '../types';
import { Handle, Position, useConnection, type Node, type NodeProps } from '@xyflow/react';

export interface CardData extends Record<string, unknown> {
  name: string; experts: string[]; color: string | null; icon: string | null;
  apiItems: { kind: ApiKind; name: string; signature: string }[];
  textColor?: string | null; strokeColor?: string | null; strokeStyle?: string;
  heat?: Heat | null; // set while a sprint heatmap is shown
  person?: OwnerLoad | null; // set while one person's map is shown
  testStatus?: TestStatus | null; // null/undefined = not assessed, no badge
  usedBy?: number; // dependants, set only for shared foundations
  tier?: CardTier; // size class by number of links
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

export const TEST_BADGE: Record<TestStatus, { glyph: string; label: string }> = {
  full: { glyph: '🧪✓', label: 'Has tests' },
  partial: { glyph: '🧪~', label: 'Partly tested' },
  none: { glyph: '🧪✗', label: 'No tests' },
};

const KINDS = API_KINDS;
const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left];

export function ModuleCard({ data, selected }: NodeProps<CardNode>) {
  const connecting = useConnection((c) => c.inProgress);
  // Custom background keeps the dark default text for legibility; an explicit text colour wins.
  const vars: Record<string, string> = {};
  if (data.color) { vars['--card-bg'] = data.color; vars['--card-fg'] = '#111'; }
  if (data.heat) { vars['--card-bg'] = data.heat.open ? heatColor(data.heat.level) : 'var(--cold)'; vars['--card-fg'] = '#111'; }
  if (data.person) {
    const c = data.person.color ?? '#4f7cff';
    vars['--card-bg'] = data.person.experience > 0 ? c : data.person.open || data.person.done ? `color-mix(in srgb, ${c} 35%, var(--surface))` : 'var(--cold)';
    vars['--card-fg'] = data.person.experience > 0 ? '#fff' : '#111';
  }
  if (data.textColor && !data.heat && !data.person) vars['--card-fg'] = data.textColor;
  if (data.strokeColor) vars['--card-bc'] = data.strokeColor;
  if (data.strokeStyle && data.strokeStyle !== 'solid') vars['--card-bs'] = data.strokeStyle;
  const tier = data.tier ?? 'md';
  const open = !!selected && data.apiItems.length > 0;
  const style = { ...vars, width: open ? Math.max(cardWidth(data.name, data.icon, tier), CARD_OPEN_W) : cardWidth(data.name, data.icon, tier) } as React.CSSProperties;
  const counts = data.apiItems.reduce<Partial<Record<ApiKind, number>>>((c, i) => ({ ...c, [i.kind]: (c[i.kind] ?? 0) + 1 }), {});
  const ownersText = `Experts: ${data.experts.length ? data.experts.join(', ') : '-'}`;
  return (
    <div className={`card t-${tier}${selected ? ' selected' : ''}${open ? ' open' : ''}${data.heat && !data.heat.open ? ' cold' : ''}${data.person && !data.person.experience && !data.person.open && !data.person.done ? ' cold' : ''}`} style={style} data-testid="module-card">
      {SIDES.map((p) => <Handle key={p} id={p} type="source" position={p} className="card-handle" />)}
      <Handle id="drop" type="target" position={Position.Left} isConnectableStart={false}
        className="card-drop" style={{ pointerEvents: connecting ? 'all' : 'none' }} />
      <div className="card-name" title={data.name}>{data.icon && <span className="card-icon">{data.icon} </span>}{data.name}</div>
      {!!data.usedBy && <div className="card-hub" title="Shared foundation: many modules depend on it">used by {data.usedBy}</div>}
      {data.heat && <div className="card-heat" data-testid="card-heat">{data.heat.open} open{data.heat.done ? ` · ${data.heat.done} done` : ''}</div>}
      {data.person && (data.person.experience > 0 || data.person.open > 0 || data.person.done > 0) && (
        <div className="card-heat" data-testid="card-person">{data.person.experience > 0 ? `★ ${data.person.experience} closed` : 'new here'} · {data.person.open} open{data.person.done ? ` · ${data.person.done} done` : ''}</div>
      )}
      <div className="card-foot">
        {data.testStatus && <span className={`card-test t-${data.testStatus}`} title={TEST_BADGE[data.testStatus].label} data-testid="card-test" aria-label={TEST_BADGE[data.testStatus].label}>{TEST_BADGE[data.testStatus].glyph}</span>}
        <div className="card-owners" title={ownersText}>{ownersText}</div>
      </div>
      {data.apiItems.length > 0 && (
        open ? (
          <div className="card-api-list">
            {data.apiItems.map((it, i) => <ApiRow key={i} item={it} />)}
          </div>
        ) : (
          <div className="card-api-summary" title="Select to see the API">
            {KINDS.filter((k) => counts[k]).map((k) => <span key={k} className="card-api-chip"><span className={`dot k-${k}`} />{counts[k]}</span>)}
            <span className="card-api-hint">{data.apiItems.length} API {data.apiItems.length === 1 ? 'item' : 'items'}</span>
          </div>
        )
      )}
    </div>
  );
}
