import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Issue, JiraFieldDescriptor, JiraUploadForm as Meta, JiraWriteResult } from '../types';
import { JiraLogo, UploadIcon } from './JiraLogo';
import { Modal } from './Modal';
import { FieldControl, fromValue, isEmpty, isUnsupported, toValue, type Val } from './jiraFieldControl';

const seed = (fields: JiraFieldDescriptor[]) => {
  const out: Record<string, Val> = {};
  for (const f of fields) { const v = fromValue(f, f.default); if (v !== undefined) out[f.id] = v; }
  return out;
};

// Converts the editable strings into what the backend validates; empty and hidden fields are left out.
function toPayload(fields: JiraFieldDescriptor[], vals: Record<string, Val>) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.hidden) continue;
    const v = toValue(f, vals[f.id]);
    if (v !== undefined) out[f.id] = v;
  }
  return out;
}

interface Props { issue: Issue; onClose: () => void; onDone: (r: JiraWriteResult) => void }

// Preview of the Jira issue that Upload would create: base fields plus whatever Jira offers on create for the project and type.
export function JiraUploadForm({ issue, onClose, onDone }: Props) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectRef, setProjectRef] = useState('');
  const [issueType, setIssueType] = useState('');
  const [linkType, setLinkType] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [labelDraft, setLabelDraft] = useState('');
  const [vals, setVals] = useState<Record<string, Val>>({});
  const [dismissed, setDismissed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const loaded = useRef('');
  const formRef = useRef<HTMLFormElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const seq = useRef(0);

  // `first` seeds title, description and labels; later loads (type or project changed) only replace the type-specific parts.
  const load = async (q: { jiraProject?: string; issueType?: string }, first = false) => {
    const mine = ++seq.current;
    setLoading(true); setError(null); setReloadFailed(false);
    try {
      const m = await api.jiraUploadForm(issue.id, q);
      if (mine !== seq.current) return;
      setMeta(m);
      const ref = m.project.ref ?? '';
      setProjectRef(ref); loaded.current = ref;
      setIssueType(m.issueType?.name ?? '');
      setLinkType(m.link.linkType ?? '');
      setVals(seed(m.fields)); setDismissed(false);
      if (first) { setTitle(m.values.title); setDescription(m.values.description); setLabels(m.values.labels); }
    } catch (e) {
      if (mine === seq.current) { setError((e as Error).message); setReloadFailed(true); }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };
  useEffect(() => { load({}, true); return () => { seq.current++; }; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const touch = <T,>(set: (v: T) => void) => (v: T) => { setDirty(true); set(v); };
  const draftLabel = () => labelDraft.trim().replace(/\s+/g, '-');
  const withDraft = () => { const l = draftLabel(); return l && !labels.includes(l) ? [...labels, l] : labels; };
  const addLabel = () => {
    const next = withDraft();
    if (next !== labels) touch(setLabels)(next);
    setLabelDraft('');
  };
  // Leaving the label box for another control of the form keeps the text as a label; Cancel, close and clicks outside drop it.
  const labelBlur = (e: React.FocusEvent) => {
    const to = e.relatedTarget as Node | null;
    if (to && to !== cancelRef.current && formRef.current?.contains(to)) addLabel();
  };
  const fields = meta?.fields ?? [];
  const shown = fields.filter((f) => !f.hidden);
  const hiddenCount = fields.length - shown.length;
  const blocked = fields.filter((f) => f.required && isUnsupported(f));
  const missing = shown.filter((f) => f.required && !isUnsupported(f) && isEmpty(vals[f.id]));
  const needsProject = !meta?.project.locked && projectRef.trim() === '';
  const canSubmit = !!meta && !reloadFailed && !loading && !busy && title.trim() !== '' && !needsProject && issueType !== '' && blocked.length === 0 && missing.length === 0;

  const submit = async (body: Parameters<typeof api.jiraUpload>[1]) => {
    setBusy(true); setError(null);
    try { onDone(await api.jiraUpload(issue.id, body)); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !meta) return;
    submit({
      ...(meta.project.locked ? {} : { projectRef }), issueType, ...(showLinkType && linkType ? { linkType } : {}), title: title.trim(), description, labels: withDraft(), fields: toPayload(fields, vals),
    });
  };

  const field = (f: JiraFieldDescriptor) => {
    const id = `jup-${f.id}`;
    const v = vals[f.id];
    const set = touch((x: Val) => setVals((p) => ({ ...p, [f.id]: x })));
    const label = <>{f.name}{f.required && <span className="jup-req" aria-hidden="true"> *</span>}</>;
    if (isUnsupported(f)) {
      return (
        <div key={f.id} className="jup-field" role="group" aria-labelledby={`${id}-name`} aria-describedby={`${id}-why`}>
          <span id={`${id}-name`}>{label}</span>
          <div id={`${id}-why`} className="hint jup-unsupported">pjPlanner cannot fill this field{f.required ? ', but Jira requires it. Create the issue in Jira directly or ask a Jira admin to make it optional.' : '.'}</div>
        </div>
      );
    }
    const control = <FieldControl f={f} id={id} value={v} onChange={set} required={f.required} />;
    return <label key={f.id} htmlFor={id} className="jup-field">{label}{control}</label>;
  };

  const types = meta?.issueTypes ?? [];
  const linkTypes = meta?.link.linkTypes ?? [];
  const showLinkType = meta?.link.kind === 'link' && linkTypes.length > 0;
  return (
    <Modal title={<span className="row wrap"><JiraLogo size={18} />Upload to Jira</span>} dirty={dirty} onClose={onClose}>
      <form ref={formRef} className="jup" onSubmit={create} aria-label="Upload to Jira">
        <label htmlFor="jup-project">Project
          <input id="jup-project" value={projectRef} readOnly={meta?.project.locked} disabled={meta?.project.locked}
            title={meta?.project.locked ? "The project of the parent's Jira issue" : undefined}
            onChange={(e) => touch(setProjectRef)(e.target.value)}
            aria-describedby={needsProject ? 'jup-project-hint' : meta?.project.name ? 'jup-project-name' : undefined}
            onBlur={() => { const r = projectRef.trim(); if (!meta?.project.locked && r && r !== loaded.current) load({ jiraProject: r }); }} />
        </label>
        {needsProject && <div id="jup-project-hint" className="hint" role="note">Enter the Jira project id or key to load its issue types and fields.</div>}
        {meta?.project.name && <div id="jup-project-name" className="hint">{meta.project.name}{meta.project.key ? ` (${meta.project.key})` : ''}</div>}
        <label htmlFor="jup-type">Issue type
          <select id="jup-type" value={issueType} disabled={!meta || loading}
            onChange={(e) => { setDirty(true); setIssueType(e.target.value); load({ jiraProject: meta?.project.locked ? undefined : projectRef, issueType: e.target.value }); }}>
            {types.length === 0 && <option value={issueType}>{issueType}</option>}
            {types.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
        </label>
        {meta && <div className="hint" data-testid="jup-link">{meta.link.label}</div>}
        {showLinkType && (
          <label htmlFor="jup-link-type">Link type
            <select id="jup-link-type" value={linkType} onChange={(e) => touch(setLinkType)(e.target.value)}>
              {linkTypes.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
          </label>
        )}

        {meta?.match && !dismissed && (
          <div className="banner jup-match" role="status">
            Jira already has <a href={meta.match.url} target="_blank" rel="noopener noreferrer">{meta.match.key}</a> with this title.
            <span className="row wrap">
              <button type="button" disabled={busy} onClick={() => submit({ linkExisting: meta.match!.key })}>Link to it</button>
              <button type="button" onClick={() => setDismissed(true)}>Create anyway</button>
            </span>
          </div>
        )}

        <label htmlFor="jup-title">Title <span className="jup-req" aria-hidden="true">*</span>
          <input id="jup-title" value={title} required onChange={(e) => touch(setTitle)(e.target.value)} />
        </label>
        <label htmlFor="jup-desc">Description
          <textarea id="jup-desc" rows={6} value={description} onChange={(e) => touch(setDescription)(e.target.value)} />
        </label>
        <div className="jup-field">
          <label htmlFor="jup-label-input">Labels</label>
          <div className="row wrap">
            {labels.map((l) => (
              <span key={l} className="chip chip-x">{l}
                <button type="button" className="chip-remove" aria-label={`Remove label ${l}`} onClick={() => touch(setLabels)(labels.filter((x) => x !== l))}>×</button>
              </span>
            ))}
            <input id="jup-label-input" className="jup-label-input" placeholder="Add label" value={labelDraft} onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addLabel(); } }} onBlur={labelBlur} />
          </div>
        </div>

        {loading && <div className="hint" role="status">Loading Jira fields…</div>}
        {!loading && shown.map(field)}
        {!loading && hiddenCount > 0 && <div className="hint" role="note">{hiddenCount} field{hiddenCount > 1 ? 's' : ''} hidden by the project's integration settings.</div>}
        {!loading && meta?.fieldsUnavailable && <div className="hint" role="note">Jira did not tell us which fields it offers; required ones are checked by Jira.</div>}
        {!loading && blocked.length > 0 && (
          <div className="error" role="alert">Jira requires {blocked.map((f) => f.name).join(', ')}, which pjPlanner cannot fill.</div>
        )}
        {error && <div className="error" role="alert">{error}</div>}
        <div className="row modal-actions">
          <button type="submit" className="primary jira-btn" disabled={!canSubmit}><UploadIcon />{busy ? 'Creating…' : 'Create in Jira'}</button>
          <button type="button" ref={cancelRef} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
