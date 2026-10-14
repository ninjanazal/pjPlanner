import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { TYPE_ICON, type Issue, type JiraCreateFields, type JiraImportResult, type JiraUploadConfig, type JiraInfo, type JiraPreview, type JiraStatus, type Project } from '../types';
import { FieldControl, fromValue, isEmpty, isUnsupported, toValue, type Val } from './jiraFieldControl';
import { JiraLogo } from './JiraLogo';
import { useAction } from './useAction';

export interface PanelProps {
  project: Project | null;
  status: JiraStatus;
  issues?: Issue[];       // the project's issues, to show how many came from Jira
  onChanged: () => void;  // the project's settings changed
  onImported: () => void; // issues were imported
  onDirty: (dirty: boolean) => void;
}

type Busy = 'test' | 'preview' | 'save' | 'import' | null;
type Health = { kind: 'idle' } | { kind: 'ok'; info: JiraInfo } | { kind: 'fail'; message: string };

const EMPTY_CFG: JiraUploadConfig = { hidden: [], defaults: {} };
const normCfg = (c: JiraUploadConfig) => JSON.stringify({ hidden: [...new Set(c.hidden)].sort(), defaults: Object.fromEntries(Object.entries(c.defaults).sort(([a], [b]) => (a < b ? -1 : 1))) });

const counts = (m: Record<string, number>) => Object.entries(m);

