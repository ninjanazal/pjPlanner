import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api } from '../api';
import { groupLabel, subtreeIds } from '../groupBoxes';
import { tally } from '../metrics';
import { randomIcon } from '../randomIcon';
import { groupHash, issueHash } from '../route';
import { STATE_LABEL, type Graph, type Group, type Issue, type Module } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { StateBadge } from './IssuesPage';
import { ColorField, IconField } from './LookFields';
import { Bar, Donut, Kpi, Ring } from './MetricParts';
import { useDirtyGuard } from './Modal';
import { ModulePicker } from './ModulePicker';
import { useAction } from './useAction';

interface Props { group: Group | null; graph: Graph; issues: Issue[]; onChanged: () => void; onOpenModule: (id: number) => void }
interface Form { name: string; color: string | null; icon: string | null; parentId: number | null; moduleIds: number[] }

const chip = (c: string | null) => ({ '--chip-c': c ?? 'var(--border)' } as React.CSSProperties);
const sameForm = (a: Form, b: Form) => JSON.stringify({ ...a, moduleIds: [...a.moduleIds].sort() }) === JSON.stringify({ ...b, moduleIds: [...b.moduleIds].sort() });
const TEST_LABEL = { full: 'Fully tested', partial: 'Partly tested', none: 'No tests' } as const;

