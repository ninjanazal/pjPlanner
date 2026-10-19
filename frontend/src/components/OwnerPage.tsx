import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api } from '../api';
import { formatDuration, ownerMetrics, ownerWeeks, tally, timeMetrics } from '../metrics';
import { randomIcon } from '../randomIcon';
import { issueHash, ownerHash } from '../route';
import { withOwner } from '../sprintGroups';
import { STATE_LABEL, type Graph, type Issue, type Module, type Owner, type Sprint } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { StateBadge } from './IssuesPage';
import { ColorField, IconField } from './LookFields';
import { Bar, Donut, Kpi, PairBars, Ring } from './MetricParts';
import { useDirtyGuard } from './Modal';
import { ModulePicker } from './ModulePicker';
import { useAction } from './useAction';

interface Props {
  owner: Owner | null; graph: Graph; issues: Issue[]; sprints: Sprint[]; onChanged: () => void; onOpenModule: (id: number) => void;
}

interface Form { name: string; color: string | null; icon: string | null }

const isOpen = (i: Issue) => i.state !== 'closed';
const steps = (i: Issue) => i.estimate ?? 1;
const chip = (c: string | null) => ({ '--chip-c': c ?? 'var(--border)' } as React.CSSProperties);
const sameForm = (a: Form, b: Form) => JSON.stringify(a) === JSON.stringify(b);

