import { useRef, useState } from 'react';
import { api } from '../api';
import { childTypes } from '../issueTree';
import { TYPE_ICON, type Issue, type IssueType, type Module, type Owner } from '../types';
import { Modal } from './Modal';
import { useAction } from './useAction';

interface Row { title: string; type: IssueType; moduleId: number | null }
interface Props { parent: Issue; modules: Module[]; owners?: Owner[]; onClose: () => void; onChanged: () => void }

export function BreakdownDialog({ parent, modules, onClose, onChanged }: Props) {
  const types = childTypes(parent.type);
  const blank = (): Row => ({ title: '', type: types.includes('task') ? 'task' : types[0], moduleId: null });
  const [rows, setRows] = useState<Row[]>([blank(), blank()]);
  const { error, run } = useAction();
  const patch = (i: number, p: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const focusLast = useRef(false);
  const add = () => { focusLast.current = true; setRows((x) => [...x, blank()]); };
  const filled = rows.filter((r) => r.title.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (filled.length === 0) return;
    // Created in order; on a failure the ones already saved are kept and removed from the list.
    let created = 0;
    const ok = await run(async () => {
      for (const r of filled) {
        await api.createIssue({ type: r.type, title: r.title.trim(), parentId: parent.id, ...(r.type === 'task' ? { moduleId: r.moduleId } : {}) });
        created++;
      }
    });
    if (ok) onChanged();
    else if (created > 0) setRows((cur) => { const left = cur.filter((r) => r.title.trim()).slice(created); return left.length ? left : [blank()]; });
  };

  return (
    <Modal title={`Break down #${parent.id} ${parent.title}`} dirty={filled.length > 0} onClose={onClose}>
      <form onSubmit={submit} className="breakdown">
        <p className="hint">Add the pieces of work. Each becomes a {types.join(' / ')} under this {parent.type}; set the module it touches. Owners are assigned automatically when the work enters a sprint.</p>
        {rows.map((r, i) => (
          <div className="bd-card" key={i}>
            <div className="bd-top">
              <input ref={(el) => { if (el && i === rows.length - 1 && focusLast.current) { el.focus(); focusLast.current = false; } }}
                data-autofocus={i === 0 || undefined} aria-label={`Title ${i + 1}`} placeholder="What needs doing? (Enter adds another)" value={r.title}
                onChange={(e) => patch(i, { title: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (r.title.trim()) add(); } }} />
              <button type="button" className="bd-x" aria-label={`Remove row ${i + 1}`} onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : x))}>×</button>
            </div>
            {types.length > 1 && (
              <div className="bd-pick" role="group" aria-label={`Type ${i + 1}`}>
                {types.map((t) => <button type="button" key={t} className={`pick${r.type === t ? ' on' : ''}`} aria-pressed={r.type === t} onClick={() => patch(i, { type: t })}><span aria-hidden="true">{TYPE_ICON[t]}</span> {t}</button>)}
              </div>
            )}
            {r.type === 'task' && <div className="bd-pick" role="group" aria-label={`Module ${i + 1}`}>
              <span className="bd-lbl">Module</span>
              {modules.map((m) => (
                <button type="button" key={m.id} className={`pick${r.moduleId === m.id ? ' on' : ''}`} aria-pressed={r.moduleId === m.id}
                  style={{ '--chip-c': m.color ?? 'var(--border)' } as React.CSSProperties} onClick={() => patch(i, { moduleId: r.moduleId === m.id ? null : m.id })}>{m.icon} {m.name}</button>
              ))}
            </div>}
          </div>
        ))}
        <button type="button" onClick={add}>+ Add another</button>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row modal-actions">
          <button type="submit" className="primary" disabled={filled.length === 0}>Create {filled.length || ''} {filled.length === 1 ? 'issue' : 'issues'}</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
