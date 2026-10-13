import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Issue, Module, Owner, Relation, Sprint, SprintInput } from '../types';
import { epicOf, groupIssues, isWork, withSprint, withOwner, withState, type GroupBy } from '../sprintGroups';
import { ConfirmDialog } from './ConfirmDialog';
import { Modal } from './Modal';
import { SprintTimeline } from './SprintTimeline';
import { useAction } from './useAction';

interface Props { sprints: Sprint[]; issues: Issue[]; modules: Module[]; owners: Owner[]; relations?: Relation[]; onChanged: () => void }

const chipStyle = (c: string | null) => ({ '--chip-c': c ?? 'var(--border)' } as React.CSSProperties);

export function SprintsPage({ sprints, issues, modules, owners, relations = [], onChanged }: Props) {
  const [by, setBy] = useState<GroupBy>('module');
  const [editing, setEditing] = useState<Sprint | 'new' | null>(null);
  const [timeline, setTimeline] = useState<Sprint | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const { error, run } = useAction();
  const work = issues.filter(isWork); // epics and bugs only group; tasks are the sprint work
  const active = sprints.find((s) => s.state === 'active');
  const assignable = sprints.filter((s) => s.state !== 'closed');
  const backlog = work.filter((i) => i.sprintId == null && i.state === 'open');
  // Finished work that never went into a sprint still has a home here.
  const done = work.filter((i) => i.sprintId == null && i.state === 'closed');
  const live = sprints.filter((s) => s.state !== 'closed').sort((a, b) => (a.state === 'active' ? -1 : b.state === 'active' ? 1 : a.id - b.id));
  const history = sprints.filter((s) => s.state === 'closed').sort((a, b) => b.id - a.id);

  const act = async (fn: () => Promise<unknown>) => { if (await run(fn)) onChanged(); };
  const setState = (s: Sprint, state: Sprint['state']) =>
    act(() => api.updateSprint(s.id, { name: s.name, goal: s.goal, state }));
  const move = (i: Issue, sprintId: number | null) => { if (i.sprintId !== sprintId) act(() => api.updateIssue(i.id, withSprint(i, sprintId))); };
  const drop = (e: React.DragEvent, sprintId: number | null) => {
    e.preventDefault(); setOver(null);
    const i = work.find((x) => x.id === Number(e.dataTransfer.getData('text/plain')));
    if (i) move(i, sprintId);
  };
  // The browser doesn't scroll while dragging over our own panels, so scroll the nearest scrollable area near its edge.
  useEffect(() => {
    const onOver = (e: DragEvent) => {
      const zone = 60, step = 18;
      const room = (el: Element) => { const o = getComputedStyle(el).overflowY; return /auto|scroll/.test(o) && el.scrollHeight > el.clientHeight; };
      let el: Element | null = e.target instanceof Element ? e.target : null;
      while (el && el !== document.body) {
        if (room(el)) {
          const r = el.getBoundingClientRect();
          if (e.clientY < r.top + zone && el.scrollTop > 0) { el.scrollTop -= step; return; }
          if (e.clientY > r.bottom - zone && el.scrollTop + el.clientHeight < el.scrollHeight) { el.scrollTop += step; return; }
        }
        el = el.parentElement;
      }
      if (e.clientY < zone) window.scrollBy(0, -step);
      else if (e.clientY > window.innerHeight - zone) window.scrollBy(0, step);
    };
    document.addEventListener('dragover', onOver);
    return () => document.removeEventListener('dragover', onOver);
  }, []);
  const dropProps = (key: string, sprintId: number | null, enabled: boolean) => enabled ? {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(key); },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (e: React.DragEvent) => drop(e, sprintId),
  } : {};

  const sprintClosed = (i: Issue) => sprints.find((x) => x.id === i.sprintId)?.state === 'closed';
  const canAssign = (i: Issue) => i.state === 'open' && !sprintClosed(i) && owners.length > 0;
  const choices = (i: Issue) => owners.filter((o) => modules.find((m) => m.id === i.moduleId)?.ownerIds.includes(o.id));

  // One task = one slim row: tick, title, then where it is and who has it.
  const task = (i: Issue, opts: { draggable: boolean; toBacklog: boolean; pick: boolean }) => {
    const owner = owners.find((o) => o.id === i.ownerId);
    const mod = modules.find((m) => m.id === i.moduleId);
    const epic = epicOf(i, issues);
    const closedHere = i.sprintId != null && sprintClosed(i);
    const isDone = i.state === 'closed';
    return (
      <li key={i.id} className={`tk${isDone ? ' is-done' : ''}`} style={{ '--c': mod?.color ?? 'var(--border)' } as React.CSSProperties}
        draggable={opts.draggable} onDragStart={(e) => e.dataTransfer.setData('text/plain', String(i.id))}>
        {closedHere
          ? <span className={`tk-check${isDone ? ' on' : ''}`} aria-hidden="true">{isDone ? '✓' : ''}</span>
          : <button className={`tk-check${isDone ? ' on' : ''}`} aria-label={`${isDone ? 'Reopen' : 'Close'} issue ${i.title}`} title={isDone ? 'Reopen' : 'Mark as done'}
              onClick={() => act(() => api.updateIssue(i.id, withState(i, isDone ? 'open' : 'closed')))}>{isDone ? '✓' : ''}</button>}
        <div className="tk-main">
          <span className="tk-title">{i.title}</span>
          <span className="tk-sub">
            #{i.id}
            {i.estimate != null && <span> · {i.estimate} step{i.estimate === 1 ? '' : 's'}</span>}
            {by !== 'epic' && epic && <span title="Epic"> · ⚡ {epic.title}</span>}
            {by !== 'module' && mod && <span> · {mod.icon} {mod.name}</span>}
          </span>
        </div>
        {canAssign(i) && !opts.pick // in the backlog the owner is dealt automatically once the task joins a sprint
          ? (
            <select className="tk-owner" aria-label={`Assignee for ${i.title}`} value={i.ownerId ?? ''} style={chipStyle(owner?.color ?? null)}
              disabled={choices(i).length === 0} title={i.moduleId == null ? 'Set a module first' : choices(i).length === 0 ? 'The module has no owners' : undefined}
              onChange={(e) => act(() => api.updateIssue(i.id, withOwner(i, e.target.value ? Number(e.target.value) : null)))}>
              <option value="">{i.moduleId == null ? 'Set a module first' : choices(i).length === 0 ? 'No module owners' : 'Unassigned'}</option>
              {choices(i).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )
          : owner && <span className="tk-owner-chip" style={chipStyle(owner.color)}>{owner.icon} {owner.name}</span>}
        {canAssign(i) && i.ownerId == null && !opts.pick && (
          <button className="tk-auto" aria-label={`Auto-assign ${i.title}`} title="Pick the best owner from the module's owners" onClick={() => act(() => api.autoAssignIssue(i.id))}>✨ Auto</button>
        )}
        {opts.pick && assignable.length > 0 && (
          <select className="tk-pick" aria-label={`Add issue ${i.title} to sprint`} value="" onChange={(e) => e.target.value && move(i, Number(e.target.value))}>
            <option value="">Add to sprint…</option>
            {assignable.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        )}
        {opts.toBacklog && i.state === 'open' && <button className="tk-x" aria-label={`Move ${i.title} to backlog`} title="Move to backlog" onClick={() => move(i, null)}>&times;</button>}
      </li>
    );
  };

  const list = (items: Issue[], opts: { draggable: boolean; toBacklog: boolean; pick: boolean }, empty: string) => {
    if (items.length === 0) return empty ? <p className="sp-empty">{empty}</p> : null;
    return groupIssues(items, by, modules, owners, issues).map((g) => {
      const src = by === 'module' ? modules.find((m) => String(m.id) === g.key) : by === 'owner' ? owners.find((o) => String(o.id) === g.key) : null;
      const sorted = [...g.issues].sort((a, b) => Number(a.state === 'closed') - Number(b.state === 'closed') || a.id - b.id);
      return (
        <section key={g.key} aria-label={g.label || 'Issues'} className="tk-group">
          {g.label && <h4 style={{ '--c': src?.color ?? 'var(--muted)' } as React.CSSProperties}><i />{g.label}<span>{g.issues.length}</span></h4>}
          <ul className="tk-list">{sorted.map((i) => task(i, opts))}</ul>
        </section>
      );
    });
  };

  // Who carries how much of this sprint: the balance at a glance.
  const workload = (items: Issue[]) => {
    const rows = owners.map((o) => {
      const mine = items.filter((i) => i.ownerId === o.id);
      return { key: String(o.id), name: `${o.icon ? `${o.icon} ` : ''}${o.name}`, color: o.color, open: mine.filter((i) => i.state === 'open').length, done: mine.filter((i) => i.state === 'closed').length };
    }).filter((r) => r.open + r.done > 0);
    const none = items.filter((i) => i.ownerId == null && i.state === 'open').length;
    if (none) rows.push({ key: 'none', name: 'Unassigned', color: null, open: none, done: 0 });
    if (rows.length === 0) return null;
    const max = Math.max(...rows.map((r) => r.open + r.done));
    return (
      <div className="wl" aria-label="Workload">
        {rows.map((r) => (
          <div key={r.key} className={`wl-row${r.key === 'none' ? ' warn' : ''}`} title={`${r.name}: ${r.open} open, ${r.done} done`}>
            <span className="wl-name">{r.name}</span>
            <span className="wl-bar"><i className="d" style={{ width: `${(r.done / max) * 100}%`, background: 'var(--ok, #2e9e5b)' }} /><i style={{ width: `${(r.open / max) * 100}%`, background: r.color ?? 'var(--accent)' }} /></span>
            <span className="wl-n">{r.open + r.done}</span>
          </div>
        ))}
      </div>
    );
  };

  const panel = (s: Sprint) => {
    const items = work.filter((i) => i.sprintId === s.id);
    const total = s.openCount + s.closedCount;
    const pct = total ? Math.round((s.closedCount / total) * 100) : 0;
    const closed = s.state === 'closed';
    const unassigned = items.filter((i) => i.state === 'open' && i.ownerId == null).length;
    return (
      <section key={s.id} className={`sp2 sp2-${s.state}${over === `s${s.id}` ? ' over' : ''}`} aria-label={`Sprint ${s.name}`} {...dropProps(`s${s.id}`, s.id, !closed)}>
        <header className="sp2-head">
          <div className="sp2-title">
            <h3>{s.name}</h3>
            <span className={`sp-state sp-state-${s.state}`}>{s.state}</span>
          </div>
          {!closed && (
            <div className="row">
              {s.state === 'active'
                ? <button onClick={() => { if (window.confirm(`Close sprint "${s.name}"? Its open tasks go back to the backlog and it cannot be reopened.`)) setState(s, 'closed'); }}>Close sprint</button>
                : <button className="primary" disabled={!!active} title={active ? 'Close the active sprint first' : undefined} onClick={() => setState(s, 'active')}>Start sprint</button>}
              {unassigned > 0 && <button onClick={() => act(() => api.autoAssignSprint(s.id))} title="Give every unassigned task the best owner from its module">✨ Auto-assign {unassigned}</button>}
              {s.state === 'active' && items.some((i) => i.state === 'open') && <button onClick={() => { if (window.confirm('Re-deal the open tasks of this sprint? Current owners are replaced by a fresh balanced split.')) act(() => api.autoAssignSprint(s.id, true)); }} title="Clear the owners of open tasks and balance them again">↻ Re-assign</button>}
              {items.some((i) => i.state === 'open') && <button onClick={() => setTimeline(s)} title="Optimal order of work given module dependencies">Timeline</button>}
              <button onClick={() => setEditing(s)}>Edit</button>
            </div>
          )}
        </header>
        {s.goal && <p className="sp2-goal">🎯 {s.goal}</p>}
        <div className="sp2-progress">
          <div className="sp-bar" role="progressbar" aria-label="Progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
          <span><b>{s.closedCount}</b> of {total} done{total > 0 && ` · ${pct}%`}</span>
        </div>
        {workload(items)}
        <div className="sp2-body">{list(items, { draggable: !closed, toBacklog: !closed, pick: false }, closed ? 'Nothing was finished in this sprint.' : 'Drag tasks here from the backlog.')}</div>
      </section>
    );
  };

  return (
    <div className="issues-page sprints-page">
      <div className="row between">
        <h2>Sprints</h2>
        <div className="row">
          <label className="inline">Group by{' '}
            <select aria-label="Group by" value={by} onChange={(e) => setBy(e.target.value as GroupBy)}>
              <option value="module">Module</option><option value="owner">Owner</option><option value="epic">Epic</option><option value="none">Nothing</option>
            </select>
          </label>
          <button className="primary" onClick={() => setEditing('new')}>+ New sprint</button>
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!active && sprints.some((s) => s.state === 'planned') && <p className="hint">No active sprint. Start a planned one.</p>}
      <div className="sp-layout">
        <aside className="sp-side">
          <section className={`sp2 sp2-backlog${over === 'b' ? ' over' : ''}`} aria-label="Backlog" {...dropProps('b', null, true)}>
            <header className="sp2-head"><div className="sp2-title"><h3>Backlog</h3><span className="sp-state">{backlog.length} open</span></div></header>
            <p className="sp2-goal">Work waiting for a sprint</p>
            <div className="sp2-body">{list(backlog, { draggable: true, toBacklog: false, pick: true }, 'Nothing waiting. Every open task is in a sprint.')}</div>
          </section>
          {done.length > 0 && (
            <section className="sp2 sp2-done" aria-label="Done">
              <header className="sp2-head"><div className="sp2-title"><h3>Done</h3><span className="sp-state">{done.length}</span></div></header>
              <p className="sp2-goal">Closed work outside any sprint</p>
              <div className="sp2-body">{list(done, { draggable: false, toBacklog: false, pick: false }, '')}</div>
            </section>
          )}
        </aside>
        <div className="sp-main">
          {live.map(panel)}
          {sprints.length === 0 && <p className="sp-empty">No sprints yet. Create one, then drag tasks into it.</p>}
          {history.length > 0 && (
            <details className="sp-history">
              <summary>History ({history.length} closed)</summary>
              {history.map(panel)}
            </details>
          )}
        </div>
      </div>
      {timeline && <SprintTimeline sprint={timeline} issues={issues} modules={modules} owners={owners} relations={relations} onClose={() => setTimeline(null)} />}
      {editing && <SprintDialog sprint={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onChanged={() => { setEditing(null); onChanged(); }} />}
    </div>
  );
}

function SprintDialog({ sprint, onClose, onChanged }: { sprint: Sprint | null; onClose: () => void; onChanged: () => void }) {
  const init = { name: sprint?.name ?? '', goal: sprint?.goal ?? '' };
  const [f, setF] = useState(init);
  const [confirming, setConfirming] = useState(false);
  const { error, run } = useAction();
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const set = <K extends keyof typeof f>(k: K, v: string) => setF((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: SprintInput = { ...f, state: sprint?.state };
    if (await run(() => (sprint ? api.updateSprint(sprint.id, body) : api.createSprint(body)))) onChanged();
  };
  const del = async () => {
    setConfirming(false);
    if (sprint && (await run(() => api.deleteSprint(sprint.id)))) onChanged();
  };

  return (
    <Modal title={sprint ? `Edit ${sprint.name}` : 'New sprint'} dirty={dirty} onClose={onClose}>
      <form onSubmit={submit}>
        <label>Name<input data-autofocus aria-label="Name" value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label>Goal<textarea aria-label="Goal" rows={2} value={f.goal} onChange={(e) => set('goal', e.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row modal-actions">
          <button type="submit" className="primary">{sprint ? 'Save sprint' : 'Create sprint'}</button>
          {sprint && <button type="button" className="danger" onClick={() => setConfirming(true)}>Delete sprint</button>}
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
      {confirming && sprint && (
        <ConfirmDialog message={`Delete sprint "${sprint.name}"? Its issues return to the backlog.`} onConfirm={del} onCancel={() => setConfirming(false)} />
      )}
    </Modal>
  );
}
