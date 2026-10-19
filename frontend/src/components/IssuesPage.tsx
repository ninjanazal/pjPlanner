import { createContext, useContext, useState } from 'react';
import { api } from '../api';
import { ISSUE_STATES, ISSUE_TYPES, STATE_LABEL, TYPE_ICON, type Issue, type IssueState, type IssueType, type Module, type Owner, type Project, type Sprint } from '../types';
import { buildTree, childTypes, filterTree, hideClosed, parentOptions, type IssueNode } from '../issueTree';
import { NO_FILTER, isFiltering, matchesFilter, usePersisted, type IssueFilter } from '../issueFilters';
import { FilterBar } from './FilterBar';
import { QuickClose } from './QuickClose';
import { JiraLogo, RefreshIcon } from './JiraLogo';
import { BreakdownDialog } from './BreakdownDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { Modal } from './Modal';
import { useAction } from './useAction';
import { EstimatePicker } from './EstimatePicker';
import { ModulePicker } from './ModulePicker';
import { IssuePage } from './IssuePage';
import { issueHash } from '../route';

interface Props { issues: Issue[]; sprints?: Sprint[]; modules: Module[]; owners: Owner[]; issueId?: number | null; onChanged: () => void; project?: Project | null }


const openIssue = (i: Issue) => { window.location.hash = issueHash(i.id); };

