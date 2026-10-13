import type { Issue, Module, Owner, Relation, Sprint } from '../types';
import { buildTimeline } from '../sprintTimeline';
import { Modal } from './Modal';

interface Props { sprint: Sprint; issues: Issue[]; modules: Module[]; owners: Owner[]; relations: Relation[]; onClose: () => void }

export function SprintTimeline({ sprint, issues, modules, owners, relations, onClose }: Props) {
  const tasks = issues.filter((i) => i.type === 'task' && i.sprintId === sprint.id);
  const tl = buildTimeline(tasks, modules, relations);
  const lost = tl.length - tl.idealLength;
  return (
    <Modal title={`Timeline · ${sprint.name}`} onClose={onClose}>
      {tl.slots.length === 0 ? <p className="sp-empty">No open tasks in this sprint.</p> : (
        <>
          <p className="hint">
            A task takes its estimate in steps (1 if unset). A task starts once the work in the modules it depends on is done, and each owner takes one task at a time.
            Finishes in <b>{tl.length}</b> step{tl.length === 1 ? '' : 's'}
            {lost > 0 ? `; dependencies cost ${lost} step${lost === 1 ? '' : 's'} versus the busiest owner working alone.` : '; no dependency slows anyone down.'}
          </p>
          <div className="tlx" role="table" aria-label="Sprint timeline" style={{ gridTemplateColumns: `max-content repeat(${tl.length}, minmax(7rem, 1fr))` }}>
            <div className="tlx-h" />
            {Array.from({ length: tl.length }, (_, s) => <div key={s} className="tlx-h">Step {s + 1}</div>)}
            {tl.lanes.map((lane, row) => {
              const o = owners.find((x) => x.id === lane);
              const mine = tl.slots.filter((x) => x.lane === lane);
              return [
                <div key={`l${lane}`} className="tlx-lane" style={{ '--c': o?.color ?? 'var(--muted)', gridRow: row + 2, gridColumn: 1 } as React.CSSProperties}>{o ? `${o.icon ?? ''} ${o.name}` : 'Unassigned'}</div>,
                ...mine.map((slot) => {
                  const m = modules.find((x) => x.id === slot.issue.moduleId);
                  return (
                    <div key={slot.issue.id} className="tlx-task" style={{ '--c': m?.color ?? 'var(--border)', gridRow: row + 2, gridColumn: `${slot.start + 2} / span ${slot.length}` } as React.CSSProperties}
                      title={slot.waitsFor.length ? `Waits for ${slot.waitsFor.map((d) => `#${d}`).join(', ')}` : 'Can start right away'}>
                      <span>{slot.issue.title}</span>
                      <small>#{slot.issue.id}{slot.length > 1 && ` · ${slot.length} steps`}{m && ` · ${m.icon ?? ''} ${m.name}`}{slot.waitsFor.length > 0 && ` · after ${slot.waitsFor.map((d) => `#${d}`).join(' ')}`}</small>
                    </div>
                  );
                }),
              ];
            })}
          </div>
          {tl.lanes.includes(null) && <p className="hint">Unassigned tasks are shown as one person; assign owners to see the real split.</p>}
        </>
      )}
    </Modal>
  );
}
