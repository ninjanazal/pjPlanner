import { useEffect, useRef, useState } from 'react';
import type { Project } from '../types';

interface Props {
  projects: Project[];
  currentId: number | null;
  onSwitch: (id: number) => void;
  onManage: () => void;
}

// Header chip showing the active project; opens a small menu to jump to another one or to the Projects tab.
export function ProjectSwitcher({ projects, currentId, onSwitch, onManage }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = projects.find((p) => p.id === currentId) ?? projects[0];

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="project-switch" ref={root}>
      <button type="button" className="project-chip" aria-haspopup="menu" aria-expanded={open} aria-label={`Project: ${current.name}`} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.4l1.4 1.5h5.2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z" /></svg>
        <span className="project-chip-name">{current.name}</span>
        <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M1 1l4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="project-menu" role="menu" aria-label="Projects">
          {projects.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === current.id} className="project-menu-item"
              onClick={() => { setOpen(false); onSwitch(p.id); }}>
              <span className="project-check" aria-hidden="true">{p.id === current.id ? '✓' : ''}</span>
              <span className="project-menu-name">{p.name}</span>
            </button>
          ))}
          <div className="project-menu-sep" />
          <button type="button" role="menuitem" className="project-menu-item" onClick={() => { setOpen(false); onManage(); }}>
            <span className="project-check" aria-hidden="true" />
            <span>All projects…</span>
          </button>
        </div>
      )}
    </div>
  );
}
