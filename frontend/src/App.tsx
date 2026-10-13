import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, getProjectId, setProjectId } from './api';
import type { Graph, Issue, Module, Project, Relation, Sprint } from './types';
import { GraphView } from './components/GraphView';
import { ModuleDialog } from './components/ModuleDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { LinkDialog } from './components/LinkDialog';
import { OwnersPage } from './components/OwnersPage';
import { IssuesPanel } from './components/IssuesPanel';
import { IssuesPage } from './components/IssuesPage';
import { SprintsPage } from './components/SprintsPage';
import { GroupsPage } from './components/GroupsPage';
import { ownerMap, sprintHeat } from './heatmap';
import { autoAssign, OWNERS_PER_MODULE } from './autoAssign';
import { LockButton } from './components/LockButton';
import { McpDialog } from './components/McpDialog';
import { ProjectsPage } from './components/ProjectsPage';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { useHashRoute } from './route';
import { useTheme } from './theme';

type Dialog = { kind: 'module' | 'link'; id: number } | { kind: 'new' } | null;

export default function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  // selectedId is the highlighted card (stays after its popup closes); dialog is the open popup.
  const [issues, setIssues] = useState<Issue[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [issueSel, setIssueSel] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [noProjects, setNoProjects] = useState(false); // the server answered and has no project yet
  const [projectId, setProject] = useState<number | null>(getProjectId());
  const [heatSprint, setHeatSprint] = useState<number | null>(null);
  const [personId, setPersonId] = useState<number | null>(null);
  const heat = useMemo(() => (heatSprint != null && sprints.some((x) => x.id === heatSprint) ? sprintHeat(issues, heatSprint) : null), [issues, sprints, heatSprint]);
  const [error, setError] = useState<string | null>(null);
  const { theme, toggle } = useTheme();
  const [route, go] = useHashRoute();
  const [picked, setPicked] = useState<number[]>([]); // cards selected on the diagram (may be several)
  const clip = useRef<{ modules: Module[]; relations: Relation[] } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number[] | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);

  // "No project yet" is not an error: the Projects page explains it.
  const fail = (e: unknown) => { if (!(e instanceof ApiError && e.code === 'no_project')) setError((e as Error).message); };
  const refresh = useCallback(async () => {
    try { setGraph(await api.getGraph()); setError(null); } catch (e) { fail(e); }
  }, []);
  const refreshIssues = useCallback(async () => {
    try { const l = await api.listIssues(); setIssues(Array.isArray(l) ? l : []); } catch (e) { fail(e); }
  }, []);
  const refreshSprints = useCallback(async () => {
    try { const l = await api.listSprints(); setSprints(Array.isArray(l) ? l : []); } catch (e) { fail(e); }
  }, []);
  // Sprint counts depend on issues, so issue changes reload sprints too.
  const refreshIssuesAndSprints = useCallback(async () => { await Promise.all([refreshIssues(), refreshSprints()]); }, [refreshIssues, refreshSprints]);
  // Module/owner deletes cascade into issue links, so graph refreshes also reload issues.
  const refreshAll = useCallback(async () => { await Promise.all([refresh(), refreshIssues(), refreshSprints()]); }, [refresh, refreshIssues, refreshSprints]);
  useEffect(() => { refreshAll(); }, [refreshAll]);

  // Per-project view state must not leak into the next project.
  const resetView = () => { setSelectedId(null); setIssueSel(null); setDialog(null); setHeatSprint(null); setPersonId(null); setFocusId(null); };
  const switchProject = useCallback((id: number) => {
    if (id === getProjectId()) return;
    setProjectId(id);
    setProject(id);
    resetView();
    setGraph(null);
    refreshAll();
  }, [refreshAll]);
  // Loads the project list; a remembered project that no longer exists (deleted, other server) falls back to the first.
  const loadProjects = useCallback(async (open?: number) => {
    let list: Project[] = [];
    let known = true;
    try {
      const l = await api.listProjects();
      if (!Array.isArray(l)) throw new Error('unexpected response');
      list = l;
    } catch { known = false; /* older server: single project */ }
    setProjects(list);
    setNoProjects(known && list.length === 0);
    if (list.length === 0) {
      if (known) { setProjectId(null); setProject(null); resetView(); setGraph(null); setIssues([]); setSprints([]); setError(null); }
      return;
    }
    const want = open ?? getProjectId();
    const pick = list.find((p) => p.id === want) ?? list[0];
    if (pick.id !== getProjectId() || open !== undefined) {
      setProjectId(pick.id);
      setProject(pick.id);
      resetView();
      setGraph(null);
      refreshAll();
    } else setProject(pick.id);
  }, [refreshAll]);
  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => { if (route !== 'diagram') { setFocusId(null); setDialog(null); } }, [route]);

  // Diagram shortcuts: Del removes, Ctrl+C / Ctrl+V copy and paste the selected cards (and the links between them).
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (route !== 'diagram' || !graph || dialog || pendingDelete || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const ids = picked.length ? picked : selectedId != null ? [selectedId] : [];
    const mod = e.ctrlKey || e.metaKey;
    if ((e.key === 'Delete' || e.key === 'Backspace') && ids.length) { e.preventDefault(); setPendingDelete(ids); }
    else if (mod && e.key.toLowerCase() === 'c' && ids.length) {
      const set = new Set(ids);
      clip.current = { modules: graph.modules.filter((m) => set.has(m.id)), relations: graph.relations.filter((r) => set.has(r.sourceId) && set.has(r.targetId)) };
    } else if (mod && e.key.toLowerCase() === 'v' && clip.current) { e.preventDefault(); pasteClip(); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);
  const pasteClip = async () => {
    const c = clip.current;
    if (!c || noProjects) return;
    try {
      const made = new Map<number, number>();
      for (const m of c.modules) {
        const body = {
          name: `${m.name} (copy)`, description: m.description, ownerIds: m.ownerIds, color: m.color, icon: m.icon, textColor: m.textColor,
          strokeColor: m.strokeColor, strokeStyle: m.strokeStyle, apiItems: m.apiItems.map(({ id: _id, ...rest }) => rest), groupId: m.groupId,
        };
        const n = await api.createModule(body);
        made.set(m.id, n.id);
        if (m.x != null && m.y != null) await api.setPosition(n.id, { x: m.x + 40, y: m.y + 40 });
      }
      for (const r of c.relations) await api.createRelation({ sourceId: made.get(r.sourceId)!, targetId: made.get(r.targetId)!, label: r.label, color: r.color });
      await refresh();
      const first = [...made.values()][0];
      if (first) setSelectedId(first);
    } catch (e) { setError((e as Error).message); }
  };
  const deleteCards = async (ids: number[]) => {
    setPendingDelete(null);
    try {
      for (const id of ids) await api.deleteModule(id);
      setSelectedId(null); setPicked([]);
      await refreshAll();
    } catch (e) { setError((e as Error).message); }
  };

  if (noProjects) {
    return (
      <div className="app">
        <header>
          <div className="header-left"><h1>pjPlanner</h1></div>
          <div />
          <div className="row"><LockButton /><button className="icon-btn" onClick={toggle} aria-label="Toggle theme" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>{theme === 'dark' ? '☀️' : '🌙'}</button></div>
        </header>
        <ProjectsPage projects={[]} currentId={null} onSwitch={switchProject} onChanged={(open) => loadProjects(open)} />
      </div>
    );
  }
  if (!graph) return <div className="center">{error ? <span className="error">{error}</span> : 'Loading...'}</div>;

  const changed = (select?: number | null) => {
    if (select) { setSelectedId(select); setDialog({ kind: 'module', id: select }); } else { setSelectedId(null); setDialog(null); }
    refreshAll();
  };

  const connect = async (sourceId: number, targetId: number) => {
    try {
      const rel = await api.createRelation({ sourceId, targetId });
      await refresh();
      setDialog({ kind: 'link', id: rel.id });
    } catch (e) { setError((e as Error).message); }
  };
  const nodeClick = (id: number) => { setSelectedId(id); setDialog({ kind: 'module', id }); };
  const openModule = (id: number) => { setSelectedId(id); setDialog({ kind: 'module', id }); setFocusId(id); go('diagram'); };
  const assignGroup = async (id: number, groupId: number | null) => {
    const m = graph.modules.find((x) => x.id === id);
    if (!m) return;
    try {
      await api.updateModule(id, {
        name: m.name, description: m.description, ownerIds: m.ownerIds, color: m.color, icon: m.icon,
        textColor: m.textColor, strokeColor: m.strokeColor, strokeStyle: m.strokeStyle, apiItems: m.apiItems, groupId,
      });
      await refresh();
    } catch (e) { setError((e as Error).message); }
  };
  const needsOwners = graph.modules.some((m) => m.ownerIds.length < OWNERS_PER_MODULE);
  const assignOwners = async () => {
    const changes = autoAssign(graph.modules, graph.owners);
    if (changes.size === 0) { setError('Add owners first (Owners tab); there is nobody to assign.'); return; }
    try {
      await Promise.all([...changes].map(([id, ownerIds]) => {
        const m = graph.modules.find((x) => x.id === id)!;
        return api.updateModule(id, {
          name: m.name, description: m.description, ownerIds, color: m.color, icon: m.icon,
          textColor: m.textColor, strokeColor: m.strokeColor, strokeStyle: m.strokeStyle, apiItems: m.apiItems, groupId: m.groupId,
        });
      }));
      await refresh();
    } catch (e) { setError((e as Error).message); }
  };
  // Keep the in-memory graph in step with saved positions so a remounted diagram starts from them.
  const patchPositions = (pos: { id: number; x: number | null; y: number | null }[]) => {
    const by = new Map(pos.map((p) => [p.id, p]));
    setGraph((g) => g && { ...g, modules: g.modules.map((m) => { const p = by.get(m.id); return p ? { ...m, x: p.x, y: p.y } : m; }) });
  };
  const move = (id: number, x: number, y: number) =>
    api.setPosition(id, { x, y })
      .then((m) => patchPositions([{ id, x: m?.x ?? x, y: m?.y ?? y }]))
      .catch((e) => setError((e as Error).message));
  const moveMany = async (positions: { id: number; x: number; y: number }[]) => {
    try {
      const saved = await api.setPositions(positions);
      const back = new Map((saved ?? []).map((m) => [m.id, m]));
      patchPositions(positions.map((p) => ({ id: p.id, x: back.get(p.id)?.x ?? p.x, y: back.get(p.id)?.y ?? p.y })));
      return true;
    } catch (e) { setError((e as Error).message); return false; }
  };

  const module = dialog?.kind === 'module' ? graph.modules.find((m) => m.id === dialog.id) : undefined;
  const relation = dialog?.kind === 'link' ? graph.relations.find((r) => r.id === dialog.id) : undefined;
  const selectedModule = graph.modules.find((m) => m.id === selectedId);
  const personSel = graph.owners.find((o) => o.id === personId);
  const person = personSel ? ownerMap(issues, graph.modules, sprints, personSel.id, personSel.color) : null;
  const heatSel = sprints.find((x) => x.id === heatSprint);
  const selIssue = issues.find((i) => i.id === issueSel);
  const highlight = dialog?.kind === 'link' ? dialog : selectedModule ? { kind: 'module' as const, id: selectedModule.id } : null;

  const diagramTools = (
    <>
      <button className="toolbar-btn primary-tool" onClick={() => setDialog({ kind: 'new' })}>+ Add module</button>
      {needsOwners && <button className="toolbar-btn" onClick={assignOwners} title={`Give every module ${OWNERS_PER_MODULE} owners, spreading the work evenly`}>Auto-assign</button>}
      {(sprints.length > 0 || graph.owners.length > 0) && (
        <label className="view-pick toolbar-btn" title="Colour the diagram by sprint load or by person">
          <span aria-hidden="true">{personSel ? '👤' : heatSel ? '🔥' : '🎨'}</span>
          <select aria-label="Diagram view" value={personSel ? `p${personSel.id}` : heatSel ? `h${heatSel.id}` : ''}
            onChange={(e) => {
              const v = e.target.value;
              setHeatSprint(v.startsWith('h') ? Number(v.slice(1)) : null);
              setPersonId(v.startsWith('p') ? Number(v.slice(1)) : null);
            }}>
            <option value="">View: normal</option>
            {sprints.length > 0 && <optgroup label="Heatmap (open tasks)">{sprints.map((x) => <option key={x.id} value={`h${x.id}`}>{x.name}{x.state === 'active' ? ' (active)' : x.state === 'closed' ? ' (closed)' : ''}</option>)}</optgroup>}
            {graph.owners.length > 0 && <optgroup label="Person">{graph.owners.map((o) => <option key={o.id} value={`p${o.id}`}>{o.icon ? `${o.icon} ` : ''}{o.name}</option>)}</optgroup>}
          </select>
          {heatSel && <span className="heat-legend" aria-hidden="true" title="Open tasks per module: cold to hot"><i>cold</i><b /><i>hot</i></span>}
          {personSel && <span className="heat-legend" aria-hidden="true" title="Solid = modules they own; light = modules where they have sprint tasks; grey = none"><i>★ owns</i><i>· helps</i></span>}
        </label>
      )}
    </>
  );

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <h1>pjPlanner</h1>
          {projects.length > 0 && (
            <ProjectSwitcher projects={projects} currentId={projectId} onSwitch={switchProject} onManage={() => go('projects')} />
          )}
        </div>
        <div className="row">
          <nav aria-label="Main">
            <button className={`nav-item${route === 'diagram' ? ' active' : ''}`} aria-current={route === 'diagram' ? 'page' : undefined} onClick={() => go('diagram')}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="1.5" y="2" width="5" height="4" rx="1" /><rect x="9.5" y="10" width="5" height="4" rx="1" /><path d="M6.5 4h3v8h0" /></svg>
              Diagram
            </button>
            <button className={`nav-item${route === 'owners' ? ' active' : ''}`} aria-current={route === 'owners' ? 'page' : undefined} onClick={() => go('owners')}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="6" cy="5" r="2.5" /><path d="M1.5 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" /><circle cx="11.5" cy="5.5" r="1.8" /><path d="M11.5 9.5c2 0 3.5 1 3.5 3" /></svg>
              Owners
            </button>
            <button className={`nav-item${route === 'groups' ? ' active' : ''}`} aria-current={route === 'groups' ? 'page' : undefined} onClick={() => go('groups')}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="1.5" y="2" width="13" height="12" rx="2" strokeDasharray="3 2" /><rect x="4" y="6" width="3.5" height="4" rx="1" /><rect x="9" y="6" width="3" height="4" rx="1" /></svg>
              Groups
            </button>
            <span className="nav-sep" aria-hidden="true" />
            <button className={`nav-item${route === 'projects' ? ' active' : ''}`} aria-current={route === 'projects' ? 'page' : undefined} onClick={() => go('projects')}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.4l1.4 1.5h5.2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z" /></svg>
              Projects
            </button>
            <button className={`nav-item${route === 'sprints' ? ' active' : ''}`} aria-current={route === 'sprints' ? 'page' : undefined} onClick={() => go('sprints')}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 8a6 6 0 0 1 10.5-4M14 8a6 6 0 0 1-10.5 4" /><path d="M12.5 1v3h-3M3.5 15v-3h3" /></svg>
              Sprints
            </button>
            <button className={`nav-item${route === 'issues' ? ' active' : ''}`} aria-current={route === 'issues' ? 'page' : undefined} onClick={() => go('issues')}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4M8 11v.5" /></svg>
              Issues
            </button>
          </nav>
        </div>
        <div className="row">
          <LockButton />
          <button className="icon-btn" onClick={() => setMcpOpen(true)} aria-label="Connect agent" title="Connect an AI agent (MCP)">
            <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5.5 1.5v3M10.5 1.5v3M3.5 4.5h9v3a4.5 4.5 0 0 1-9 0zM8 12v2.5" /></svg>
          </button>
          <button className="icon-btn" onClick={toggle} aria-label="Toggle theme" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>{theme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </header>
      {mcpOpen && <McpDialog onClose={() => setMcpOpen(false)} />}
      {error && <div className="banner error" role="alert">{error}</div>}
      {route === 'projects' ? (
        <ProjectsPage projects={projects} currentId={projectId} onSwitch={switchProject} onChanged={(open) => loadProjects(open)} />
      ) : route === 'sprints' ? (
        <SprintsPage sprints={sprints} issues={issues} modules={graph.modules} owners={graph.owners} relations={graph.relations} onChanged={refreshIssuesAndSprints} />
      ) : route === 'issues' ? (
        <IssuesPage issues={issues} sprints={sprints} modules={graph.modules} owners={graph.owners} onChanged={refreshIssuesAndSprints} />
      ) : route === 'groups' ? (
        <GroupsPage graph={graph} onChanged={refreshAll} onOpenModule={openModule} />
      ) : route === 'owners' ? (
        <OwnersPage graph={graph} onChanged={refreshAll} onOpenModule={openModule} />
      ) : (
      <main>
        {graph.modules.length === 0 ? (
          <div className="center">No modules yet.<div className="empty-tools">{diagramTools}</div></div>
        ) : (
          <GraphView
            theme={theme}
            graph={graph}
            selected={highlight}
            onNodeClick={nodeClick}
            onAssignGroup={assignGroup}
            onLinkClick={(id) => setDialog({ kind: 'link', id })}
            onPaneClick={() => setSelectedId(null)}
            onSelectionChange={(ids) => setPicked((p) => (p.length === ids.length && p.every((x, i) => x === ids[i]) ? p : ids))}
            onConnect={connect}
            onMove={move}
            onMoveMany={moveMany}
            focusId={focusId}
            highlightedModuleIds={selIssue ? selIssue.rollupModuleIds : null}
            heat={heat}
            person={person}
            tools={diagramTools}
          />
        )}
        <IssuesPanel issues={issues} sprints={sprints} modules={graph.modules} owners={graph.owners} selectedId={selIssue ? selIssue.id : null}
          onSelect={setIssueSel} onChanged={refreshIssuesAndSprints} />
        {dialog?.kind === 'new' && <ModuleDialog key="new" theme={theme} graph={graph} module={null} onChanged={changed} onClose={() => setDialog(null)} />}
        {module && <ModuleDialog key={`m${module.id}`} theme={theme} graph={graph} issues={issues} module={module} onChanged={changed} onClose={() => setDialog(null)} />}
        {pendingDelete && (
          <ConfirmDialog message={`Delete ${pendingDelete.length === 1 ? `module "${graph.modules.find((m) => m.id === pendingDelete[0])?.name ?? ''}"` : `${pendingDelete.length} modules`}? Their relations are deleted too.`}
            onConfirm={() => deleteCards(pendingDelete)} onCancel={() => setPendingDelete(null)} />
        )}
        {relation && <LinkDialog key={`l${relation.id}`} theme={theme} graph={graph} relation={relation} onChanged={() => { setDialog(null); refreshAll(); }} onClose={() => setDialog(null)} />}
      </main>
      )}
    </div>
  );
}
