import { useMemo, useState } from 'react';
import { fuzzyFilter } from '../fuzzy';
import { groupLabel, subtreeIds } from '../groupBoxes';
import { tally } from '../metrics';
import { groupHash, type GroupRef } from '../route';
import type { Graph, Issue } from '../types';
import { GroupPage } from './GroupPage';
import { Bar } from './MetricParts';

interface Props { graph: Graph; issues?: Issue[]; groupRef?: GroupRef | null; onChanged: () => void; onOpenModule: (id: number) => void }

type Sort = 'name' | 'modules' | 'open';
const accent = (c: string | null) => ({ borderLeft: `4px solid ${c ?? 'var(--border)'}` });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// `#/groups`: every group at a glance. Opening one goes to its own page (`#/groups/<id>`), like owners.
export function GroupsPage({ graph, issues = [], groupRef = null, onChanged, onOpenModule }: Props) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const groups = graph.groups ?? [];
  const ungrouped = graph.modules.filter((m) => m.groupId == null);

  const rows = useMemo(() => {
    const stats = groups.map((g) => {
      const tree = subtreeIds(groups, g.id);
      const mods = graph.modules.filter((m) => m.groupId != null && tree.has(m.groupId));
      const ids = new Set(mods.map((m) => m.id));
      const t = tally(issues.filter((i) => i.type === 'task' && i.moduleId != null && ids.has(i.moduleId)));
      return {
        g, label: groupLabel(groups, g.id), direct: graph.modules.filter((m) => m.groupId === g.id).length, total: mods.length,
        children: groups.filter((c) => c.parentId === g.id).length, t,
      };
    });
    type Row = typeof stats[number];
    const order: Record<Sort, (a: Row, b: Row) => number> = {
      name: (a, b) => a.label.localeCompare(b.label),
      modules: (a, b) => b.total - a.total || a.label.localeCompare(b.label),
      open: (a, b) => b.t.open + b.t.codeReview + b.t.testValidation - (a.t.open + a.t.codeReview + a.t.testValidation) || a.label.localeCompare(b.label),
    };
    return query.trim() ? fuzzyFilter(stats, query, (s) => s.label) : stats.sort(order[sort]);
  }, [graph, groups, issues, query, sort]);

  if (groupRef != null) {
    const group = groupRef === 'new' ? null : groups.find((g) => g.id === groupRef) ?? null;
    if (groupRef !== 'new' && !group) {
      return (
        <div className="owner-page">
          <a href="#/groups">← All groups</a>
          <p className="hint">This group does not exist (it may have been deleted).</p>
        </div>
      );
    }
    return <GroupPage key={groupRef} group={group} graph={graph} issues={issues} onChanged={onChanged} onOpenModule={onOpenModule} />;
  }

  return (
    <div className="owners-index">
      <div className="row between">
        <h2>Groups</h2>
        <button className="primary" onClick={() => { window.location.hash = groupHash('new'); }}>Add group</button>
      </div>
      <div className="row">
        <input type="search" aria-label="Search groups" placeholder="Search groups…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="row owners-sort">Sort by
          <select aria-label="Sort groups" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="name">Name</option><option value="modules">Modules</option><option value="open">Open tasks</option>
          </select>
        </label>
      </div>
      {groups.length === 0 && <p className="hint">No groups yet. Add one to organise modules into boxes on the diagram.</p>}
      {groups.length > 0 && rows.length === 0 && <p className="hint">No group matches "{query}".</p>}
      <div className="owner-cards">
        {rows.map(({ g, label, direct, total, children, t }) => (
          <a key={g.id} className="owner-card" href={groupHash(g.id)} style={accent(g.color)} aria-label={`Group ${g.name}`}>
            <strong>{g.icon && <span className="owner-icon">{g.icon} </span>}{label}</strong>
            <div className="owner-card-stats">
              <small>{plural(direct, 'module')}</small>
              {total > direct && <small>{total} with sub-groups</small>}
              {children > 0 && <small>{plural(children, 'sub-group')}</small>}
              <small>{t.open + t.codeReview + t.testValidation} open tasks</small>
            </div>
            <Bar pct={t.pct} label={`${g.name} completion`} />
            <small>{t.tasks === 0 ? 'no tasks yet' : `${t.pct}% done (${t.doneSteps}/${t.steps} steps)`}</small>
          </a>
        ))}
      </div>
      {ungrouped.length > 0 && groups.length > 0 && (
        <p className="hint">{plural(ungrouped.length, 'module')} not in any group: {ungrouped.map((m) => m.name).join(', ')}</p>
      )}
    </div>
  );
}