export function IssuesPage({ issues, sprints = [], modules, owners, issueId = null, onChanged, project = null }: Props) {
  const [hide, setHide] = useState(true);
  const [editing, setEditing] = useState<Issue | 'new' | null>(null);
  const [syncing, setSyncing] = useState(false);
  const { error: syncError, run } = useAction(true);
  const canSync = Boolean(project?.jiraEnabled && project.jiraJql);
  const syncAll = async () => {
    if (!project) return;
    setSyncing(true);
    try {
      await run(async () => {
        const r = await api.jiraImport(project.id);
        onChanged();
        return r;
      }, 'Synced with Jira');
    } finally { setSyncing(false); }
  };
  const [filter, setFilter] = usePersisted<IssueFilter>('pjplanner.issues.filter', NO_FILTER);
  const [collapsed, setCollapsed] = usePersisted<number[]>('pjplanner.issues.collapsed', []);
  const filtering = isFiltering(filter);
  const hideNow = hide && !filter.state; // asking for a state shows it even when closed ones are hidden
  const match = (i: Issue) => matchesFilter(i, filter, issues);
  const all = buildTree(issues);
  const filtered = filtering ? filterTree(all, match) : all;
  const tree = hideNow ? hideClosed(filtered) : filtered;
  const closedList = issues.filter((i) => i.state === 'closed' && (!filtering || match(i))).sort((a, b) => b.id - a.id);
  const parents = [...new Set(issues.flatMap((i) => (i.parentId != null ? [i.parentId] : [])))];
  const toggle = (id: number) => setCollapsed((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const count = (nodes: IssueNode[]): number => nodes.reduce((n, x) => n + 1 + count(x.children), 0);

  if (issueId != null) {
    return <IssuePage key={issueId} issue={issues.find((i) => i.id === issueId) ?? null} issues={issues} sprints={sprints} modules={modules} owners={owners} onChanged={onChanged} project={project} />;
  }

  return (
    <div className="issues-page">
      <div className="row between">
        <h2>Issues</h2>
        <div className="row">
          <button type="button" onClick={() => setCollapsed(parents)} disabled={parents.length === 0}>Collapse all</button>
          <button type="button" onClick={() => setCollapsed([])} disabled={collapsed.length === 0}>Expand all</button>
          <label className="check"><input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} />Hide closed</label>
          {canSync && <button className={`icon-btn${syncing ? ' spinning' : ''}`} onClick={syncAll} disabled={syncing} title="Sync with Jira" aria-label="Sync with Jira"><JiraLogo size={14} /><RefreshIcon /></button>}
          <button className="primary" onClick={() => setEditing('new')}>Add issue</button>
        </div>
      </div>
      {syncError && <p className="error" role="alert">{syncError}</p>}
      {issues.length > 0 && <FilterBar filter={filter} onChange={setFilter} issues={issues} modules={modules} owners={owners} sprints={sprints} fields={{ state: true, type: true, sprint: true }} shown={count(tree)} total={issues.length} />}
      {tree.length === 0 && <p className="hint">{issues.length === 0 ? 'No issues yet. Add one to start tracking work.' : filtering ? 'No issues match the filter.' : 'All issues are closed.'}</p>}
      <ul className="issue-tree" role="tree">
        {tree.map((n) => <IssueRow key={n.issue.id} node={n} depth={0} modules={modules} owners={owners} onChanged={onChanged} collapsed={filtering ? [] : collapsed} onToggle={toggle} />)}
      </ul>
      {hideNow && closedList.length > 0 && (
        <details className="closed-list">
          <summary>Closed ({closedList.length})</summary>
          <ul className="issue-tree">
            {closedList.map((i) => (
              <li key={i.id}><div className="issue-row is-closed">
                <QuickClose issue={i} onChanged={onChanged} />
                <TypeBadge type={i.type} /><span className="hint">#{i.id}</span>
                <button className="issue-title" aria-label={`Open issue ${i.title}`} onClick={() => openIssue(i)}>{i.title}</button>
                <JiraKey issue={i} />
              </div></li>
            ))}
          </ul>
        </details>
      )}
      {editing && (
        <IssueDialog key={editing === 'new' ? 'new' : editing.id} issue={editing === 'new' ? null : editing} issues={issues} sprints={sprints}
          modules={modules} owners={owners} onClose={() => setEditing(null)} onChanged={() => { setEditing(null); onChanged(); }} />
      )}
    </div>
  );
}

// Base address of Jira (null when it is not configured), so an imported issue's key can link to it.
export const JiraUrlContext = createContext<string | null>(null);
// Imported issues carry the platform's icon and key; the key links to the issue in Jira when the address is known.
export const JiraKey = ({ issue }: { issue: Issue }) => {
  const url = useContext(JiraUrlContext);
  if (!issue.jiraKey) return null;
  return url
    ? <a className="mcp-tag jira-key" href={`${url}/browse/${issue.jiraKey}`} target="_blank" rel="noreferrer" title="Open in Jira"><JiraLogo />{issue.jiraKey}</a>
    : <span className="mcp-tag jira-key" title="Imported from Jira"><JiraLogo />{issue.jiraKey}</span>;
};

export const TypeBadge = ({ type }: { type: IssueType }) =>
  <span className={`type-badge t-${type}`}><span aria-hidden="true">{TYPE_ICON[type]}</span> {type}</span>;
export const StateBadge = ({ state }: { state: IssueState }) => <span className={`state-badge s-${state}`}>{STATE_LABEL[state]}</span>;

function IssueRow({ node, depth, modules, owners, onChanged, collapsed, onToggle }: {
  node: IssueNode; depth: number; modules: Module[]; owners: Owner[]; onChanged: () => void; collapsed: number[]; onToggle: (id: number) => void;
}) {
  const i = node.issue;
  const owner = owners.find((o) => o.id === i.ownerId);
  const mod = modules.find((m) => m.id === i.moduleId);
  const folded = collapsed.includes(i.id);
  const kids = node.children.length;
  return (
    <li role="treeitem" aria-level={depth + 1} aria-expanded={kids ? !folded : undefined}>
      <div className="issue-row" style={{ marginLeft: depth * 24 }}>
        {kids > 0
          ? <button type="button" className="tree-toggle" aria-label={`${folded ? 'Expand' : 'Collapse'} ${i.title}`} onClick={() => onToggle(i.id)}>{folded ? '▸' : '▾'}</button>
          : <span className="tree-toggle" aria-hidden="true" />}
        <QuickClose issue={i} onChanged={onChanged} />
        <TypeBadge type={i.type} />
        <span className="hint">#{i.id}</span>
        <button className="issue-title" aria-label={`Open issue ${i.title}`} onClick={() => openIssue(i)}>{i.title}</button>
        <StateBadge state={i.state} />
        <JiraKey issue={i} />
        {owner && <span className="chip" style={{ '--chip-c': owner.color ?? 'var(--border)' } as React.CSSProperties}>{owner.icon} {owner.name}</span>}
        {mod && <span className="chip" data-testid="module-chip" style={{ '--chip-c': mod.color ?? 'var(--border)' } as React.CSSProperties}>{mod.icon} {mod.name}</span>}
        {folded && <span className="hint">{kids} hidden</span>}
      </div>
      {kids > 0 && !folded && (
        <ul role="group">{node.children.map((c) => <IssueRow key={c.issue.id} node={c} depth={depth + 1} modules={modules} owners={owners} onChanged={onChanged} collapsed={collapsed} onToggle={onToggle} />)}</ul>
      )}
    </li>
  );
}

export function IssueDialog({ issue, issues, sprints = [], modules, owners, onClose, onChanged }: {
  issue: Issue | null; issues: Issue[]; sprints?: Sprint[]; modules: Module[]; owners: Owner[]; onClose: () => void; onChanged: () => void;
}) {
  const init = {
    type: issue?.type ?? 'task' as IssueType, title: issue?.title ?? '', description: issue?.description ?? '', implementation: issue?.implementation ?? '',
    parentId: issue?.parentId ?? null, ownerId: issue?.ownerId ?? null, state: issue?.state ?? 'open' as IssueState, moduleId: issue?.moduleId ?? null,
    sprintId: issue?.sprintId ?? null, estimate: issue?.estimate ?? null,
  };
  const [f, setF] = useState(init);
  const [confirming, setConfirming] = useState(false);
  const [breaking, setBreaking] = useState(false);
  const { error, run } = useAction();
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const options = parentOptions(issues, f.type, issue?.id);
  // A parent invalid for the chosen type is treated as none rather than sent to the server.
  const parentId = options.some((o) => o.id === f.parentId) ? f.parentId : null;
  const num = (v: string) => (v ? Number(v) : null);

  const needsModule = f.type === 'task' && f.moduleId == null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (needsModule) return;
    const body = { ...f, parentId, ...(f.type === 'task' ? {} : { implementation: '', ownerId: null, moduleId: null, sprintId: null, estimate: undefined }) };
    if (await run(() => (issue ? api.updateIssue(issue.id, body) : api.createIssue(body)))) onChanged();
  };
  const del = async () => {
    setConfirming(false);
    if (issue && (await run(() => api.deleteIssue(issue.id)))) onChanged();
  };

  return (
    <Modal title={issue ? `Edit issue #${issue.id}` : 'Add issue'} dirty={dirty} onClose={onClose}>
      <form onSubmit={submit}>
        <label>Type
          <select aria-label="Type" value={f.type} onChange={(e) => set('type', e.target.value as IssueType)}>
            {ISSUE_TYPES.map((t) => <option key={t} value={t}>{TYPE_ICON[t]} {t}</option>)}
          </select>
        </label>
        <label>Title<input data-autofocus aria-label="Title" value={f.title} onChange={(e) => set('title', e.target.value)} /></label>
        <label>Description<textarea aria-label="Description" rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} /></label>
        {f.type === 'task' && <label>Implementation notes<textarea aria-label="Implementation notes" rows={3} placeholder="Approach, pitfalls, how to test, links…" value={f.implementation} onChange={(e) => set('implementation', e.target.value)} /></label>}
        {f.type !== 'epic' && (
          <label>Parent
            <select aria-label="Parent" value={parentId ?? ''} onChange={(e) => set('parentId', num(e.target.value))}>
              <option value="">None (top level)</option>
              {options.map((o) => <option key={o.id} value={o.id}>#{o.id} {o.title}</option>)}
            </select>
          </label>
        )}
        {f.type === 'task' && <label>Module (required)
          <ModulePicker modules={modules} value={f.moduleId} required onChange={(moduleId) => set('moduleId', moduleId)} />
        </label>}
        {f.type === 'task' && <div className="field"><span className="field-label">Estimate (steps)</span>
          <EstimatePicker value={f.estimate} onChange={(v) => set('estimate', v)} />
        </div>}
        {f.type === 'task' && <label>Sprint
          <select aria-label="Sprint" value={f.sprintId ?? ''} onChange={(e) => set('sprintId', num(e.target.value))}>
            <option value="">Backlog (no sprint)</option>
            {sprints.filter((sp) => sp.state !== 'closed' || sp.id === init.sprintId).map((sp) => <option key={sp.id} value={sp.id}>{sp.name}{sp.state === 'active' ? ' (active)' : ''}</option>)}
          </select>
        </label>}
        {f.type === 'task' && issue && <label>Assignee
          <select aria-label="Assignee" value={f.ownerId ?? ''} disabled={owners.length === 0} onChange={(e) => set('ownerId', num(e.target.value))}>
            <option value="">{owners.length === 0 ? 'No owners yet' : 'Unassigned'}</option>
            {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>}
        <label>State
          <select aria-label="State" value={f.state} onChange={(e) => set('state', e.target.value as IssueState)}>
            {ISSUE_STATES.map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
          </select>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row modal-actions">
          <button type="submit" className="primary" disabled={needsModule} title={needsModule ? 'Pick a module first' : undefined}>{issue ? 'Save issue' : 'Create issue'}</button>
          {issue && childTypes(issue.type).length > 0 && <button type="button" onClick={() => setBreaking(true)}>Break down…</button>}
          {issue && <button type="button" className="danger" onClick={() => setConfirming(true)}>Delete issue</button>}
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
      {breaking && issue && (
        <BreakdownDialog parent={issue} modules={modules} owners={owners} onClose={() => setBreaking(false)} onChanged={() => { setBreaking(false); onChanged(); }} />
      )}
      {confirming && issue && (
        <ConfirmDialog message={`Delete issue "${issue.title}"? Its child issues become top-level, and no modules are deleted.`}
          onConfirm={del} onCancel={() => setConfirming(false)} />
      )}
    </Modal>
  );
}