// SQLite timestamps are UTC without a zone ("2026-10-13 18:00:00").
export function ago(ts: string, now = Date.now()): string {
  const t = Date.parse(`${ts.replace(' ', 'T')}Z`);
  if (Number.isNaN(t)) return ts;
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 60 / 24)} d ago`;
}

const Stat = ({ n, label }: { n: number; label: string }) => (
  <div className="integ-stat"><b>{n}</b><span>{label}</span></div>
);

// The Jira integration panel. The URL and token live in the server's .env.
export function JiraIntegrationPanel({ project, status, issues = [], onChanged, onImported, onDirty }: PanelProps) {
  const { error, run } = useAction();
  const [busy, setBusy] = useState<Busy>(null);
  const [health, setHealth] = useState<Health>({ kind: 'idle' });
  const saved = project?.jiraJql ?? '';
  const savedLabel = project?.jiraLabel ?? '';
  const [jql, setJql] = useState(saved);
  const [label, setLabel] = useState(savedLabel);
  const savedPid = project?.jiraProjectId ?? '';
  const [pid, setPid] = useState(savedPid);
  const [preview, setPreview] = useState<JiraPreview | null>(null);
  const [result, setResult] = useState<JiraImportResult | null>(null);
  const hasFilter = Boolean(jql.trim() || label.trim());
  const hasSaved = Boolean(saved || savedLabel);
  const pidDirty = pid.trim() !== savedPid;
  const savedCfg = project?.jiraUploadConfig ?? EMPTY_CFG;
  const [edits, setEdits] = useState<Record<string, { show?: boolean; def?: Val }>>({});
  const [meta, setMeta] = useState<JiraCreateFields | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const seq = useRef(0);
  const enabledNow = Boolean(project?.jiraEnabled);
  const baseUrl = status.url?.replace(/\/+$/, '');
  const loadFields = async (issueType?: string) => {
    const mine = ++seq.current;
    setMetaLoading(true); setMetaError(null);
    try {
      const m = await api.jiraCreateFields(issueType ? { issueType } : {});
      if (mine === seq.current) { setMeta(m); setEdits({}); }
    } catch (e) {
      if (mine === seq.current) { setMeta(null); setMetaError((e as Error).message); }
    } finally {
      if (mine === seq.current) setMetaLoading(false);
    }
  };
  useEffect(() => {
    if (enabledNow && savedPid && project) loadFields(); else { seq.current++; setMeta(null); setEdits({}); }
    return () => { seq.current++; };
  }, [enabledNow, savedPid, project?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (meta?.fields ?? []).map((f) => {
    const e = edits[f.id];
    const show = e?.show ?? !savedCfg.hidden.includes(f.id);
    const def = e && 'def' in e ? e.def : fromValue(f, savedCfg.defaults[f.id]);
    return { f, show, def, hasDef: !isEmpty(def) };
  }), [meta, edits, savedCfg]);
  const draftCfg = useMemo<JiraUploadConfig>(() => {
    const ids = new Set(rows.filter((r) => !isUnsupported(r.f)).map((r) => r.f.id));
    const hidden = savedCfg.hidden.filter((i) => !ids.has(i));
    const defaults = Object.fromEntries(Object.entries(savedCfg.defaults).filter(([i]) => !ids.has(i)));
    for (const r of rows) {
      if (isUnsupported(r.f)) continue;
      if (!r.show) hidden.push(r.f.id);
      const v = toValue(r.f, r.def);
      if (v !== undefined) defaults[r.f.id] = v;
    }
    return { hidden, defaults };
  }, [rows, savedCfg]);
  const cfgDirty = Object.keys(edits).length > 0 && normCfg(draftCfg) !== normCfg(savedCfg);
  const cfgInvalid = rows.some((r) => !r.show && r.f.required && !r.hasDef);
  const setEdit = (id: string, patch: { show?: boolean; def?: Val }) => setEdits((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  const dirty = jql.trim() !== saved || label.trim() !== savedLabel || pidDirty || cfgDirty;
  const filterDirty = jql.trim() !== saved || label.trim() !== savedLabel;
  const writeAllowed = Boolean(status.writeAllowed);

  const act = async (name: Exclude<Busy, null>, fn: () => Promise<unknown>) => {
    setBusy(name);
    try { await run(fn); } finally { setBusy(null); }
  };
  useEffect(() => { onDirty(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onDirty(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const test = async () => {
    setBusy('test');
    try { setHealth({ kind: 'ok', info: await api.jiraTest() }); }
    catch (e) { setHealth({ kind: 'fail', message: (e as Error).message }); }
    finally { setBusy(null); }
  };
  const doPreview = () => act('preview', async () => {
    setResult(null);
    setPreview(await api.jiraPreview({ ...(jql.trim() ? { jql: jql.trim() } : {}), ...(label.trim() ? { label: label.trim() } : {}) }));
  });
  const patchProject = (patch: Omit<Parameters<typeof api.updateProject>[1], 'name'>, after?: () => void) => project && act('save', async () => {
    await api.updateProject(project.id, { name: project.name, ...patch });
    after?.();
    onChanged();
  });
  const save = (clear = false) => patchProject({ jiraJql: clear ? null : jql.trim() || null, jiraLabel: clear ? null : label.trim() || null }, clear ? () => { setJql(''); setLabel(''); setPreview(null); } : undefined);
  const savePid = () => patchProject({ jiraProjectId: pid.trim() || null });
  const saveCfg = (cfg: JiraUploadConfig | null) => patchProject({ jiraUploadConfig: cfg }, () => setEdits({}));
  const toggleWrite = (on: boolean) => patchProject({ jiraWrite: on });
  const toggleEnabled = (on: boolean) => patchProject({ jiraEnabled: on });
  const doImport = () => project && act('import', async () => { setResult(await api.jiraImport(project.id)); setPreview(null); onChanged(); onImported(); });

  const imported = issues.filter((i) => i.jiraKey);
  const done = imported.filter((i) => i.state === 'closed').length;
  const configured = Boolean(status.configured);
  const available = status.available ?? configured;
  const missing = status.missing?.length ? status.missing : ['JIRA_URL', 'JIRA_TOKEN'];
  const enabled = enabledNow;
  const dot = !available ? 'off' : health.kind === 'fail' ? 'bad' : enabled ? 'ok' : 'off';
  const dotText = !available ? 'Unavailable' : !enabled ? 'Disabled' : health.kind === 'fail' ? 'Connection failed' : 'Enabled';
  const tag = !available ? 'unavailable' : !enabled ? 'disabled' : writeAllowed && project?.jiraWrite ? 'read and write' : 'read-only';

  return (
    <>
      {error && <div className="banner error" role="alert">{error}</div>}
      <div className="integ">
          <section className="integ-card" aria-label="Jira">
            <div className="integ-head">
              <span className="integ-logo" aria-hidden="true"><JiraLogo size={22} /></span>
              <div className="integ-title">
                <strong>Jira</strong>
                <span className="integ-status"><span className={`status-dot ${dot}`} aria-hidden="true" />{dotText}</span>
              </div>
              <span className="mcp-tag opt">{tag}</span>
              {available && <button onClick={test} disabled={busy === 'test'}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>}
            </div>
            {available ? (
              <div className="project-meta">{status.url}</div>
            ) : (
              <p className="project-desc" role="status">Missing: {missing.join(', ')} in <code>.env</code>. Fill {missing.length > 1 ? 'them' : 'it'} in and restart the server to make Jira available. pjPlanner only reads from Jira unless writing is enabled.</p>
            )}
            {project && (
              <label className="check" htmlFor="jira-enabled">
                <input id="jira-enabled" type="checkbox" checked={enabled} disabled={!available || busy !== null} onChange={(e) => toggleEnabled(e.target.checked)} />
                Enable Jira
              </label>
            )}
            {health.kind === 'ok' && <div className="integ-note ok" role="status">Connected as <b>{health.info.user.displayName}</b> · Jira {health.info.version} ({health.info.deploymentType})</div>}
            {health.kind === 'fail' && <div className="integ-note bad" role="alert">{health.message}</div>}

          {available && (project ? (
            <fieldset className="integ-off" disabled={!enabled} aria-label="Jira settings">
              {!enabled && <div className="project-meta">Jira is disabled for this project: import and writing are off. Settings and imported keys are kept.</div>}
              <section className="integ-section" aria-label="Sync">
                <div className="integ-section-title">Synchronisation</div>
                <div className="integ-sync">
                  <div className="integ-stats">
                    <Stat n={imported.length} label="from Jira" />
                    <Stat n={imported.length - done} label="unfinished" />
                    <Stat n={done} label="closed" />
                  </div>
                  <div className="integ-sync-action">
                    <button className="primary" onClick={doImport} disabled={!hasSaved || filterDirty || busy !== null}
                      title={!hasSaved ? 'Save a filter first' : filterDirty ? 'Save the filter first' : 'Read the matching issues from Jira into this project'}>
                      <span aria-hidden="true" className={busy === 'import' ? 'spin' : undefined}>↻</span> {busy === 'import' ? 'Importing…' : 'Import from Jira'}
                    </button>
                    <span className="project-meta">{project.jiraSyncedAt ? `Last synced ${ago(project.jiraSyncedAt)}` : hasSaved && !filterDirty ? 'Not synced yet' : 'Save a filter to sync'}</span>
                  </div>
                </div>
                {result && (
                  <div role="status" className="integ-note ok">
                    <b>Synced.</b> {result.created} new, {result.updated} updated{result.linked ? `, ${result.linked} linked to existing issues` : ""}
                    {counts(result.skipped).length > 0 && <>, skipped {counts(result.skipped).map(([k, n]) => `${k} ${n}`).join(', ')}</>}
                    {result.notInFilter > 0 && <>. {result.notInFilter} earlier import{result.notInFilter > 1 ? 's' : ''} no longer match the filter (left as they are)</>}.
                  </div>
                )}
              </section>

              <section className="integ-section" aria-label="Jira write">
                <div className="integ-section-title">Writing to Jira</div>
                <label className="check" htmlFor="jira-write">
                  <input id="jira-write" type="checkbox" checked={Boolean(project.jiraWrite)} disabled={!writeAllowed || busy !== null} onChange={(e) => toggleWrite(e.target.checked)} />
                  Allow writing to Jira
                </label>
                {writeAllowed
                  ? <div className="project-meta">Issues can then be uploaded and updated from their page. An issue with a parent already in Jira is created in the parent's Jira project; a root issue is created in the Jira project below.</div>
                  : <div className="project-meta">Set <code>JIRA_WRITE=1</code> in <code>.env</code> and restart the server to allow this.</div>}
                <label htmlFor="jira-project-id">Jira project id or key <span className="hint">where root issues are created</span></label>
                <input id="jira-project-id" aria-label="Jira project id" placeholder="e.g. 10000 or PROJ" value={pid} onChange={(e) => setPid(e.target.value)} spellCheck={false} />
                <div className="hint">Find it by opening {baseUrl ? <a href={`${baseUrl}/rest/api/2/project/YOURKEY`} target="_blank" rel="noopener noreferrer">{baseUrl}/rest/api/2/project/YOURKEY</a> : <code>&lt;JIRA_URL&gt;/rest/api/2/project/YOURKEY</code>} while logged in. The project key (e.g. PROJ) works as is; the numeric id (e.g. 10000) is the "id" field in that response.</div>
                <div className="row wrap integ-actions">
                  <button className="primary" onClick={savePid} disabled={!pidDirty || /\s/.test(pid.trim()) || busy !== null}>{busy === 'save' ? 'Saving…' : 'Save project id'}</button>
                </div>
              </section>

              <section className="integ-section" aria-label="Upload form">
                <div className="integ-section-title">Upload form</div>
                {!savedPid ? <div className="project-meta">Set the Jira project id first.</div> : (
                  <>
                    <div className="project-meta">Choose which Jira fields the upload form shows and what they default to, for the whole project, keyed by Jira field id. A hidden field sends its default, or nothing.</div>
                    {metaError && <div className="integ-note bad" role="alert">{metaError}</div>}
                    {metaLoading && <div className="hint" role="status">Loading Jira fields…</div>}
                    {meta && !metaLoading && (
                      <>
                        <label htmlFor="jira-cfg-type">Issue type</label>
                        <select id="jira-cfg-type" value={meta.issueType?.name ?? ''} disabled={cfgDirty || busy !== null}
                          title={cfgDirty ? 'Save or discard changes before switching type' : undefined} onChange={(e) => loadFields(e.target.value)}>
                          {meta.issueTypes.length === 0 && <option value="">{meta.issueType?.name ?? 'None'}</option>}
                          {meta.issueTypes.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                        </select>
                        {meta.fieldsUnavailable && <div className="hint" role="note">Jira did not tell us which fields it offers.</div>}
                        {rows.length === 0 && !meta.fieldsUnavailable && <div className="project-meta">No configurable fields for this type.</div>}
                        <ul className="integ-fields">
                          {rows.map(({ f, show, def, hasDef }) => (
                            <li key={f.id} className="integ-field-row" aria-label={f.name}>
                              <div className="integ-field-name">
                                <b>{f.name}</b> <code>{f.id}</code>{f.required && <span className="mcp-tag">required</span>}
                              </div>
                              {isUnsupported(f) ? <div className="hint">pjPlanner cannot fill this field.</div> : (
                                <>
                                  <label className="check">
                                    <input type="checkbox" aria-label={`Show ${f.name}`} checked={show} disabled={busy !== null || (f.required && show && !hasDef)}
                                      title={f.required && show && !hasDef ? 'Set a default to hide a required field' : undefined}
                                      onChange={(e) => setEdit(f.id, { show: e.target.checked })} />
                                    Show
                                  </label>
                                  <FieldControl f={f} id={`jira-cfg-${f.id}`} ariaLabel={`Default for ${f.name}`} value={def} onChange={(v) => setEdit(f.id, { def: v })} />
                                  {!show && f.required && !hasDef && <div className="hint" role="note">A required field needs a default to stay hidden.</div>}
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <div className="row wrap integ-actions">
                      <button className="primary" onClick={() => saveCfg(draftCfg)} disabled={!cfgDirty || cfgInvalid || busy !== null}>{busy === 'save' ? 'Saving…' : 'Save upload form'}</button>
                      {project.jiraUploadConfig && <button className="link-danger" onClick={() => saveCfg(null)} disabled={busy !== null}>Reset to defaults</button>}
                    </div>
                  </>
                )}
              </section>

              <section className="integ-section" aria-label="Jira filter">
                <div className="integ-section-title">Which Jira issues “{project.name}” tracks</div>
                <label htmlFor="jira-jql">JQL query <span className="hint">selects the issues to import</span></label>
                <textarea id="jira-jql" aria-label="JQL" rows={3} placeholder={'"Project ID" = RD_230'} value={jql} onChange={(e) => setJql(e.target.value)} spellCheck={false} />
                <label htmlFor="jira-label">Tracking label <span className="hint">(optional) only issues carrying this Jira label are imported</span></label>
                <input id="jira-label" aria-label="Tracking label" placeholder="e.g. pjplanner" value={label} onChange={(e) => setLabel(e.target.value)} spellCheck={false} />
                <div className="row wrap integ-actions">
                  <button className="primary" onClick={() => save()} disabled={!hasFilter || !filterDirty || busy !== null}>{busy === 'save' ? 'Saving…' : 'Save filter'}</button>
                  <button onClick={doPreview} disabled={!hasFilter || busy !== null}>{busy === 'preview' ? 'Checking…' : 'Preview'}</button>
                  {hasSaved && <button className="link-danger" onClick={() => save(true)} disabled={busy !== null}>Remove filter</button>}
                </div>
                {preview && (
                  <div className="integ-preview" aria-label="Preview">
                    <div className="integ-stats">
                      <Stat n={preview.total} label="match" />
                      <Stat n={preview.importable} label="importable" />
                      <Stat n={preview.total - preview.importable} label="skipped" />
                    </div>
                    <div className="integ-chips" aria-label="By Jira type">{counts(preview.byType).map(([k, n]) => <span key={k} className={`mcp-tag${preview.skipped[k] ? ' opt' : ''}`}>{k} {n}</span>)}</div>
                    {Object.keys(preview.skipped).length > 0 && <div className="project-meta">Skipped (no matching issue type): {counts(preview.skipped).map(([k, n]) => `${k} ${n}`).join(', ')}</div>}
                    <ul>{preview.sample.map((i) => <li key={i.key}><span aria-hidden="true">{TYPE_ICON[i.type]}</span> <code>{i.key}</code> {i.title}</li>)}</ul>
                    {preview.total > preview.sample.length && <div className="project-meta">…and {preview.total - preview.sample.length} more</div>}
                  </div>
                )}
              </section>
            </fieldset>
          ) : <p className="project-desc">Create or open a project first.</p>)}
          </section>
      </div>
    </>
  );
}
