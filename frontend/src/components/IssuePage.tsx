import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, ApiError } from '../api';
import { ISSUE_STATES, STATE_LABEL, TYPE_ICON, type Issue, type IssueState, type IssueType, type Module, type Owner, type Project, type Sprint } from '../types';
import { childTypes, descendantIds, parentOptions } from '../issueTree';
import { issueHash, ownerHash } from '../route';
import { BreakdownDialog } from './BreakdownDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { JiraKey, StateBadge, TypeBadge } from './IssuesPage';
import { JiraLogo, PushIcon, RefreshIcon, UploadIcon } from './JiraLogo';
import { JiraUploadForm } from './JiraUploadForm';
import { useDirtyGuard } from './Modal';
import { EstimatePicker } from './EstimatePicker';
import { ModulePicker } from './ModulePicker';
import { useAction } from './useAction';
import { useToast } from './Toast';

interface Props {
  issue: Issue | null; issues: Issue[]; sprints: Sprint[]; modules: Module[]; owners: Owner[]; onChanged: () => void; project?: Project | null;
}

interface Form {
  type: IssueType; title: string; description: string; implementation: string; parentId: number | null; ownerId: number | null;
  state: IssueState; moduleId: number | null; sprintId: number | null; estimate: number | null;
}

const fromIssue = (i: Issue): Form => ({
  type: i.type, title: i.title, description: i.description, implementation: i.implementation ?? '', parentId: i.parentId, ownerId: i.ownerId,
  state: i.state, moduleId: i.moduleId, sprintId: i.sprintId, estimate: i.estimate ?? null,
});
const chipStyle = (c?: string | null) => ({ '--chip-c': c ?? 'var(--border)' } as React.CSSProperties);
const num = (v: string) => (v ? Number(v) : null);

