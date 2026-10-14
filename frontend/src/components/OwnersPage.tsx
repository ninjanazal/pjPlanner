import { useMemo, useState } from 'react';
import { fuzzyFilter } from '../fuzzy';
import { formatDuration, ownerLoads, tally, timeMetrics } from '../metrics';
import { ownerHash, type OwnerRef } from '../route';
import type { Graph, Issue, Sprint } from '../types';
import { Bar } from './MetricParts';
import { OwnerPage } from './OwnerPage';

interface Props {
  graph: Graph; issues?: Issue[]; sprints?: Sprint[]; ownerRef?: OwnerRef | null; onChanged: () => void; onOpenModule: (id: number) => void;
}

type Sort = 'name' | 'open' | 'modules' | 'done';
const accent = (c: string | null) => ({ borderLeft: `4px solid ${c ?? 'var(--border)'}` });

// `#/owners`: every owner at a glance. Opening one goes to its own page (`#/owners/<id>`), like issues.
export function OwnersPage({ graph, issues = [], sprints = [], ownerRef = null, onChanged, onOpenModule }: Props) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const unassigned = graph.modules.filter((m) => m.ownerIds.length === 0);

  const rows = useMemo(() => {
    const loads = ownerLoads(issues, graph.owners);
    const speed = timeMetrics(issues, graph.owners, graph.modules).owners;
    const stats = graph.owners.map((o) => {
      const mine = issues.filter((i) => i.type === 'task' && i.ownerId === o.id);
      const load = loads.find((l) => l.owner.id === o.id);
      return { o, modules: graph.modules.filter((m) => m.ownerIds.includes(o.id)).length, tally: tally(mine), open: load?.open ?? 0, remaining: load?.remaining ?? 0, speed: speed.find((s) => s.owner.id === o.id) };
    });
    type Row = typeof stats[number];
    const order: Record<Sort, (a: Row, b: Row) => number> = {
      name: (a, b) => a.o.name.localeCompare(b.o.name),
      open: (a, b) => b.open - a.open || a.o.name.localeCompare(b.o.name),
      modules: (a, b) => b.modules - a.modules || a.o.name.localeCompare(b.o.name),
      done: (a, b) => b.tally.pct - a.tally.pct || a.o.name.localeCompare(b.o.name),
    };
    return query.trim() ? fuzzyFilter(stats, query, (s) => s.o.name) : stats.sort(order[sort]);
  }, [graph, issues, query, sort]);

  if (ownerRef != null) {
    const owner = ownerRef === 'new' ? null : graph.owners.find((o) => o.id === ownerRef) ?? null;
    if (ownerRef !== 'new' && !owner) {
      return (
        <div className="owner-page">
          <a href="#/owners">← All owners</a>
          <p className="hint">This owner does not exist (they may have been deleted).</p>
        </div>
      );
    }
    return <OwnerPage key={ownerRef} owner={owner} graph={graph} issues={issues} sprints={sprints} onChanged={onChanged} onOpenModule={onOpenModule} />;
  }

  return (
    <div className="owners-index">
      <div className="row between">
        <h2>Owners</h2>
        <button className="primary" onClick={() => { window.location.hash = ownerHash('new'); }}>Add owner</button>
      </div>
      <div className="row">
        <input type="search" aria-label="Search owners" placeholder="Search owners…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="row owners-sort">Sort by
          <select aria-label="Sort owners" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="name">Name</option><option value="open">Open tasks</option><option value="modules">Modules</option><option value="done">Completion</option>
          </select>
        </label>
      </div>
      {graph.owners.length === 0 && <p className="hint">No owners yet. Add one to start assigning modules.</p>}
      {graph.owners.length > 0 && rows.length === 0 && <p className="hint">No owner matches "{query}".</p>}
      <div className="owner-cards">
        {rows.map(({ o, modules, open, remaining, tally: t, speed }) => (
          <a key={o.id} className="owner-card" href={ownerHash(o.id)} style={accent(o.color)} aria-label={`Owner ${o.name}`}>
            <strong>{o.icon && <span className="owner-icon">{o.icon} </span>}{o.name}</strong>
            <div className="owner-card-stats">
              <small>{modules} module{modules === 1 ? '' : 's'}</small>
              <small>{open} open task{open === 1 ? '' : 's'}</small>
              <small>{remaining} steps left</small>
              {speed && speed.count > 0 && <small>{formatDuration(speed.msPerStep)} per step</small>}
            </div>
            <Bar pct={t.pct} label={`${o.name} completion`} />
            <small>{t.tasks === 0 ? 'no tasks yet' : `${t.pct}% done (${t.doneSteps}/${t.steps} steps)`}</small>
          </a>
        ))}
      </div>
      {unassigned.length > 0 && (
        <p className="hint">{unassigned.length} module{unassigned.length === 1 ? ' has' : 's have'} no owner: {unassigned.map((m) => m.name).join(', ')}</p>
      )}
    </div>
  );
}
