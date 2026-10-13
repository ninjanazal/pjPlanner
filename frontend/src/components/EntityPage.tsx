import { useEffect, useState } from 'react';
import type { Group, Module } from '../types';
import { groupLabel, subtreeIds } from '../groupBoxes';
import { ConfirmDialog } from './ConfirmDialog';
import { randomIcon } from '../randomIcon';
import { ColorField, IconField } from './LookFields';
import { useAction } from './useAction';

export interface Entity { id: number; name: string; color: string | null; icon: string | null; parentId?: number | null }
export type EntityValues = { name: string; color: string | null; icon: string | null; parentId?: number | null };

export interface EntityPageProps {
  noun: 'owner' | 'group'; // lower-case singular, used in labels
  items: Entity[];
  modules: Module[];
  membersOf: (id: number) => Module[];
  groups?: Group[]; // present for the group page: enables the parent select, path labels and child lists
  save: (id: number | null, v: EntityValues) => Promise<Entity>;
  remove: (id: number) => Promise<void>;
  deleteMessage: (e: Entity, count: number) => string;
  emptyMembers: string;
  footerHint?: React.ReactNode;
  onChanged: () => void;
  onOpenModule: (id: number) => void;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// Master/detail page: tiles on the left; the detail pane is read-only until Edit is pressed.
export function EntityPage(p: EntityPageProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'add'>('view');
  const item = p.items.find((o) => o.id === selectedId) ?? null;
  const N = cap(p.noun);
  const label = (id: number, name: string) => (p.groups ? groupLabel(p.groups, id) : name);
  const children = p.groups && item ? p.groups.filter((g) => g.parentId === item.id) : [];

  return (
    <div className="owners-page">
      <div className="owners-list" aria-label={`${N}s list`}>
        <div className="row between">
          <h2>{N}s</h2>
          <button className="primary" onClick={() => { setMode('add'); setSelectedId(null); }}>Add {p.noun}</button>
        </div>
        {p.items.length === 0 && <p className="hint">No {p.noun}s yet. Add one to start assigning modules.</p>}
        {p.items.map((o) => {
          const n = p.membersOf(o.id).length;
          return (
            <button key={o.id} className={`owner-tile${o.id === selectedId ? ' selected' : ''}`}
              style={{ borderLeft: `4px solid ${o.color ?? 'var(--border)'}` }}
              aria-label={`${N} ${o.name}`} aria-pressed={o.id === selectedId}
              onClick={() => { setSelectedId(o.id); setMode('view'); }}>
              <strong>{o.icon && <span className="owner-icon">{o.icon} </span>}{label(o.id, o.name)}</strong>
              <small>{n} module{n === 1 ? '' : 's'}</small>
            </button>
          );
        })}
        {p.footerHint}
      </div>
      <section className="owner-detail">
        {mode === 'add' ? (
          <EntityForm key="new" p={p} item={null} onDone={(o) => { setMode('view'); if (o) setSelectedId(o.id); p.onChanged(); }} onCancel={() => setMode('view')} />
        ) : item && mode === 'edit' ? (
          <EntityForm key={item.id} p={p} item={item}
            onDone={(o) => { setMode('view'); if (!o) setSelectedId(null); p.onChanged(); }} onCancel={() => setMode('view')} />
        ) : item ? (
          <>
            <div className="row between">
              <div className="owner-preview entity-head" data-testid="entity-head" style={{ borderLeft: `4px solid ${item.color ?? 'var(--border)'}` }}>
                {item.icon && <span>{item.icon}</span>}<h2>{item.name}</h2>
              </div>
              <button onClick={() => setMode('edit')}>Edit</button>
            </div>
            {p.groups && item.parentId != null && (
              <p className="hint">Parent group: {groupLabel(p.groups, item.parentId)}</p>
            )}
            {p.groups && (
              <>
                <h3>Child groups</h3>
                {children.length === 0 && <p className="hint">No child groups.</p>}
                {children.map((c) => (
                  <button key={c.id} className="module-row" aria-label={`Open group ${c.name}`} onClick={() => setSelectedId(c.id)}>
                    <span>{c.icon ?? '▫'}</span><strong>{c.name}</strong>
                  </button>
                ))}
              </>
            )}
            <h3>{p.noun === 'owner' ? 'Assigned modules' : 'Modules in group'}</h3>
            {p.membersOf(item.id).length === 0 && <p className="hint">{p.emptyMembers}</p>}
            {p.membersOf(item.id).map((m) => (
              <button key={m.id} className="module-row" onClick={() => p.onOpenModule(m.id)} aria-label={`Open module ${m.name}`}>
                <span>{m.icon ?? '▫'}</span>
                <span className="swatch" style={{ background: m.color ?? 'var(--card-bg, var(--surface))' }} data-testid="swatch" />
                <strong>{m.name}</strong>
              </button>
            ))}
          </>
        ) : (
          <p className="hint">Select {p.noun === 'owner' ? 'an' : 'a'} {p.noun} to see {p.noun === 'owner' ? 'their' : 'its'} modules, or add a new one.</p>
        )}
      </section>
    </div>
  );
}

// onDone(entity) after save/create, onDone(null) after delete.
function EntityForm({ p, item, onDone, onCancel }: {
  p: EntityPageProps; item: Entity | null; onDone: (o: Entity | null) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [color, setColor] = useState<string | null>(item?.color ?? null);
  const [icon, setIcon] = useState<string | null>(item ? item.icon : randomIcon());
  const [parentId, setParentId] = useState<number | null>(item?.parentId ?? null);
  const [confirming, setConfirming] = useState(false);
  const { error, run } = useAction();
  useEffect(() => { if (item) { setName(item.name); setColor(item.color); setIcon(item.icon); } }, [item?.name, item?.color, item?.icon]);
  useEffect(() => { setParentId(item?.parentId ?? null); }, [item?.parentId]);
  const blocked = p.groups && item ? subtreeIds(p.groups, item.id) : new Set<number>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let saved: Entity | undefined;
    const ok = await run(async () => { saved = await p.save(item?.id ?? null, p.groups ? { name, color, icon, parentId } : { name, color, icon }); });
    if (ok) onDone(saved ?? item);
  };
  const del = async () => {
    setConfirming(false);
    if (item && (await run(() => p.remove(item.id)))) onDone(null);
  };

  return (
    <>
      <form onSubmit={submit}>
        <h2>{item ? `Edit ${p.noun}` : `Add ${p.noun}`}</h2>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        {p.groups && (
          <label>Parent group
            <select aria-label="Parent group" value={parentId ?? ''} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">None (top level)</option>
              {p.groups.filter((g) => !blocked.has(g.id)).map((g) => <option key={g.id} value={g.id}>{groupLabel(p.groups!, g.id)}</option>)}
            </select>
          </label>
        )}
        <ColorField value={color} onChange={setColor} />
        <IconField value={icon} onChange={setIcon} />
        <div className="owner-preview" data-testid="owner-preview" style={{ borderLeft: `4px solid ${color ?? 'var(--border)'}` }}>
          {icon && <span>{icon}</span>}<strong>{name || `${cap(p.noun)} name`}</strong>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button type="submit" className="primary">{item ? `Save ${p.noun}` : `Create ${p.noun}`}</button>
          {item && <button type="button" className="danger" onClick={() => setConfirming(true)}>Delete {p.noun}</button>}
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
      {confirming && item && (
        <ConfirmDialog message={p.deleteMessage(item, p.membersOf(item.id).length)} onConfirm={del} onCancel={() => setConfirming(false)} />
      )}
    </>
  );
}
