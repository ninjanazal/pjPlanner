import { ISSUE_STATES, ISSUE_TYPES, STATE_LABEL, type Issue, type Module, type Owner, type Sprint } from '../types';
import { NO_FILTER, isFiltering, type IssueFilter } from '../issueFilters';

interface Props {
  filter: IssueFilter; onChange: (f: IssueFilter) => void; issues: Issue[]; modules: Module[]; owners: Owner[]; sprints?: Sprint[];
  fields?: { state?: boolean; type?: boolean; sprint?: boolean }; shown: number; total: number;
}

const val = (v: number | 'none' | null) => (v == null ? '' : String(v));
const parse = (s: string): number | 'none' | null => (s === '' ? null : s === 'none' ? 'none' : Number(s));

function Pick({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className={`fsel${value ? ' on' : ''}`}>
      <span aria-hidden="true">{label}</span>
      <select aria-label={`Filter by ${label.toLowerCase()}`} value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>
    </div>
  );
}

export function FilterBar({ filter, onChange, issues, modules, owners, sprints = [], fields = {}, shown, total }: Props) {
  const set = <K extends keyof IssueFilter>(k: K, v: IssueFilter[K]) => onChange({ ...filter, [k]: v });
  const epics = issues.filter((i) => i.type === 'epic');
  const active = isFiltering(filter);
  return (
    <div className={`filter-bar${active ? ' active' : ''}`} role="search" aria-label="Filter issues">
      <div className="fsearch">
        <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        <input type="search" aria-label="Search issues" placeholder="Search title, #id or Jira key" value={filter.text} onChange={(e) => set('text', e.target.value)} />
      </div>
      <div className="fgroup">
        {fields.sprint && (
          <Pick label="Sprint" value={val(filter.sprintId)} onChange={(v) => set('sprintId', parse(v))}>
            <option value="">All</option><option value="none">Backlog</option>
            {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}{s.state === 'active' ? ' (active)' : s.state === 'closed' ? ' (closed)' : ''}</option>)}
          </Pick>
        )}
        <Pick label="Owner" value={val(filter.ownerId)} onChange={(v) => set('ownerId', parse(v))}>
          <option value="">All</option><option value="none">Unassigned</option>
          {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </Pick>
        <Pick label="Module" value={val(filter.moduleId)} onChange={(v) => set('moduleId', parse(v))}>
          <option value="">All</option><option value="none">No module</option>
          {modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Pick>
        <Pick label="Epic" value={val(filter.epicId)} onChange={(v) => set('epicId', parse(v))}>
          <option value="">All</option><option value="none">No epic</option>
          {epics.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </Pick>
        {fields.state && (
          <Pick label="State" value={filter.state ?? ''} onChange={(v) => set('state', (v || null) as IssueFilter['state'])}>
            <option value="">Any</option>
            {ISSUE_STATES.map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
          </Pick>
        )}
        {fields.type && (
          <Pick label="Type" value={filter.type ?? ''} onChange={(v) => set('type', (v || null) as IssueFilter['type'])}>
            <option value="">Any</option>
            {ISSUE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Pick>
        )}
      </div>
      <div className="fend">
        <span className="filter-count" aria-live="polite"><b>{shown}</b> of {total}</span>
        {active && <button type="button" className="fclear" onClick={() => onChange(NO_FILTER)}>Clear</button>}
      </div>
    </div>
  );
}
