import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ApiItemInput, ApiKind, Graph, Issue, Module, StrokeStyle } from '../types';
import { API_KINDS, STROKE_STYLES } from '../types';
import type { Theme } from '../theme';
import { randomIcon } from '../randomIcon';
import { ColorField, IconField } from './LookFields';
import { ConfirmDialog } from './ConfirmDialog';
import { useAction } from './useAction';
import { Modal } from './Modal';
import { groupLabel } from '../groupBoxes';
import { StateBadge, TypeBadge } from './IssuesPage';

const METHOD = /^(GET|POST|PUT|PATCH|DELETE)\b/;
// Colour-code an HTTP method at the start of an endpoint signature/name.
function Sig({ text, kind }: { text: string; kind: ApiKind }) {
  const m = kind === 'endpoint' ? METHOD.exec(text) : null;
  return (
    <code className="sig">
      {m ? <><span className={`method m-${m[1]}`}>{m[1]}</span>{text.slice(m[1].length)}</> : text}
    </code>
  );
}

interface Props {
  graph: Graph;
  issues?: Issue[];
  module: Module | null; // null = creating
  onChanged: (selectId?: number | null) => void;
  onClose: () => void;
  theme?: Theme;
}

// Read-first popup: overview of a module, with an Edit button that swaps in the form.
// A new module opens straight in edit mode.
export function ModuleDialog({ graph, issues = [], module, onChanged, onClose, theme = 'dark' }: Props) {
  const [mode, setMode] = useState<'view' | 'edit'>(module ? 'view' : 'edit');
  const [addItem, setAddItem] = useState(false);
  const [dirty, setDirty] = useState(false);
  const group = module?.groupId != null ? (graph.groups ?? []).find((g) => g.id === module.groupId) : undefined;
  const edit = (withItem = false) => { setAddItem(withItem); setMode('edit'); };

  const title = mode === 'edit' ? (module ? `Edit ${module.name}` : 'New module')
    : <>{module!.icon && <span aria-hidden="true">{module!.icon} </span>}{module!.name}</>;
  const chip = mode === 'view' && module && group && <GroupChip graph={graph} module={module} groupId={group.id} onChanged={onChanged} />;

  return (
    <Modal title={title} headerExtra={chip} dirty={dirty} onClose={onClose}>
      {mode === 'view' && module ? (
        <ModuleView graph={graph} issues={issues} module={module} onEdit={edit} />
      ) : (
        <ModuleForm graph={graph} module={module} theme={theme} startAdding={addItem} onDirty={setDirty}
          onSaved={(id) => { if (module) setMode('view'); onChanged(id); }}
          onDeleted={() => onChanged(null)} onLinked={() => onChanged(module?.id)}
          onCancel={module ? () => setMode('view') : onClose} />
      )}
    </Modal>
  );
}

// Group chip with an x that ungroups right away, using the saved module values (not unsaved form edits).
function GroupChip({ graph, module, groupId, onChanged }: { graph: Graph; module: Module; groupId: number; onChanged: (id?: number | null) => void }) {
  const group = (graph.groups ?? []).find((g) => g.id === groupId)!;
  const { error, run } = useAction();
  const ungroup = async () => {
    const { id: _id, x: _x, y: _y, groupId: _g, ...saved } = module;
    if (await run(() => api.updateModule(module.id, { ...saved, groupId: null }))) onChanged(module.id);
  };
  return (
    <>
      <span className="chip group-chip" style={group.color ? ({ '--chip-c': group.color } as React.CSSProperties) : undefined}>
        {group.icon && <span aria-hidden="true">{group.icon}</span>}{groupLabel(graph.groups ?? [], group.id)}
        <button type="button" className="chip-x" aria-label="Remove from group" onClick={ungroup}>x</button>
      </span>
      {error && <span className="error" role="alert">{error}</span>}
    </>
  );
}