// `#/owners/<id>`: one owner's page. Statistics on the left, details (name, look, modules) on the right, all edited in
// place and saved or discarded together. `owner` is null on `#/owners/new`.
export function OwnerPage({ owner, graph, issues, sprints, onChanged, onOpenModule }: Props) {
  const base: Form = useMemo(() => ({
    name: owner?.name ?? '', color: owner?.color ?? null, icon: owner ? owner.icon : randomIcon(),
  }), [owner]);
  const [draft, setDraft] = useState<Form | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | string | null>(null); // a string is a hash waiting for "discard?"
  const { error, run } = useAction(true);
  const f = draft ?? base;
  const dirty = draft != null && (owner == null || !sameForm(draft, base));
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

  const mine = owner ? issues.filter((i) => i.type === 'task' && i.ownerId === owner.id) : [];

  const stats = owner ? ownerMetrics(issues, graph.owners, graph.modules, sprints, owner.id) : null;
  const time = useMemo(() => (owner ? timeMetrics(issues, graph.owners, graph.modules) : null), [owner, issues, graph.owners, graph.modules]);
  const speed = owner && time ? time.owners.find((r) => r.owner.id === owner.id) ?? null : null;
  const weeks = owner ? ownerWeeks(issues, owner.id) : [];
  const t = stats?.tally ?? tally([]);
  // How much faster (+) or slower (-) than the whole team, per step.
  const vsTeam = speed && time && speed.count > 0 && Number.isFinite(time.msPerStep) && time.msPerStep > 0 ? Math.round(((time.msPerStep - speed.msPerStep) / time.msPerStep) * 100) : null;
  const sprintTitle = (s: Sprint) => `${s.name} (${s.state})`;
  const visible = mine.filter((i) => showClosed || isOpen(i)).sort((a, b) => a.id - b.id);
  const groups = [
    ...[...sprints.filter((s) => s.state === 'active'), ...sprints.filter((s) => s.state === 'planned'), ...sprints.filter((s) => s.state === 'closed')]
      .map((s) => ({ key: `s${s.id}`, title: sprintTitle(s), items: visible.filter((i) => i.sprintId === s.id) })),
    { key: 'backlog', title: 'Backlog', items: visible.filter((i) => i.sprintId == null || !sprints.some((s) => s.id === i.sprintId)) },
  ].filter((g) => g.items.length > 0);

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    setConfirm(null);
    await run(async () => {
      const look = { name: draft.name, color: draft.color, icon: draft.icon };
      const saved = owner ? (owner.name !== look.name || owner.color !== look.color || owner.icon !== look.icon ? await api.updateOwner(owner.id, look) : owner) : await api.createOwner(look);
      flushSync(() => setDraft(null));
      if (!owner) window.location.hash = ownerHash(saved.id);
      onChanged();
    }, 'Owner saved');
  };
  saveRef.current = () => { if (dirty && f.name.trim()) void save(); };
  const del = async () => {
    setConfirm(null);
    if (owner && (await run(() => api.deleteOwner(owner.id), 'Owner deleted'))) { flushSync(() => setDraft(null)); window.location.hash = '#/owners'; onChanged(); }
  };

  return (
    <div className="owner-page">
      <nav className="issue-crumbs" aria-label="Owner path">
        <a {...link('#/owners')}>Owners</a><span><i>/</i><b>{owner ? owner.name : 'New owner'}</b></span>
      </nav>

      <div className="issue-layout">
        <div className="issue-main">
          <div className="owner-title">
            <span className="owner-big-icon" style={chip(f.color)} data-testid="entity-head">{f.icon ?? (f.name.slice(0, 1).toUpperCase() || '?')}</span>
            <textarea ref={nameRef} className="issue-title-input" aria-label="Name" rows={1} value={f.name} placeholder="Owner name"
              onChange={(e) => set('name', e.target.value.replace(/\n/g, ' '))} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
          </div>
          {error && <p className="error" role="alert">{error}</p>}

          {owner && stats && (
            <section className="owner-stats" aria-label="Owner metrics">
              <div className="stat-hero">
                <Ring pct={t.pct} size={140} stroke={14} label="Owner completion">
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
                <Kpi label="Steps left" value={t.remainingSteps} hint={stats.activeSprintName ? `${stats.activeSprintSteps} in ${stats.activeSprintName}` : 'no sprint running'} />
                <Kpi label="Share of team load" value={`${Math.round(stats.share * 100)}%`} hint={stats.overloaded ? 'well above average' : 'of remaining steps'} tone={stats.overloaded ? 'warn' : undefined} />
                <Kpi label="Load rank" value={`#${stats.rank}`} hint={`of ${stats.ownerCount} owners`} />
                <Kpi label="Avg task size" value={stats.avgSteps} hint="steps per task" />
                <Kpi label="Avg lead time" value={speed && speed.count ? formatDuration(speed.avgLeadMs) : '–'} hint={speed && speed.count ? `${speed.count} closed` : 'no closed tasks yet'} />
                <Kpi label="Time per step" value={speed && speed.count ? formatDuration(speed.msPerStep) : '–'}
                  hint={vsTeam == null ? 'lower is faster' : vsTeam >= 0 ? `${vsTeam}% faster than the team` : `${-vsTeam}% slower than the team`} tone={vsTeam != null && vsTeam > 0 ? 'good' : vsTeam != null && vsTeam < 0 ? 'warn' : undefined} />
                <Kpi label="Reopened" value={speed?.reopens ?? 0} hint="tasks sent back" tone={(speed?.reopens ?? 0) > 0 ? 'warn' : undefined} />
                <Kpi label="Fastest on team" value={speed?.fastest ? 'Yes' : 'No'} hint="needs 2 closed tasks each" tone={speed?.fastest ? 'good' : undefined} />
              </div>

              <div className="card">
                <h3>Closed per week</h3>
                <PairBars label="Closed per week" aLabel="Tasks" bLabel="Steps"
                  data={weeks.map((w) => ({ label: new Date(w.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), a: w.closed, b: w.steps }))} />
              </div>

              {stats.perModule.length > 0 && (
                <div className="card">
                  <h3>By module</h3>
                  {stats.perModule.map(({ module: mo, tally: mt }) => (
                    <div key={mo.id} className="metric-row">
                      <div className="row between"><span>{mo.icon} {mo.name}</span><span className="hint">{mt.closed}/{mt.tasks} tasks · {mt.remainingSteps} steps left</span></div>
                      <Bar pct={mt.pct} label={`${mo.name} completion`} />
                    </div>
                  ))}
                </div>
              )}

              <div className="card">
                <div className="row between"><h3>Tasks</h3><label className="check"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />Show closed tasks</label></div>
                {groups.length === 0 && <p className="hint">{mine.length === 0 ? 'No tasks assigned yet. Tasks are assigned when their sprint starts.' : 'No unfinished tasks.'}</p>}
                {groups.map((g) => (
                  <div key={g.key}>
                    <h4 className="group-title">{g.title}</h4>
                    <ul className="child-list">
                      {g.items.map((i) => {
                        const m = graph.modules.find((x) => x.id === i.moduleId);
                        return (
                          <li key={i.id}>
                            <span className="hint">#{i.id}</span>
                            <a className="child-title" {...link(issueHash(i.id))}>{i.title}</a>
                            {m && <span className="chip" style={chip(m.color)}>{m.icon} {m.name}</span>}
                            <span className="hint">{steps(i)} step{steps(i) === 1 ? '' : 's'}</span>
                            <StateBadge state={i.state} />
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}
          {!owner && <p className="hint">Statistics appear once the owner exists and has tasks.</p>}
        </div>

        <aside className="issue-side">
          <div className="details">
            <h3>Details</h3>
            <div className="detail stack"><span className="detail-label">Colour</span><div className="detail-value"><ColorField value={f.color} onChange={(c) => set('color', c)} /></div></div>
            <div className="detail stack"><span className="detail-label">Icon</span><div className="detail-value"><IconField value={f.icon} onChange={(i) => set('icon', i)} /></div></div>
            {owner && (
              <div className="detail stack"><span className="detail-label">Experience ({stats?.experience.length ?? 0})</span>
                <div className="detail-value">
                  {(stats?.experience.length ?? 0) === 0 && <p className="hint">No closed tasks in any module yet.</p>}
                  <div className="row wrap">
                    {stats?.experience.map(({ module: m, closed }) => (
                      <span key={m.id} className="chip" style={chip(m.color)} title={`${closed} task${closed === 1 ? '' : 's'} closed in ${m.name}`}>
                        <button type="button" className="chip-link" aria-label={`Open module ${m.name}`} onClick={() => onOpenModule(m.id)}>{m.icon} {m.name} · {closed}</button>
                      </span>
                    ))}
                  </div>
                  <small className="hint">The more tasks someone closed in a module, the more likely auto-assign picks them for it.</small>
                </div>
              </div>
            )}
          </div>
          {owner && <button type="button" className="ghost-danger" onClick={() => setConfirm('delete')}>Delete owner</button>}
        </aside>
      </div>

      {(dirty || !owner) && (
        <div className="save-bar" role="region" aria-label="Unsaved changes">
          <span>{owner ? 'You have unsaved changes' : 'New owner'}</span>
          <span className="spacer" />
          <button type="button" onClick={() => { if (owner) setDraft(null); else go('#/owners'); }}>{owner ? 'Discard' : 'Cancel'}</button>
          <button type="button" className="primary" disabled={!f.name.trim() || (owner != null && !dirty)} onClick={() => saveRef.current()}>{owner ? 'Save changes' : 'Create owner'}</button>
        </div>
      )}

      {confirm === 'delete' && owner && (
        <ConfirmDialog message={`Delete owner "${owner.name}"? Their tasks become unassigned.`} onConfirm={del} onCancel={() => setConfirm(null)} />
      )}
      {typeof confirm === 'string' && confirm.startsWith('#') && (
        <ConfirmDialog title="Discard changes?" message="You have unsaved edits. Leaving now will discard them." confirmLabel="Discard" cancelLabel="Keep editing"
          onConfirm={() => leave(confirm)} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}
