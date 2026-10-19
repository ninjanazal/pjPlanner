import { useState } from 'react';
import type { Issue, Module, Owner, Relation, Sprint } from '../types';
import { buildTimeline, criticalPath, laneGaps } from '../sprintTimeline';
import { Modal } from './Modal';

interface Props { sprint: Sprint; issues: Issue[]; modules: Module[]; owners: Owner[]; relations: Relation[]; onClose: () => void }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function SprintTimeline({ sprint, issues, modules, owners, relations, onClose }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);
  const tasks = issues.filter((i) => i.type === 'task' && i.sprintId === sprint.id);
  const tl = buildTimeline(tasks, modules, relations);
  const crit = criticalPath(tl);
  const gaps = laneGaps(tl);
  const lost = tl.length - tl.idealLength;
  const closed = tasks.filter((t) => t.state === 'closed');
  // Closed tasks are not scheduled; they sit in a Done column before step 1, one lane per owner (owners with only closed tasks get a lane too).
  const lanes = [...new Set([...tl.lanes, ...closed.map((t) => t.ownerId)])].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  const off = closed.length ? 3 : 2;
  // While hovering a card: it, what it waits for and what waits on it stay lit, the rest dims.
  const linked = hovered == null ? null : new Set([
    hovered,
    ...(tl.slots.find((s) => s.issue.id === hovered)?.waitsFor ?? []),
    ...tl.slots.filter((s) => s.waitsFor.includes(hovered)).map((s) => s.issue.id),
  ]);
  return (
    <Modal title={`Timeline · ${sprint.name}`} onClose={onClose} size="xl">
      {tasks.length === 0 ? <p className="sp-empty">No tasks in this sprint.</p> : (
        <>
          <div className="tlx-stats">
            <div><b>{tl.length}</b><span>steps to finish</span></div>
            <div><b>{tl.idealLength}</b><span>busiest owner alone</span></div>
            <div className={lost > 0 ? 'warn' : ''}><b>{lost}</b><span>{lost > 0 ? 'lost to dependencies' : 'no dependency delay'}</span></div>
            <div><b>{tl.slots.length}</b><span>open tasks · {plural(tl.lanes.length, 'owner')}</span></div>
            {closed.length > 0 && <div><b>{closed.length}</b><span>done</span></div>}
          </div>
          <details className="hint">
            <summary>How is this computed?</summary>
            A task takes its estimate in steps (1 if unset). It starts once the open tasks of the modules it depends on are done, and each owner works one task at a time,
            starting first whatever unblocks the most work. Hover a task to see what it waits for and what waits on it.
          </details>
          <div className="tlx-legend"><span className="tlx-key crit" /> Critical path (sets the finish) <span className="tlx-key idle" /> Waiting on a dependency</div>
          <div className="tlx-scroll">
            <div className="tlx" role="table" aria-label="Sprint timeline" style={{ gridTemplateColumns: `max-content${closed.length ? ' max-content' : ''} repeat(${tl.length}, minmax(4.5rem, 1fr))` }}>
              <div className="tlx-h tlx-corner">Owner · step</div>
              {closed.length > 0 && <div className="tlx-h">Done</div>}
              {Array.from({ length: tl.length }, (_, s) => <div key={s} className="tlx-h">{s + 1}</div>)}
              {lanes.map((lane, row) => {
                const o = owners.find((x) => x.id === lane);
                const mine = tl.slots.filter((x) => x.lane === lane);
                const load = mine.reduce((n, s) => n + s.length, 0);
                const done = closed.filter((t) => t.ownerId === lane);
                const r = row + 2;
                return [
                  <div key={`b${lane}`} className={`tlx-row${row % 2 ? ' odd' : ''}`} style={{ gridRow: r, gridColumn: `1 / span ${tl.length + off - 1}` }} />,
                  <div key={`l${lane}`} className="tlx-lane" style={{ '--c': o?.color ?? 'var(--muted)', gridRow: r, gridColumn: 1 } as React.CSSProperties}>
                    <span>{o ? `${o.icon ?? ''} ${o.name}` : 'Unassigned'}</span>
                    <small>{plural(load, 'step')} · {tl.length ? Math.round((load / tl.length) * 100) : 0}% busy</small>
                  </div>,
                  closed.length > 0 && (
                    <div key={`d${lane}`} className="tlx-done" style={{ gridRow: r, gridColumn: 2 }}>
                      {done.map((t) => <span key={t.id} className="tlx-done-item" title={`#${t.id} ${t.title}`}>✓ #{t.id} {t.title}</span>)}
                    </div>
                  ),
                  ...gaps.filter((g) => g.lane === lane).map((g) => (
                    <div key={`g${lane}-${g.start}`} className="tlx-idle" style={{ gridRow: r, gridColumn: `${g.start + off} / span ${g.length}` }}>waiting</div>
                  )),
                  ...mine.map((slot) => {
                    const m = modules.find((x) => x.id === slot.issue.moduleId);
                    const cls = ['tlx-task', crit.has(slot.issue.id) && 'crit', linked && (linked.has(slot.issue.id) ? 'lit' : 'dim')].filter(Boolean).join(' ');
                    return (
                      <div key={slot.issue.id} className={cls} style={{ '--c': m?.color ?? 'var(--border)', gridRow: r, gridColumn: `${slot.start + off} / span ${slot.length}` } as React.CSSProperties}
                        title={`#${slot.issue.id} ${slot.issue.title}\n${slot.waitsFor.length ? `Waits for ${slot.waitsFor.map((d) => `#${d}`).join(', ')}` : 'Can start right away'}`}
                        onMouseEnter={() => setHovered(slot.issue.id)} onMouseLeave={() => setHovered(null)}>
                        <span className="tlx-title">{slot.issue.title}</span>
                        <small>
                          #{slot.issue.id}
                          {m && <span className="tlx-mod"><i />{m.icon ?? ''} {m.name}</span>}
                          {slot.length > 1 && <span>{slot.length} steps</span>}
                          {slot.waitsFor.length > 0 && <span className="tlx-after">⏳ after {slot.waitsFor.map((d) => `#${d}`).join(' ')}</span>}
                        </small>
                      </div>
                    );
                  }),
                ];
              })}
            </div>
          </div>
          {tl.lanes.includes(null) && <p className="hint">Unassigned tasks are shown as one person; assign owners to see the real split.</p>}
        </>
      )}
    </Modal>
  );
}
