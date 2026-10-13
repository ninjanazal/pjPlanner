import { useRef, useState } from 'react';
import { api } from '../api';
import type { Project } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { useAction } from './useAction';

interface Props {
  projects: Project[];
  currentId: number | null;
  onSwitch: (id: number) => void;
  // Called after any create / rename / delete / import; `open` is a project to switch to.
  onChanged: (open?: number) => void;
}

const readText = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsText(f);
});

export function ProjectsPage({ projects, currentId, onSwitch, onChanged }: Props) {
  const { error, run } = useAction();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: number; name: string; description: string } | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => { const p = await api.createProject({ name }); setName(''); onChanged(p.id); });
  };
  const save = () => editing && run(async () => {
    await api.updateProject(editing.id, { name: editing.name, description: editing.description });
    setEditing(null);
    onChanged();
  });
  const importFile = (f: File | undefined) => f && run(async () => {
    let data: unknown;
    try { data = JSON.parse(await readText(f)); } catch { throw new Error('That file is not valid JSON'); }
    const p = await api.importProject(data);
    onChanged(p.id);
  });

  return (
    <div className="projects-page">
      <div className="projects-bar">
        <form className="row" onSubmit={create}>
          <input aria-label="New project name" placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={!name.trim()}>Create</button>
        </form>
        <input ref={fileRef} type="file" accept=".json,application/json" aria-label="Import project file" hidden
          onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ''; }} />
        <button onClick={() => fileRef.current?.click()} title="Load a .pjplanner.json exported from any pjPlanner; it is added as a new project">Import from file…</button>
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}
      {projects.length === 0 && <p className="projects-empty">No projects yet. Create one above to start planning, or import a <code>.pjplanner.json</code> file exported from another pjPlanner.</p>}
      <ul className="project-list">
        {projects.map((p) => (
          <li key={p.id} aria-label={`Project ${p.name}`} className={p.id === currentId ? 'current' : undefined}>
            {editing?.id === p.id ? (
              <div className="project-edit">
                <input aria-label="Project name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} data-autofocus />
                <input aria-label="Project description" placeholder="Description" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
                <div className="row">
                  <button className="primary" onClick={save}>Save</button>
                  <button onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="project-info">
                  <strong>{p.name}</strong>{p.id === currentId && <span className="mcp-tag">current</span>}
                  {p.description && <div className="project-desc">{p.description}</div>}
                  <div className="project-meta">{p.moduleCount} modules · {p.issueCount} issues · {p.sprintCount} sprints</div>
                </div>
                <div className="row project-actions">
                  {p.id !== currentId && <button onClick={() => onSwitch(p.id)}>Open</button>}
                  <button onClick={() => setEditing({ id: p.id, name: p.name, description: p.description })}>Rename</button>
                  <a className="button" href={`/api/projects/${p.id}/export`} download aria-label={`Export ${p.name}`}>Export</a>
                  <button className="danger" onClick={() => setDeleting(p)}>Delete</button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {deleting && (
        <ConfirmDialog message={`Delete project "${deleting.name}" and everything in it (${deleting.moduleCount} modules, ${deleting.issueCount} issues)? This cannot be undone. Export it first to keep a copy.`}
          confirmLabel="Delete project"
          onCancel={() => setDeleting(null)}
          onConfirm={() => { const d = deleting; setDeleting(null); run(async () => { await api.deleteProject(d.id); onChanged(); }); }} />
      )}
    </div>
  );
}
