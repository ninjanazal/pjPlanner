import type { JiraFieldDescriptor } from '../types';

export type Val = string | string[];
type Opt = { id?: string; name?: string; value?: string };
export type ConfigValue = string | number | (string | number)[];
const MAX_OPTIONS = 200;
const optId = (o: Opt) => o.id ?? o.value ?? o.name ?? '';
const optText = (o: Opt) => o.name ?? o.value ?? o.id ?? '';
const options = (opts: Opt[]) => opts.map((o) => <option key={optId(o)} value={optId(o)}>{optText(o)}</option>);
const splitList = (v: Val) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
const isListText = (f: JiraFieldDescriptor) => f.kind === 'labels' || (f.kind === 'user' && f.multi);
const isPicker = (f: JiraFieldDescriptor) => Boolean(f.allowedValues) && ['option', 'priority', 'component', 'version'].includes(f.kind);

export const isUnsupported = (f: JiraFieldDescriptor) => Boolean(f.unsupported) || f.kind === 'unsupported';
export const isEmpty = (v: Val | undefined) => v === undefined || (Array.isArray(v) ? v.length === 0 : v.trim() === '');

// What a value is saved and sent as; undefined when empty or not fillable.
export function toValue(f: JiraFieldDescriptor, v: Val | undefined): ConfigValue | undefined {
  if (isUnsupported(f) || v === undefined || isEmpty(v)) return undefined;
  if (f.kind === 'number') return Number(v);
  if (f.kind === 'datetime') { const t = new Date(String(v)); return Number.isNaN(t.getTime()) ? String(v) : t.toISOString(); }
  if (isListText(f)) return splitList(v);
  if (f.multi) return Array.isArray(v) ? v : [v];
  return Array.isArray(v) ? v[0] : v;
}

// The editable form of a stored default.
export function fromValue(f: JiraFieldDescriptor, d: ConfigValue | undefined): Val | undefined {
  if (d === undefined || d === null) return undefined;
  if (isListText(f)) return (Array.isArray(d) ? d : [d]).join(', ');
  if (f.multi && isPicker(f)) return (Array.isArray(d) ? d : [d]).map(String);
  if (f.kind === 'datetime' && typeof d === 'string') {
    const t = new Date(d);
    if (!Number.isNaN(t.getTime())) { const p = (n: number) => String(n).padStart(2, '0'); return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`; }
  }
  if (f.multi) return (Array.isArray(d) ? d : [d]).join(', ');
  return Array.isArray(d) ? String(d[0] ?? '') : String(d);
}

interface Props { f: JiraFieldDescriptor; value: Val | undefined; onChange: (v: Val) => void; id: string; required?: boolean; ariaLabel?: string }

export function FieldControl({ f, value: v, onChange: set, id, required, ariaLabel }: Props) {
  if (isPicker(f)) {
    const opts = (f.allowedValues ?? []).slice(0, MAX_OPTIONS);
    return f.multi
      ? <select id={id} aria-label={ariaLabel} multiple required={required} value={Array.isArray(v) ? v : []} onChange={(e) => set([...e.target.selectedOptions].map((o) => o.value))}>
          {options(opts)}
        </select>
      : <select id={id} aria-label={ariaLabel} required={required} value={typeof v === 'string' ? v : ''} onChange={(e) => set(e.target.value)}>
          <option value="">{required ? 'Select…' : 'None'}</option>
          {options(opts)}
        </select>;
  }
  if (f.kind === 'text') return <textarea id={id} aria-label={ariaLabel} rows={3} required={required} value={typeof v === 'string' ? v : ''} onChange={(e) => set(e.target.value)} />;
  const type = f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : f.kind === 'datetime' ? 'datetime-local' : 'text';
  return <input id={id} aria-label={ariaLabel} type={type} required={required} value={typeof v === 'string' ? v : ''}
    placeholder={f.kind === 'user' ? 'User name' : f.kind === 'labels' || f.multi ? 'Comma-separated' : undefined} onChange={(e) => set(e.target.value)} />;
}