// Full page of one issue. Every field is editable in place; changes are kept as a draft until saved or discarded.
export function IssuePage({ issue, issues, sprints, modules, owners, onChanged, project = null }: Props) {
  const [draft, setDraft] = useState<Form | null>(null);
  const [confirming, setConfirming] = useState<'delete' | string | null>(null);
  const [breaking, setBreaking] = useState(false);
  const toast = useToast();
  const { error, run } = useAction(true);
  const [jiraAsk, setJiraAsk] = useState<'update' | 'overwrite' | 'refresh' | null>(null);
  const [uploading, setUploading] = useState(false);
  const [writeAllowed, setWriteAllowed] = useState(false);
  useEffect(() => {
    if (!project?.jiraEnabled || !project?.jiraWrite) { setWriteAllowed(false); return; }
    let live = true;
    api.jiraStatus().then((s) => { if (live) setWriteAllowed(Boolean(s.writeAllowed)); }, () => {});
    return () => { live = false; };
  }, [project?.jiraEnabled, project?.jiraWrite]);
  const base = issue ? fromIssue(issue) : null;
  const f = draft ?? base;
  const dirty = draft != null && JSON.stringify(draft) !== JSON.stringify(base);
  useDirtyGuard(dirty);

  // Title and description grow to show all their text (no inner scrollbar); re-fit when the window width changes the wrapping.
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const implRef = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    for (const el of [titleRef.current, descRef.current, implRef.current]) if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; }
  };
  useLayoutEffect(fit, [f?.title, f?.description, f?.implementation]);
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // Ctrl/Cmd+S saves, Esc-less on purpose: leaving is guarded by the discard prompt instead.
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveRef.current(); }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);

  // Moves to another hash, asking first when there are unsaved edits.
  const go = (hash: string) => {
    if (dirty) setConfirming(hash);
    else window.location.hash = hash;
  };
  const link = (hash: string) => ({ href: hash, onClick: (e: React.MouseEvent) => { e.preventDefault(); go(hash); } });

  if (!issue || !base || !f) {
    return (
      <div className="issue-page">
        <a {...link('#/issues')}>← All issues</a>
        <p className="hint">This issue does not exist (it may have been deleted).</p>
      </div>
    );
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setDraft({ ...f, [k]: v });
  const isTask = f.type === 'task';
  const options = parentOptions(issues, f.type, issue.id);
  const parentId = options.some((o) => o.id === f.parentId) ? f.parentId : null;
  const mod = modules.find((m) => m.id === f.moduleId);
  const moduleOwners = owners.filter((o) => mod?.ownerIds.includes(o.id));
  const owner = owners.find((o) => o.id === f.ownerId);
  const sprint = sprints.find((s) => s.id === issue.sprintId);
  const children = issues.filter((i) => i.parentId === issue.id).sort((a, b) => a.id - b.id);
  const ancestors: Issue[] = [];
  for (let p = issues.find((i) => i.id === issue.parentId); p && !ancestors.includes(p); p = issues.find((i) => i.id === p!.parentId)) ancestors.unshift(p);

  // Progress counts the tasks underneath (an issue with no tasks counts its direct children), weighted by estimate.
  const below = issues.filter((i) => descendantIds(issues, issue.id).has(i.id));
  const leaves = below.some((i) => i.type === 'task') ? below.filter((i) => i.type === 'task') : below;
  const steps = (i: Issue) => i.estimate ?? 1;
  const totalSteps = leaves.reduce((n, i) => n + steps(i), 0);
  const doneSteps = leaves.filter((i) => i.state === 'closed').reduce((n, i) => n + steps(i), 0);
  const pct = totalSteps ? Math.round((doneSteps / totalSteps) * 100) : 0;
  const rollup = issue.rollupModuleIds.map((id) => modules.find((m) => m.id === id)).filter((m): m is Module => Boolean(m));

  // Every task needs a module; an old task that never had one can still be saved as long as it stays that way.
  const missingModule = f.type === 'task' && f.moduleId == null && (issue.type !== 'task' || issue.moduleId != null);
  const save = async () => {
    if (!dirty || !draft) return;
    if (!draft.title.trim() || missingModule) return;
    const body = { ...draft, parentId, ...(draft.type === 'task' ? {} : { implementation: '', ownerId: null, moduleId: null, sprintId: null, estimate: undefined }) };
    if (await run(() => api.updateIssue(issue.id, body))) { setDraft(null); onChanged(); flash('Changes saved'); }
  };
  saveRef.current = save;
  const del = async () => {
    setConfirming(null);
    if (await run(() => api.deleteIssue(issue.id))) { flushSync(() => setDraft(null)); window.location.hash = '#/issues'; onChanged(); flash('Issue deleted'); }
  };
  // Upload goes through a form; an update is a confirm, and one to an issue edited in Jira since the last sync needs a second one.
  const jiraGo = async (force = false) => {
    setJiraAsk(null);
    try {
      await api.jiraUpdate(issue.id, force);
      onChanged();
      flash('Updated in Jira');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.extra?.jiraUpdated) setJiraAsk('overwrite');
      else flash((e as Error).message, 'error');
    }
  };
  const refreshGo = async () => {
    setJiraAsk(null);
    try {
      await api.jiraRefresh(issue.id);
      onChanged();
      flash('Refreshed from Jira');
    } catch (e) { flash((e as Error).message, 'error'); }
  };
  const canRefresh = Boolean(project?.jiraEnabled) && Boolean(issue.jiraKey);
  const parent = issues.find((i) => i.id === issue.parentId);
  const canUpload = writeAllowed && !issue.jiraKey && (parent ? Boolean(parent.jiraKey) : true);
  const canUpdate = writeAllowed && Boolean(issue.jiraKey);
  // Text of the Jira confirm dialog; 'overwrite' is the second confirm after Jira changed meanwhile.
  const askDialog = (kind: 'update' | 'overwrite' | 'refresh') => {
    switch (kind) {
      case 'update': return { title: 'Update in Jira?', confirmLabel: 'Update',
        message: `Push the title, description and tracking label of ${issue.jiraKey} to Jira. State, type and parent are not changed.` };
      case 'refresh': return { title: 'Refresh from Jira?', confirmLabel: 'Refresh',
        message: `Replace the local title, description and state with those of ${issue.jiraKey} in Jira. Module, assignee, sprint and estimate are kept.` };
      case 'overwrite': return { title: 'Jira changed since the last sync', confirmLabel: 'Overwrite',
        message: `${issue.jiraKey} was edited in Jira after the last import. Overwrite its title and description with this version?` };
    }
  };
  const leave = (hash: string) => { flushSync(() => { setDraft(null); setConfirming(null); }); window.location.hash = hash; };
  const flash = (text: string, kind: 'success' | 'error' = 'success') => toast?.(text, kind);
  // navigator.clipboard only exists in secure contexts (not http on a LAN address), so fall back to a hidden textarea.
  const copy = async () => {
    const text = window.location.href;
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('copy failed');
      }
      flash('Link copied');
    } catch { flash('Could not copy the link', 'error'); }
  };

  const detail = (label: string, body: React.ReactNode) => (
    <div className="detail"><span className="detail-label">{label}</span><div className="detail-value">{body}</div></div>
  );

  return (
    <div className="issue-page">
      <nav className="issue-crumbs" aria-label="Issue path">
        <a {...link('#/issues')}>Issues</a>
        {ancestors.map((a) => <span key={a.id}><i>/</i><a {...link(issueHash(a.id))}>{TYPE_ICON[a.type]} #{a.id}</a></span>)}
        <span><i>/</i><b>{TYPE_ICON[issue.type]} #{issue.id}</b></span>
        <JiraKey issue={issue} />
      </nav>

      <div className="issue-layout">
        <div className="issue-main">
          <textarea ref={titleRef} className="issue-title-input" aria-label="Title" rows={1} value={f.title} placeholder="Title"
            onChange={(e) => set('title', e.target.value.replace(/\n/g, ' '))} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
          {error && <p className="error" role="alert">{error}</p>}

          <div className="issue-actions">
            {childTypes(issue.type).length > 0 && <button type="button" onClick={() => setBreaking(true)}>Break down…</button>}
            {(canUpload || canUpdate || canRefresh) && (
              <span className="jira-actions" role="group" aria-label="Jira">
                <span className="jira-badge" aria-hidden="true"><JiraLogo size={14} /></span>
                {canUpload && <button type="button" className="jira-btn" onClick={() => setUploading(true)} aria-label="Upload to Jira" title="Upload to Jira"><UploadIcon />Upload</button>}
                {canUpdate && <button type="button" className="jira-btn" onClick={() => setJiraAsk('update')} disabled={dirty} aria-label="Update in Jira" title={dirty ? 'Save your changes first' : 'Update in Jira'}><PushIcon />Update</button>}
                {canRefresh && <button type="button" className="jira-btn" onClick={() => setJiraAsk('refresh')} disabled={dirty} aria-label="Refresh from Jira" title={dirty ? 'Save your changes first' : 'Refresh from Jira'}><RefreshIcon />Refresh</button>}
              </span>
            )}
            <button type="button" onClick={copy}>Copy link</button>
            <button type="button" className="ghost-danger" onClick={() => setConfirming('delete')}>Delete</button>
          </div>

          <section className="desc">
            <h3>Description</h3>
            <textarea ref={descRef} id="issue-desc" aria-label="Description" rows={8} value={f.description} placeholder="Add a description…"
              onChange={(e) => set('description', e.target.value)} />
          </section>

          {isTask && (
            <section className="desc">
              <h3>Implementation notes</h3>
              <textarea ref={implRef} aria-label="Implementation notes" rows={5} value={f.implementation}
                placeholder="Tips for whoever picks this up: approach, files and modules to touch, pitfalls, how to test, useful links…"
                onChange={(e) => set('implementation', e.target.value)} />
            </section>
          )}

          {children.length > 0 && (
            <section className="desc">
              <div className="row between">
                <h3>Child issues</h3>
                <span className="hint">{totalSteps > 0 ? `${pct}% done` : `${children.length}`}</span>
              </div>
              {totalSteps > 0 && <div className="progress" role="progressbar" aria-label="Progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${pct}%` }} /></div>}
              <ul className="child-list">
                {children.map((c) => {
                  const o = owners.find((x) => x.id === c.ownerId);
                  return (
                    <li key={c.id}>
                      <span className="child-type" title={c.type}>{TYPE_ICON[c.type]}</span>
                      <span className="hint">#{c.id}</span>
                      <a className="child-title" {...link(issueHash(c.id))}>{c.title}</a>
                      {o && <span className="avatar" style={chipStyle(o.color)} title={o.name}>{o.icon || o.name.slice(0, 1).toUpperCase()}</span>}
                      <StateBadge state={c.state} />
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        <aside className="issue-side">
          <select className={`status-select s-${f.state}`} aria-label="State" value={f.state} onChange={(e) => set('state', e.target.value as IssueState)}>
            {ISSUE_STATES.map((st) => <option key={st} value={st}>{STATE_LABEL[st]}</option>)}
          </select>

          <div className="details">
            <h3>Details</h3>
            {detail('Type', <TypeBadge type={issue.type} />)}
            {isTask && detail('Owner', owner ? (
              <span className="chip chip-x" style={chipStyle(owner.color)}>
                <a href={ownerHash(owner.id)} {...{ onClick: (e: React.MouseEvent) => { e.preventDefault(); go(ownerHash(owner.id)); } }}>{owner.icon} {owner.name}</a>
                <button type="button" className="chip-remove" aria-label={`Remove owner ${owner.name}`} title="Remove owner" onClick={() => set('ownerId', null)}>×</button>
              </span>
            ) : (
              <select aria-label="Assign owner" value="" disabled={moduleOwners.length === 0} onChange={(e) => set('ownerId', num(e.target.value))}>
                <option value="">{f.moduleId == null ? 'Pick a module first' : moduleOwners.length === 0 ? 'This module has no owners' : 'Unassigned'}</option>
                {moduleOwners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            ))}
            {f.type !== 'epic' && detail('Parent', (
              <select aria-label="Parent" value={parentId ?? ''} onChange={(e) => set('parentId', num(e.target.value))}>
                <option value="">None</option>
                {options.map((o) => <option key={o.id} value={o.id}>#{o.id} {o.title}</option>)}
              </select>
            ))}
            {isTask && detail('Module', (
              <ModulePicker modules={modules} value={f.moduleId} required onChange={(moduleId) => {
                const keeps = modules.find((m) => m.id === moduleId)?.ownerIds.includes(f.ownerId ?? -1);
                setDraft({ ...f, moduleId, ownerId: keeps ? f.ownerId : null });
              }} />
            ))}
            {isTask && detail('Sprint', (
              <select aria-label="Sprint" value={f.sprintId ?? ''} onChange={(e) => set('sprintId', num(e.target.value))}>
                <option value="">Backlog</option>
                {sprints.filter((sp) => sp.state !== 'closed' || sp.id === sprint?.id).map((sp) => <option key={sp.id} value={sp.id}>{sp.name}{sp.state === 'active' ? ' (active)' : ''}</option>)}
              </select>
            ))}
            {isTask && detail('Estimate', (
              <EstimatePicker value={f.estimate} onChange={(v) => set('estimate', v)} />
            ))}
            {!isTask && rollup.length > 0 && detail('Modules', <div className="row wrap">{rollup.map((m) => <span key={m.id} className="chip" style={chipStyle(m.color)}>{m.icon} {m.name}</span>)}</div>)}
            {totalSteps > 0 && detail('Steps', `${doneSteps} of ${totalSteps} done`)}
          </div>
        </aside>
      </div>

      {dirty && (
        <div className="save-bar" role="region" aria-label="Unsaved changes">
          <span>You have unsaved changes</span>
          <span className="spacer" />
          <button type="button" onClick={() => setDraft(null)}>Discard</button>
          <button type="button" className="primary" disabled={!draft?.title.trim() || missingModule} title={missingModule ? 'A task needs a module' : undefined} onClick={save}>Save changes</button>
        </div>
      )}

      {breaking && <BreakdownDialog parent={issue} modules={modules} owners={owners} onClose={() => setBreaking(false)} onChanged={(n) => { setBreaking(false); flash(`Created ${n} ${n === 1 ? 'issue' : 'issues'}`); onChanged(); }} />}
      {uploading && (
        <JiraUploadForm issue={issue} onClose={() => setUploading(false)} onDone={(r) => {
          setUploading(false); onChanged();
          if (r.linkWarning) flash(r.linkWarning, 'error');
          else flash(r.adopted ? `Linked to existing Jira issue ${r.issue.jiraKey}` : `Uploaded to Jira as ${r.issue.jiraKey}`);
        }} />
      )}
      {jiraAsk && (
        <ConfirmDialog {...askDialog(jiraAsk)} onCancel={() => setJiraAsk(null)}
          onConfirm={() => (jiraAsk === 'refresh' ? refreshGo() : jiraGo(jiraAsk === 'overwrite'))} />
      )}
      {confirming === 'delete' && (
        <ConfirmDialog message={`Delete issue "${issue.title}"? Its child issues become top-level, and no modules are deleted.`} onConfirm={del} onCancel={() => setConfirming(null)} />
      )}
      {confirming && confirming !== 'delete' && (
        <ConfirmDialog title="Discard changes?" message="You have unsaved edits. Leaving now will discard them." confirmLabel="Discard" cancelLabel="Keep editing"
          onConfirm={() => leave(confirming)} onCancel={() => setConfirming(null)} />
      )}
    </div>
  );
}
