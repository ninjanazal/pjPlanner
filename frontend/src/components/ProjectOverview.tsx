import { useMemo, useState } from 'react';
import { formatDuration, projectMetrics, tally, timeMetrics } from '../metrics';
import { ownerHash } from '../route';
import type { Graph, Issue, Project, Sprint } from '../types';
import { Bar, Donut, Kpi, PairBars, Ring } from './MetricParts';

interface Props { project: Project | null; graph: Graph; issues: Issue[]; sprints: Sprint[] }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const chip = (c: string | null) => ({ '--chip-c': c ?? 'var(--border)' } as React.CSSProperties);
const STATE_COLORS = { open: 'var(--accent)', review: '#d29922', validation: '#8957e5', closed: 'var(--primary-border)' };

// Metrics of the current project, shown graphically: completion, task states, sprint progress, achievements,
// work done per owner and a module heat map. Numbers only: nothing here asks for action.
export function ProjectOverview({ project, graph, issues, sprints }: Props) {
  const m = useMemo(() => projectMetrics(issues, graph.owners, graph.modules, sprints, graph.relations), [issues, graph, sprints]);
  const tm = useMemo(() => timeMetrics(issues, graph.owners, graph.modules), [issues, graph.owners, graph.modules]);
  const work = useMemo(() => graph.owners.map((owner) => ({ owner, t: tally(issues.filter((i) => i.type === 'task' && i.ownerId === owner.id)) }))
    .sort((a, b) => a.owner.name.localeCompare(b.owner.name)), [issues, graph.owners]);
  const overloaded = m.owners.filter((o) => o.overloaded);
  const openBugs = m.byType.bug.total - m.byType.bug.closed;
  const finished = m.tasks.tasks > 0 && m.tasks.pct === 100;
  const active = m.sprints.find((s) => s.sprint.state === 'active');

  return (
    <div className="overview-page">
      <section className="hero" aria-label="Project summary">
        <Ring pct={m.tasks.pct} label="Project completion" size={168} stroke={16}>
          <b className="ring-pct">{m.tasks.pct}%</b>
          <span className="hint">{m.tasks.doneSteps} of {m.tasks.steps} steps done</span>
        </Ring>
        <div className="hero-main">
          <h2>{project?.name ?? 'Project'}</h2>
          {project?.description && <p className="hint">{project.description}</p>}
          <p className="hero-line">
            <strong>{m.tasks.closed}</strong> of <strong>{m.tasks.tasks}</strong> tasks closed · <strong>{m.tasks.remainingSteps}</strong> steps to go
          </p>
          {finished && <p className="celebrate" role="status">🎉 Every task is done. Well played!</p>}
        </div>
      </section>

      <div className="kpis">
        <Kpi label="Open tasks" value={m.tasks.open + m.tasks.codeReview + m.tasks.testValidation} hint={`${m.tasks.closed} closed`} />
        <Kpi label="Steps remaining" value={m.tasks.remainingSteps} />
        <Kpi label="In review / validation" value={m.inFlight} hint="work in flight" />
        <Kpi label="Open bugs" value={openBugs} tone={openBugs > 0 ? 'warn' : 'good'} hint={`${m.byType.bug.closed} squashed`} />
        <Kpi label="Modules" value={graph.modules.length} hint={plural(graph.owners.length, 'owner')} />
      </div>

      <div className="overview-grid">
        <section className="card" aria-label="Task states">
          <h3>Task board</h3>
          <Donut label="Tasks by state" center={<><b className="ring-pct">{m.tasks.tasks}</b><span className="hint">tasks</span></>} slices={[
            { label: 'Open', value: m.tasks.open, color: STATE_COLORS.open },
            { label: 'Code review', value: m.tasks.codeReview, color: STATE_COLORS.review },
            { label: 'Test validation', value: m.tasks.testValidation, color: STATE_COLORS.validation },
            { label: 'Closed', value: m.tasks.closed, color: STATE_COLORS.closed },
          ]} />
        </section>

        <SprintsCard sprints={m.sprints} />
      </div>

      <div className="kpis" aria-label="Coverage">
        <Kpi label="Open tasks without owner" value={m.unassignedOpen} tone={m.unassignedOpen > 0 ? 'warn' : 'good'} />
        <Kpi label="Open tasks not in a sprint" value={m.backlogOpen} />
        <Kpi label="Open tasks without estimate" value={m.unestimatedOpen} />
        <Kpi label="Overloaded owners" value={overloaded.length} tone={overloaded.length > 0 ? 'warn' : 'good'} />
      </div>

      <section className="card" aria-label="Speed">
        <h3>Speed</h3>
        {tm.closedCount === 0 && <p className="hint">Timing starts with the first task closed in pjPlanner. Times fill in as tasks are closed.</p>}
        <div className="kpis">
          <Kpi label="Avg lead time" value={formatDuration(tm.avgLeadMs)} hint="created to closed" />
          <Kpi label="Median lead time" value={formatDuration(tm.medianLeadMs)} />
          <Kpi label="Avg time per step" value={formatDuration(tm.msPerStep)} hint="size-fair speed" />
          <Kpi label="Avg work time" value={formatDuration(tm.avgWorkMs)} hint="review start to closed" />
          <Kpi label="Reopen rate" value={`${Math.round(tm.reopenRate * 100)}%`} hint={`${tm.reopenedTasks} task${tm.reopenedTasks === 1 ? '' : 's'} reopened`} tone={tm.reopenRate > 0.2 ? 'warn' : undefined} />
          <Kpi label="Avg age of open tasks" value={formatDuration(tm.avgOpenAgeMs)} hint={tm.oldestOpen ? `oldest: ${formatDuration(tm.oldestOpen.ageMs)} (#${tm.oldestOpen.issue.id})` : undefined} />
        </div>
        <h4 className="group-title">Created vs closed per week <span className="hint">(this week {tm.thisWeek} closed, last week {tm.lastWeek})</span></h4>
        <PairBars label="Tasks per week" aLabel="Created" bLabel="Closed"
          data={tm.weeks.map((w) => ({ label: new Date(w.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), a: w.created, b: w.closed }))} />
      </section>

      <section className="card" aria-label="Highlights">
        <h3>Highlights</h3>
        <div className="highlights">
          {[
            { key: 'hot', title: 'Hottest module', m: tm.modules.find((x) => x.hottest), note: (x: typeof tm.modules[number]) => `${x.closedRecent} closed, ${x.touchedRecent} touched in 14 days` },
            { key: 'cold', title: 'Coldest module', m: tm.modules.find((x) => x.coldest), note: (x: typeof tm.modules[number]) => `${x.open} open, untouched for ${x.idleDays} days` },
            { key: 'quick', title: 'Resolves fastest', m: tm.modules.find((x) => x.quickest), note: (x: typeof tm.modules[number]) => `${formatDuration(x.msPerStep)} per step · ${x.count} closed` },
            { key: 'slow', title: 'Resolves slowest', m: tm.modules.find((x) => x.slowest), note: (x: typeof tm.modules[number]) => `${formatDuration(x.msPerStep)} per step · ${x.count} closed` },
          ].map(({ key, title, m: mod, note }) => (
            <div key={key} className={`highlight hl-${key}`}>
              <span className="kpi-label">{title}</span>
              <b>{mod ? `${mod.module.icon ?? ''} ${mod.module.name}`.trim() : '–'}</b>
              <span className="hint">{mod ? note(mod) : 'not enough data yet'}</span>
            </div>
          ))}
          {(() => {
            const f = tm.owners.find((x) => x.fastest);
            return (
              <div className="highlight hl-owner">
                <span className="kpi-label">Fastest owner</span>
                <b>{f ? `${f.owner.icon ?? ''} ${f.owner.name}`.trim() : '–'}</b>
                <span className="hint">{f ? `${formatDuration(f.msPerStep)} per step · ${f.count} closed` : 'needs 2 owners with 2 closed tasks each'}</span>
              </div>
            );
          })()}
        </div>
      </section>

      <section className="card" aria-label="Owner speed">
        <h3>Owner speed <span className="hint">(time per step, lower is faster)</span></h3>
        {tm.owners.length === 0 && <p className="hint">No owners yet.</p>}
        {tm.owners.map((r) => {
          const worst = Math.max(1, ...tm.owners.map((x) => (Number.isFinite(x.msPerStep) ? x.msPerStep : 0)));
          return (
            <div key={r.owner.id} className="metric-row">
              <div className="row between">
                <span><strong>{r.owner.name}</strong>{r.fastest && <span className="tag">Fastest</span>}</span>
                <span className="hint">
                  {r.count === 0 ? 'no closed tasks yet' : `${formatDuration(r.msPerStep)} per step · avg ${formatDuration(r.avgLeadMs)} · ${r.count} closed${r.reopens ? ` · ${r.reopens} reopened` : ''}`}
                </span>
              </div>
              <Bar pct={Number.isFinite(r.msPerStep) ? (r.msPerStep / worst) * 100 : 0} label={`${r.owner.name} time per step`} />
            </div>
          );
        })}
      </section>

      <section className="card" aria-label="Work by owner">
        <h3>Work by owner</h3>
        {work.length === 0 && <p className="hint">No owners yet.</p>}
        {work.map(({ owner, t }) => (
          <div key={owner.id} className="rank-row">
            <span className="avatar" style={chip(owner.color)}>{owner.icon || owner.name.slice(0, 1).toUpperCase()}</span>
            <div className="rank-main">
              <div className="rank-head"><a href={ownerHash(owner.id)}><strong>{owner.name}</strong></a></div>
              <div className="rank-stats">
                <span>{t.closed} of {plural(t.tasks, 'task')} done</span>
                <span>{t.doneSteps} of {t.steps} steps done</span>
                <span>{t.remainingSteps} steps left</span>
              </div>
              <Bar pct={t.pct} label={`${owner.name} completion`} />
            </div>
          </div>
        ))}
      </section>

      <section className="card" aria-label="Module map">
        <h3>Module map</h3>
        {graph.modules.length === 0 && <p className="hint">No modules yet.</p>}
        <div className="heat">
          {m.modules.map(({ module, tally, dependents }) => {
            const t = tm.modules.find((x) => x.module.id === module.id)!;
            return (
            <div key={module.id} className="heat-tile"
              style={{ background: `color-mix(in srgb, var(--primary-border) ${tally.tasks ? Math.max(8, tally.pct) * 0.6 : 0}%, var(--surface))` }}>
              <strong className="heat-name">{module.icon} {module.name}</strong>
              <span className="heat-pct">{tally.tasks ? `${tally.pct}%` : '–'}</span>
              <span className="heat-line">{tally.tasks === 0 ? 'No tasks yet' : `${tally.closed} of ${tally.tasks} tasks done`}</span>
              {tally.tasks > 0 && <span className="heat-line">{tally.remainingSteps} steps left</span>}
              {t.count > 0 && <span className="heat-line">{formatDuration(t.msPerStep)} per step · avg {formatDuration(t.avgLeadMs)}</span>}
              {t.open > 0 && t.idleDays > 0 && <span className="heat-line">idle {t.idleDays} d</span>}
              <span className="heat-tags">
                {t.hottest && <span className="badge hot">hottest</span>}
                {t.coldest && <span className="badge cold">coldest</span>}
                {t.quickest && <span className="badge">fastest</span>}
                {t.slowest && <span className="badge">slowest</span>}
                {dependents > 0 && <span className="badge">{dependents} depend{dependents === 1 ? 's' : ''} on it</span>}
              </span>
            </div>
            );
          })}
        </div>
        <p className="hint">Greener means more done. A dashed border means nobody owns the module.</p>
      </section>

      {m.epics.length > 0 && (
        <section className="card" aria-label="Epics">
          <h3>Epics</h3>
          <div className="epic-rings">
            {m.epics.map(({ issue, tally }) => (
              <a key={issue.id} href={`#/issues/${issue.id}`} className="epic-ring" aria-label={`#${issue.id} ${issue.title}`}>
                <Ring pct={tally.pct} size={84} stroke={9} label={`${issue.title} progress`}><b>{tally.tasks === 0 ? '–' : `${tally.pct}%`}</b></Ring>
                <span className="epic-name">#{issue.id} {issue.title}</span>
                <span className="hint">{tally.tasks === 0 ? 'no tasks yet' : `${tally.closed}/${tally.tasks} tasks`}</span>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}


type SprintRow = ReturnType<typeof projectMetrics>['sprints'][number];
const STATE_ORDER = { active: 0, planned: 1, closed: 2 } as const;
const SHOWN = 4;

// Active sprint first, then planned, then closed. Sprints with no tasks yet fold into one line, and long lists
// start collapsed so the card stays the height of its neighbour.
function SprintsCard({ sprints }: { sprints: SprintRow[] }) {
  const [all, setAll] = useState(false);
  const ordered = [...sprints].sort((a, b) => STATE_ORDER[a.sprint.state] - STATE_ORDER[b.sprint.state] || a.sprint.id - b.sprint.id);
  const filled = ordered.filter((r) => r.tally.tasks > 0 || r.sprint.state === 'active');
  const empty = ordered.filter((r) => !filled.includes(r));
  const rows = all ? filled : filled.slice(0, SHOWN);
  const counts = (['active', 'planned', 'closed'] as const).map((st) => [st, sprints.filter((x) => x.sprint.state === st).length] as const).filter(([, n]) => n > 0);
  return (
    <section className="card" aria-label="Sprints">
      <div className="row between">
        <h3>Sprints</h3>
        {counts.length > 0 && <span className="hint">{counts.map(([st, n]) => `${n} ${st}`).join(' · ')}</span>}
      </div>
      {sprints.length === 0 && <p className="hint">No sprints yet.</p>}
      <div className="sprint-list">
        {rows.map(({ sprint, tally }) => (
          <div key={sprint.id} className="sprint-item">
            <div className="sprint-head">
              <strong>{sprint.name}{sprint.state === 'active' ? ' (active)' : ''}</strong>
              <span className={`sprint-state st-${sprint.state}`}>{sprint.state}</span>
              <span className="hint sprint-stats">{tally.closed}/{tally.tasks} tasks · {tally.doneSteps}/{tally.steps} steps · {tally.pct}%</span>
            </div>
            <Bar pct={tally.pct} label={`${sprint.name} progress`} />
          </div>
        ))}
      </div>
      {empty.length > 0 && (
        <p className="hint sprint-empty" title={empty.map((r) => r.sprint.name).join(', ')}>
          {empty.length === 1 ? `${empty[0].sprint.name} has` : `${empty.length} more sprints have`} no tasks yet
        </p>
      )}
      {filled.length > SHOWN && (
        <button type="button" className="sprint-toggle" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${filled.length}`}
        </button>
      )}
    </section>
  );
}
