import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectsPage } from '../components/ProjectsPage';
import { ProjectSwitcher } from '../components/ProjectSwitcher';
import { parseHash } from '../route';
import { api, getProjectId, setProjectId } from '../api';
import type { Project } from '../types';

const proj = (id: number, name: string, extra: Partial<Project> = {}): Project => ({
  id, name, description: '', createdAt: '', moduleCount: 2, issueCount: 3, sprintCount: 1, ...extra,
});
const mockFetch = (status: number, body?: unknown) => {
  const f = vi.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body });
  vi.stubGlobal('fetch', f);
  return f;
};
afterEach(() => { vi.unstubAllGlobals(); setProjectId(null); });

describe('api project header', () => {
  it('sends x-project once a project is chosen and remembers it', async () => {
    const f = mockFetch(200, []);
    await api.listIssues();
    expect(f.mock.calls[0][1].headers['x-project']).toBeUndefined();
    setProjectId(7);
    await api.listIssues();
    expect(f.mock.calls[1][1].headers['x-project']).toBe('7');
    expect(getProjectId()).toBe(7);
    expect(localStorage.getItem('pjplanner.project')).toBe('7');
  });
});

describe('ProjectsPage', () => {
  const setup = (projects = [proj(1, 'Alpha'), proj(2, 'Beta', { description: 'second' })], currentId = 1) => {
    const props = { projects, currentId, onSwitch: vi.fn(), onChanged: vi.fn() };
    render(<ProjectsPage {...props} />);
    return props;
  };

  it('lists projects with counts, marks the current one, links to export', () => {
    setup();
    const a = screen.getByLabelText('Project Alpha');
    expect(within(a).getByText('current')).toBeInTheDocument();
    expect(within(a).getByText(/2 modules · 3 issues · 1 sprints/)).toBeInTheDocument();
    expect(within(a).queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Export Beta' })).toHaveAttribute('href', '/api/projects/2/export');
  });

  it('opens another project', async () => {
    const p = setup();
    await userEvent.click(within(screen.getByLabelText('Project Beta')).getByRole('button', { name: 'Open' }));
    expect(p.onSwitch).toHaveBeenCalledWith(2);
  });

  it('creates a project and opens it', async () => {
    const f = mockFetch(201, proj(3, 'Gamma'));
    const p = setup();
    await userEvent.type(screen.getByLabelText('New project name'), 'Gamma');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledWith(3));
    expect(f.mock.calls[0][0]).toBe('/api/projects');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ name: 'Gamma' });
  });

  it('renames a project', async () => {
    const f = mockFetch(200, proj(1, 'Alpha2'));
    const p = setup();
    await userEvent.click(within(screen.getByLabelText('Project Alpha')).getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Project name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Alpha2');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/projects/1');
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ name: 'Alpha2' });
  });

  it('confirms before deleting; cannot delete the last project', async () => {
    const f = mockFetch(204);
    const p = setup();
    await userEvent.click(within(screen.getByLabelText('Project Beta')).getByRole('button', { name: 'Delete' }));
    expect(f).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/projects/2');
    expect(f.mock.calls[0][1].method).toBe('DELETE');
  });

  it('shows an empty state when there are no projects', () => {
    setup([], null as any);
    expect(screen.getByText(/No projects yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('can delete the only project', () => {
    setup([proj(1, 'Only')]);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('imports a file as a new project and opens it', async () => {
    const f = mockFetch(201, proj(4, 'Imported'));
    const p = setup();
    const file = new File([JSON.stringify({ format: 'pjplanner-project', version: 1 })], 'x.pjplanner.json', { type: 'application/json' });
    await userEvent.upload(screen.getByLabelText('Import project file'), file);
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledWith(4));
    expect(f.mock.calls[0][0]).toBe('/api/projects/import');
    expect(JSON.parse(f.mock.calls[0][1].body).format).toBe('pjplanner-project');
  });

  it('shows an error for a non-JSON file and for server rejection', async () => {
    const p = setup();
    await userEvent.upload(screen.getByLabelText('Import project file'), new File(['nope'], 'x.json', { type: 'application/json' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not valid JSON');
    mockFetch(400, { error: { code: 'validation_error', message: 'not a pjPlanner project file' } });
    await userEvent.upload(screen.getByLabelText('Import project file'), new File(['{}'], 'y.json', { type: 'application/json' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('not a pjPlanner project file'));
    expect(p.onChanged).not.toHaveBeenCalled();
  });
});

describe('ProjectSwitcher', () => {
  const projects = [proj(1, 'Alpha'), proj(2, 'Beta')];
  const setup = (currentId = 1) => {
    const props = { projects, currentId, onSwitch: vi.fn(), onManage: vi.fn() };
    render(<ProjectSwitcher {...props} />);
    return props;
  };

  it('shows the current project and opens a menu with the current one checked', async () => {
    setup();
    const chip = screen.getByRole('button', { name: 'Project: Alpha' });
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.click(chip);
    expect(screen.getByRole('menuitemradio', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: /Beta/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('switches project and closes', async () => {
    const p = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Project: Alpha' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Beta/ }));
    expect(p.onSwitch).toHaveBeenCalledWith(2);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('goes to the Projects tab from the menu; Esc and outside click close it', async () => {
    const p = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Project: Alpha' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /All projects/ }));
    expect(p.onManage).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Project: Alpha' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Project: Alpha' }));
    await userEvent.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

it('routes #/projects to the projects tab', () => {
  expect(parseHash('#/projects')).toBe('projects');
});

import App from '../App';
describe('App without projects', () => {
  it('opens on the Projects page with no error banner, then enters the project it creates', async () => {
    let projects: Project[] = [];
    const graph = { modules: [], owners: [], relations: [], groups: [] };
    const noProject = { status: 404, ok: false, json: async () => ({ error: { code: 'no_project', message: 'No project yet; create one first' } }) };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/projects' && init?.method === 'POST') { projects = [proj(1, 'First')]; return { status: 201, ok: true, json: async () => projects[0] }; }
      if (url === '/api/projects') return { status: 200, ok: true, json: async () => projects };
      if (projects.length === 0) return noProject;
      return { status: 200, ok: true, json: async () => (url === '/api/graph' ? graph : []) };
    }));
    render(<App />);
    expect(await screen.findByText(/No projects yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.type(screen.getByLabelText('New project name'), 'First');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('button', { name: 'Project: First' })).toBeInTheDocument();
    expect(getProjectId()).toBe(1);
  });
});