// `#/groups/<id>`: one group's page. Statistics on the left, details (name, look, parent, modules) on the right, edited in
// place and saved or discarded together. `group` is null on `#/groups/new`.
export function GroupPage({ group, graph, issues, onChanged, onOpenModule }: Props) {
  const groups = graph.groups ?? [];
  const base: Form = useMemo(() => ({
    name: group?.name ?? '', color: group?.color ?? null, icon: group ? group.icon : randomIcon(), parentId: group?.parentId ?? null,
    moduleIds: group ? graph.modules.filter((m) => m.groupId === group.id).map((m) => m.id) : [],
  }), [group, graph.modules]);
  const [draft, setDraft] = useState<Form | null>(null);
  const [confirm, setConfirm] = useState<'delete' | string | null>(null); // a string is a hash waiting for "discard?"
  const { error, run } = useAction(true);
  const f = draft ?? base;
  const dirty = draft != null && (group == null || !sameForm(draft, base));
  useDirtyGuard(dirty);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setDraft({ ...f, [k]: v });

  const nameRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { const el = nameRef.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; } }, [f.name]);
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveRef.current(); } };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);

  const go = (hash: string) => { if (dirty) setConfirm(hash); else window.location.hash = hash; };
  const link = (hash: string) => ({ href: hash, onClick: (e: React.MouseEvent) => { e.preventDefault(); go(hash); } });
  const leave = (hash: string) => { flushSync(() => { setDraft(null); setConfirm(null); }); window.location.hash = hash; };

  const mods = f.moduleIds.map((id) => graph.modules.find((m) => m.id === id)).filter((m): m is Module => Boolean(m));
  const removed = base.moduleIds.filter((id) => !f.moduleIds.includes(id));
  const added = f.moduleIds.filter((id) => !base.moduleIds.includes(id));
  const blocked = group ? subtreeIds(groups, group.id) : new Set<number>();
  const children = group ? groups.filter((g) => g.parentId === group.id) : [];

  // Everything below is about the saved group: its modules and those of its sub-groups.
  const tree = group ? subtreeIds(groups, group.id) : new Set<number>();
  const all = group ? graph.modules.filter((m) => m.groupId != null && tree.has(m.groupId)) : [];
  const ids = new Set(all.map((m) => m.id));
  const tasks = issues.filter((i) => i.type === 'task' && i.moduleId != null && ids.has(i.moduleId));
  const t = tally(tasks);
  const tests = { full: 0, partial: 0, none: 0, unknown: 0 };
  all.forEach((m) => { tests[m.testStatus ?? 'unknown']++; });
  const open = tasks.filter((i) => i.state !== 'closed').sort((a, b) => a.id - b.id);

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    await run(async () => {
      const look = { name: draft.name, color: draft.color, icon: draft.icon, parentId: draft.parentId };
      const changed = !group || group.name !== look.name || group.color !== look.color || group.icon !== look.icon || (group.parentId ?? null) !== look.parentId;
      const saved = group ? (changed ? await api.updateGroup(group.id, look) : group) : await api.createGroup(look);
      for (const id of [...added, ...removed]) {
        const m = graph.modules.find((x) => x.id === id)!;
        // A module sits in one group, so adding it here moves it out of its old one. Omitted fields stay as they are.
        await api.updateModule(id, { name: m.name, description: m.description, groupId: added.includes(id) ? saved.id : null });
      }
      flushSync(() => setDraft(null));
      if (!group) window.location.hash = groupHash(saved.id);
      onChanged();
    }, 'Group saved');
  };
  saveRef.current = () => { if (dirty && f.name.trim()) void save(); };
  const del = async () => {
    setConfirm(null);
    if (group && (await run(() => api.deleteGroup(group.id), 'Group deleted'))) { flushSync(() => setDraft(null)); window.location.hash = '#/groups'; onChanged(); }
  };

  return (
    <div className="owner-page">
      <nav className="issue-crumbs" aria-label="Group path">
        <a {...link('#/groups')}>Groups</a>
        {group && group.parentId != null && <span><i>/</i><a {...link(groupHash(group.parentId))}>{groupLabel(groups, group.parentId)}</a></span>}
        <span><i>/</i><b>{group ? group.name : 'New group'}</b></span>
      </nav>

      <div className="issue-layout">
        <div className="issue-main">
          <div className="owner-title">
            <span className="owner-big-icon" style={chip(f.color)} data-testid="entity-head">{f.icon ?? (f.name.slice(0, 1).toUpperCase() || '?')}</span>
            <textarea ref={nameRef} className="issue-title-input" aria-label="Name" rows={1} value={f.name} placeholder="Group name"
              onChange={(e) => set('name', e.target.value.replace(/\n/g, ' '))} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
          </div>
          {error && <p className="error" role="alert">{error}</p>}

          {group && (
            <section className="owner-stats" aria-label="Group metrics">
              <div className="stat-hero">
                <Ring pct={t.pct} size={140} stroke={14} label="Group completion">
                  <b className="ring-pct">{t.tasks ? `${t.pct}%` : '–'}</b>
                  <span className="hint">{t.doneSteps} of {t.steps} steps</span>
                </Ring>
                <Donut label="Tasks by state" size={140} stroke={20} center={<><b className="ring-pct">{t.tasks}</b><span className="hint">tasks</span></>} slices={[
                  { label: STATE_LABEL.open, value: t.open, color: 'var(--accent)' },
                  { label: STATE_LABEL.code_review, value: t.codeReview, color: '#d29922' },
                  { label: STATE_LABEL.test_validation, value: t.testValidation, color: '#8957e5' },
                  { label: STATE_LABEL.closed, value: t.closed, color: 'var(--primary-border)' },
                ]} />
              </div>

              <div className="kpis">
                <Kpi label="Modules" value={all.length} hint={all.length > base.moduleIds.length ? `${base.moduleIds.length} directly` : undefined} />
                <Kpi label="Sub-groups" value={children.length} />
                <Kpi label="Steps left" value={t.remainingSteps} />
                <Kpi label="Fully tested" value={`${tests.full}/${all.length}`} hint={tests.none > 0 ? `${tests.none} without tests` : undefined} tone={tests.none > 0 ? 'warn' : undefined} />
              </div>

              <div className="card">
                <h3>Modules</h3>
                {all.length === 0 && <p className="hint">No modules in this group yet. Add some from the details panel.</p>}
                {all.map((m) => {
                  const mt = tally(tasks.filter((i) => i.moduleId === m.id));
                  const sub = m.groupId !== group.id ? groups.find((g) => g.id === m.groupId) : null;
                  return (
                    <div key={m.id} className="metric-row">
                      <div className="row between">
                        <button type="button" className="chip-link" aria-label={`Open module ${m.name}`} onClick={() => onOpenModule(m.id)}>{m.icon} {m.name}</button>
                        <span className="hint">
                          {sub ? `${sub.name} · ` : ''}{m.testStatus ? TEST_LABEL[m.testStatus] : 'tests unknown'} · {mt.closed}/{mt.tasks} tasks · {mt.remainingSteps} steps left
                        </span>
                      </div>
                      <Bar pct={mt.pct} label={`${m.name} completion`} />
                    </div>
                  );
                })}
              </div>

              <div className="card">
                <h3>Open tasks</h3>
                {open.length === 0 && <p className="hint">{tasks.length === 0 ? 'No tasks on these modules yet.' : 'Every task is closed.'}</p>}
                <ul className="child-list">
                  {open.map((i) => {
                    const m = graph.modules.find((x) => x.id === i.moduleId);
                    return (
                      <li key={i.id}>
                        <span className="hint">#{i.id}</span>
                        <a className="child-title" {...link(issueHash(i.id))}>{i.title}</a>
                        {m && <span className="chip" style={chip(m.color)}>{m.icon} {m.name}</span>}
                        <StateBadge state={i.state} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          )}
          {!group && <p className="hint">Statistics appear once the group exists and has modules with tasks.</p>}
        </div>

        <aside className="issue-side">
          <div className="details">
            <h3>Details</h3>
            <div className="detail stack"><span className="detail-label">Colour</span><div className="detail-value"><ColorField value={f.color} onChange={(c) => set('color', c)} /></div></div>
            <div className="detail stack"><span className="detail-label">Icon</span><div className="detail-value"><IconField value={f.icon} onChange={(i) => set('icon', i)} /></div></div>
            <div className="detail stack"><span className="detail-label">Parent group</span>
              <div className="detail-value">
                <select aria-label="Parent group" value={f.parentId ?? ''} onChange={(e) => set('parentId', e.target.value ? Number(e.target.value) : null)}>
                  <option value="">None (top level)</option>
                  {groups.filter((g) => !blocked.has(g.id)).map((g) => <option key={g.id} value={g.id}>{groupLabel(groups, g.id)}</option>)}
                </select>
              </div>
            </div>
            {children.length > 0 && (
              <div className="detail stack"><span className="detail-label">Sub-groups ({children.length})</span>
                <div className="detail-value row wrap">
                  {children.map((c) => (
                    <a key={c.id} className="chip" style={chip(c.color)} aria-label={`Open group ${c.name}`} {...link(groupHash(c.id))}>{c.icon ?? '▫'} {c.name}</a>
                  ))}
                </div>
              </div>
            )}
            <div className="detail stack"><span className="detail-label">Modules ({mods.length})</span>
              <div className="detail-value">
                {mods.length === 0 && <p className="hint">No modules in this group. Add one below.</p>}
                <div className="row wrap">
                  {mods.map((m) => (
                    <span key={m.id} className="chip chip-x" style={chip(m.color)}>
                      <button type="button" className="chip-link" aria-label={`Open module ${m.name}`} onClick={() => onOpenModule(m.id)}>{m.icon} {m.name}</button>
                      <button type="button" className="chip-remove" aria-label={`Remove module ${m.name}`} title="Remove from group" onClick={() => set('moduleIds', f.moduleIds.filter((x) => x !== m.id))}>×</button>
                    </span>
                  ))}
                </div>
                <ModulePicker label="Add module" placeholder="Add a module…" modules={graph.modules.filter((m) => !f.moduleIds.includes(m.id))} value={null} required
                  onChange={(id) => { if (id != null) set('moduleIds', [...f.moduleIds, id]); }} />
                <p className="hint">A module is in one group, so adding one moves it out of its current group.</p>
              </div>
            </div>
          </div>
          {group && <button type="button" className="ghost-danger" onClick={() => setConfirm('delete')}>Delete group</button>}
        </aside>
      </div>

      {(dirty || !group) && (
        <div className="save-bar" role="region" aria-label="Unsaved changes">
          <span>{group ? 'You have unsaved changes' : 'New group'}</span>
          <span className="spacer" />
          <button type="button" onClick={() => { if (group) setDraft(null); else go('#/groups'); }}>{group ? 'Discard' : 'Cancel'}</button>
          <button type="button" className="primary" disabled={!f.name.trim() || (group != null && !dirty)} onClick={() => saveRef.current()}>{group ? 'Save changes' : 'Create group'}</button>
        </div>
      )}

      {confirm === 'delete' && group && (
        <ConfirmDialog message={`Delete group "${group.name}"? Its child groups move up one level, its ${base.moduleIds.length} module(s) become ungrouped, and no modules are deleted.`} onConfirm={del} onCancel={() => setConfirm(null)} />
      )}
      {typeof confirm === 'string' && confirm.startsWith('#') && (
        <ConfirmDialog title="Discard changes?" message="You have unsaved edits. Leaving now will discard them." confirmLabel="Discard" cancelLabel="Keep editing"
          onConfirm={() => leave(confirm)} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}