function ModuleView({ graph, issues, module, onEdit }: { graph: Graph; issues: Issue[]; module: Module; onEdit: (withItem?: boolean) => void }) {
  const items = module.apiItems;
  const owners = graph.owners.filter((o) => module.ownerIds.includes(o.id));
  const linked = issues.filter((i) => i.moduleId === module.id);
  return (
    <div className="module-view">
      <section className="api-overview" aria-label="API overview">
        <h3>API <span className="count">{items.length}</span></h3>
        {items.length === 0 ? (
          <div className="hint">
            <p>No API documented yet.</p>
            <button type="button" onClick={() => onEdit(true)}>Add API item</button>
          </div>
        ) : API_KINDS.filter((k) => items.some((i) => i.kind === k)).map((k) => (
          <div key={k} className="api-group">
            <h4><span className={`kind k-${k}`}>{k}</span> <span className="count">{items.filter((i) => i.kind === k).length}</span></h4>
            {items.filter((i) => i.kind === k).map((it) => (
              <div key={it.id} className={`api-card k-${k}`} data-testid="api-card">
                <strong>{it.name || '(unnamed)'}</strong>
                {it.signature && <Sig text={it.signature} kind={k} />}
                {it.description && <small>{it.description}</small>}
              </div>
            ))}
          </div>
        ))}
      </section>
      <section aria-label="Owners">
        <h3>Owners</h3>
        {owners.length === 0 ? <p className="hint">No owners assigned.</p> : (
          <div className="row wrap">
            {owners.map((o) => (
              <span key={o.id} className="chip owner-chip" style={o.color ? ({ '--chip-c': o.color } as React.CSSProperties) : undefined}>
                {o.icon && <span aria-hidden="true">{o.icon}</span>}{o.name}
              </span>
            ))}
          </div>
        )}
      </section>
      <section aria-label="Description">
        <h3>Description</h3>
        {module.description ? <p className="description">{module.description}</p> : <p className="hint">No description.</p>}
      </section>
      {linked.length > 0 && (
        <section aria-label="Issues">
          <h3>Issues <span className="count">{linked.length}</span></h3>
          <ul className="module-issues">
            {linked.map((i) => (
              <li key={i.id} className="issue-row" data-testid="module-issue">
                <TypeBadge type={i.type} /><span className="hint">#{i.id}</span><span className="issue-name">{i.title}</span><StateBadge state={i.state} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="row modal-actions">
        <button className="primary" onClick={() => onEdit()}>Edit</button>
      </div>
    </div>
  );
}

interface FormProps {
  graph: Graph; module: Module | null; theme: Theme; startAdding: boolean;
  onDirty: (d: boolean) => void; onSaved: (id?: number) => void; onDeleted: () => void; onLinked: () => void; onCancel: () => void;
}

function ModuleForm({ graph, module, theme, startAdding, onDirty, onSaved, onDeleted, onLinked, onCancel }: FormProps) {
  const [name, setName] = useState(module?.name ?? '');
  const [description, setDescription] = useState(module?.description ?? '');
  const [ownerIds, setOwnerIds] = useState<number[]>(module?.ownerIds ?? []);
  const [color, setColor] = useState<string | null>(module?.color ?? null);
  const [textColor, setTextColor] = useState<string | null>(module?.textColor ?? null);
  const [strokeColor, setStrokeColor] = useState<string | null>(module?.strokeColor ?? null);
  const [strokeStyle, setStrokeStyle] = useState<StrokeStyle>(module?.strokeStyle ?? 'solid');
  const [groupId, setGroupId] = useState<number | null>(module?.groupId ?? null);
  const [icon, setIcon] = useState<string | null>(module?.icon ?? (module ? null : randomIcon()));
  // key is a stable React key; id is absent for items not yet saved.
  const [items, setItems] = useState<(ApiItemInput & { key: number })[]>(() => [
    ...(module?.apiItems ?? []).map((a) => ({ ...a, key: a.id })),
    ...(startAdding ? [{ key: -1, kind: 'function' as ApiKind, name: '', signature: '', description: '' }] : []),
  ]);
  const [editing, setEditing] = useState<number | null>(startAdding ? -1 : null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [nextKey, setNextKey] = useState(startAdding ? -2 : -1);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [target, setTarget] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [linkColor, setLinkColor] = useState<string | null>(null);
  const { error, run } = useAction();

  const toggleOwner = (id: number) =>
    setOwnerIds((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    let savedId: number | undefined;
    const ok = await run(async () => {
      const saved = module ? await api.updateModule(module.id, body) : await api.createModule(body);
      savedId = saved?.id ?? module?.id;
    });
    if (ok) onSaved(savedId);
  };

  const cancel = () => { if (dirty) setDiscarding(true); else onCancel(); };

  const patchItem = (key: number, patch: Partial<ApiItemInput>) =>
    setItems((l) => l.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const addItem = () => {
    setItems((l) => [...l, { key: nextKey, kind: 'function', name: '', signature: '', description: '' }]);
    setEditing(nextKey);
    setNextKey(nextKey - 1);
  };
  const removeItem = () => {
    setItems((l) => l.filter((i) => i.key !== removing));
    setRemoving(null);
  };

  const remove = async () => {
    setConfirming(false);
    if (module && (await run(() => api.deleteModule(module.id)))) onDeleted();
  };

  const link = async () => {
    if (!module || !target) return;
    const ok = await run(() =>
      api.createRelation({ sourceId: module.id, targetId: Number(target), label: linkLabel.trim() || null, color: linkColor }),
    );
    if (ok) { setTarget(''); setLinkLabel(''); setLinkColor(null); onLinked(); }
  };

  const relCount = module
    ? graph.relations.filter((r) => r.sourceId === module.id || r.targetId === module.id).length
    : 0;

  const body = {
    name, description, ownerIds, color, icon, textColor, strokeColor, strokeStyle, groupId,
    apiItems: items.map(({ key: _k, ...r }) => r),
  };
  const snapshot = JSON.stringify(body);
  const initial = useRef(snapshot);
  const dirty = snapshot !== initial.current;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  return (
    <>
      <form onSubmit={save}>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label>Group
          <select aria-label="Group" value={groupId ?? ''} onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">None</option>
            {(graph.groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.icon ? `${g.icon} ${groupLabel(graph.groups ?? [], g.id)}` : groupLabel(graph.groups ?? [], g.id)}</option>)}
          </select>
        </label>
        <fieldset>
          <legend>Owners</legend>
          {graph.owners.length === 0 && <small>No owners yet. Add some on the Owners page.</small>}
          {graph.owners.map((o) => (
            <label key={o.id} className="check">
              <input type="checkbox" checked={ownerIds.includes(o.id)} onChange={() => toggleOwner(o.id)} />
              {o.color && <span className="swatch" style={{ background: o.color }} data-testid="owner-swatch" />}
              {o.icon && <span>{o.icon}</span>}
              {o.name}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Look</legend>
          <ColorField value={color} onChange={setColor} theme={theme} />
          <div className="row wrap">
            <label className="check">Text colour
              <input type="color" aria-label="Text colour" value={textColor ?? (theme === 'dark' ? '#e6edf3' : '#1e1e1e')} onChange={(e) => setTextColor(e.target.value)} />
            </label>
            <button type="button" onClick={() => setTextColor(null)} disabled={textColor === null}>Reset text colour</button>
          </div>
          <div className="row wrap">
            <label className="check">Stroke colour
              <input type="color" aria-label="Stroke colour" value={strokeColor ?? (theme === 'dark' ? '#e6edf3' : '#1e1e1e')} onChange={(e) => setStrokeColor(e.target.value)} />
            </label>
            <button type="button" onClick={() => setStrokeColor(null)} disabled={strokeColor === null}>Reset stroke colour</button>
          </div>
          <label className="check">Stroke type
            <select aria-label="Stroke type" value={strokeStyle} onChange={(e) => setStrokeStyle(e.target.value as StrokeStyle)}>
              {STROKE_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <IconField value={icon} onChange={setIcon} />
        </fieldset>
        <fieldset>
          <legend>API</legend>
          {items.length === 0 && <small>No API items yet.</small>}
          {items.map((it) => (
            <div key={it.key} className="api-item">
              {editing === it.key ? (
                <>
                  <select aria-label="Item kind" value={it.kind} onChange={(e) => patchItem(it.key, { kind: e.target.value as ApiKind })}>
                    {API_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                  <input aria-label="Item name" placeholder="Name" value={it.name} onChange={(e) => patchItem(it.key, { name: e.target.value })} />
                  <input aria-label="Item signature" placeholder="Signature" value={it.signature} onChange={(e) => patchItem(it.key, { signature: e.target.value })} />
                  <textarea aria-label="Item description" placeholder="Description" value={it.description} onChange={(e) => patchItem(it.key, { description: e.target.value })} />
                  <div className="row"><button type="button" onClick={() => setEditing(null)}>Done</button></div>
                </>
              ) : (
                <>
                  <div className="row wrap"><span className="badge">{it.kind}</span><strong>{it.name || '(unnamed)'}</strong></div>
                  {it.signature && <code className="sig">{it.signature}</code>}
                  {it.description && <small>{it.description}</small>}
                  <div className="row">
                    <button type="button" aria-label={`Edit ${it.name}`} onClick={() => setEditing(it.key)}>Edit</button>
                    <button type="button" aria-label={`Remove ${it.name}`} onClick={() => setRemoving(it.key)}>Remove</button>
                  </div>
                </>
              )}
            </div>
          ))}
          <button type="button" onClick={addItem}>Add API item</button>
        </fieldset>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button type="submit" className="primary">{module ? 'Save' : 'Create'}</button>
          <button type="button" onClick={cancel}>Cancel</button>
          {module && <button type="button" className="danger" onClick={() => setConfirming(true)}>Delete</button>}
        </div>
      </form>
      {module && (
        <div className="section">
          <h3>Link to...</h3>
          <select aria-label="Link target" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Select module</option>
            {graph.modules.filter((m) => m.id !== module.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <input placeholder="Label (optional)" aria-label="Link label" value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} />
          <ColorField label="Arrow colour" value={linkColor} onChange={setLinkColor} theme={theme} />
          <button onClick={link} disabled={!target}>Create link</button>
        </div>
      )}
      {removing !== null && (
        <ConfirmDialog
          message={`Remove API item "${items.find((i) => i.key === removing)?.name}"? It is deleted when you save the module.`}
          onConfirm={removeItem}
          onCancel={() => setRemoving(null)}
        />
      )}
      {discarding && (
        <ConfirmDialog title="Discard changes?" message="You have unsaved edits. Cancelling will discard them."
          confirmLabel="Discard" cancelLabel="Keep editing" onConfirm={onCancel} onCancel={() => setDiscarding(false)} />
      )}
      {confirming && module && (
        <ConfirmDialog
          message={`Delete module "${module.name}"? This also deletes its ${relCount} relation(s) (cascade).`}
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
