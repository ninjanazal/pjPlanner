import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntegrationsDialog } from '../components/IntegrationsDialog';
import { setProjectId } from '../api';
import type { JiraFieldDescriptor, Project } from '../types';

const project = (extra: Partial<Project> = {}): Project => ({ id: 1, name: 'Alpha', description: '', createdAt: '', moduleCount: 0, issueCount: 0, sprintCount: 0, jiraEnabled: true, jiraProjectId: 'PJ', ...extra });
const F = (f: Partial<JiraFieldDescriptor> & { id: string }): JiraFieldDescriptor => ({ name: f.id, required: false, kind: 'string', ...f });
const fields = [
  F({ id: 'customfield_1', name: 'Team', required: true }),
  F({ id: 'priority', name: 'Priority', kind: 'priority', allowedValues: [{ id: '1', name: 'High' }, { id: '2', name: 'Low' }] }),
  F({ id: 'customfield_7', name: 'Odd', kind: 'unsupported', unsupported: true }),
];
const meta = (extra: object = {}) => ({ project: { ref: 'PJ', key: 'PJ', name: 'Proj' }, issueTypes: [{ id: '1', name: 'Story', subtask: false }, { id: '2', name: 'Bug', subtask: false }], issueType: { id: '1', name: 'Story' }, fields, ...extra });

function mock(createFields: (qs: URLSearchParams) => unknown = () => meta()) {
  const f = vi.fn(async (url: string, init: any = {}) => {
    const [path, qs = ''] = url.split('?');
    const method = init.method ?? 'GET';
    let body: unknown = { error: { code: 'not_found', message: `no mock ${method} ${url}` } }; let status = 404;
    if (path === '/api/jira/status') { body = { configured: true, url: 'https://jira.local' }; status = 200; }
    else if (path === '/api/jira/create-fields') { body = createFields(new URLSearchParams(qs)); status = 200; }
    else if (method === 'PUT' && path === '/api/projects/1') { body = {}; status = 200; }
    return { status, ok: status < 400, json: async () => body };
  });
  vi.stubGlobal('fetch', f);
  return f;
}
const puts = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([, i]: any[]) => i?.method === 'PUT').map(([, i]: any[]) => JSON.parse(i.body));
const open = async (p: Project) => {
  render(<IntegrationsDialog project={p} onChanged={vi.fn()} onImported={vi.fn()} onClose={vi.fn()} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
  await screen.findByLabelText('Show Team');
};
afterEach(() => { vi.unstubAllGlobals(); setProjectId(null); });

describe('Jira upload form settings', () => {
  it('asks for the Jira project id first', async () => {
    mock();
    render(<IntegrationsDialog project={project({ jiraProjectId: null })} onChanged={vi.fn()} onImported={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    expect(await screen.findByText('Set the Jira project id first.')).toBeInTheDocument();
  });

  it('lists the fields, disables unsupported ones and saves hide plus default', async () => {
    const f = mock();
    await open(project());
    expect(screen.getByLabelText('Odd')).toBeInTheDocument();
    expect(screen.queryByLabelText('Show Odd')).toBeNull();
    const save = screen.getByRole('button', { name: 'Save upload form' });
    expect(save).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Default for Priority'), 'High');
    await userEvent.click(screen.getByLabelText('Show Priority'));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(puts(f)).toHaveLength(1));
    expect(puts(f)[0].jiraUploadConfig).toEqual({ hidden: ['priority'], defaults: { priority: '1' } });
  });

  it('does not let a required field be hidden without a default', async () => {
    mock();
    await open(project());
    expect(screen.getByLabelText('Show Team')).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Default for Team'), 'A');
    expect(screen.getByLabelText('Show Team')).toBeEnabled();
    await userEvent.click(screen.getByLabelText('Show Team'));
    await userEvent.clear(screen.getByLabelText('Default for Team'));
    expect(screen.getByText(/needs a default to stay hidden/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save upload form' })).toBeDisabled();
  });

  it('keeps config for ids outside the loaded type and resets with null', async () => {
    const f = mock();
    await open(project({ jiraUploadConfig: { hidden: ['other'], defaults: { other: 'z', priority: '2' } } }));
    expect(screen.getByLabelText('Default for Priority')).toHaveValue('2');
    await userEvent.selectOptions(screen.getByLabelText('Default for Priority'), '');
    await userEvent.click(screen.getByRole('button', { name: 'Save upload form' }));
    await waitFor(() => expect(puts(f)).toHaveLength(1));
    expect(puts(f)[0].jiraUploadConfig).toEqual({ hidden: ['other'], defaults: { other: 'z' } });
    await userEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    await waitFor(() => expect(puts(f)).toHaveLength(2));
    expect(puts(f)[1].jiraUploadConfig).toBeNull();
  });

  it('reloads fields when the issue type changes', async () => {
    const f = mock((qs) => (qs.get('issueType') === 'Bug' ? meta({ issueType: { id: '2', name: 'Bug' }, fields: [F({ id: 'customfield_5', name: 'Severity' })] }) : meta()));
    await open(project());
    await userEvent.selectOptions(screen.getByLabelText('Issue type'), 'Bug');
    expect(await screen.findByLabelText('Show Severity')).toBeInTheDocument();
    expect(f.mock.calls.some(([u]: any[]) => String(u).includes('issueType=Bug'))).toBe(true);
  });

  it('marks the panel dirty so closing asks to discard', async () => {
    mock();
    const onClose = vi.fn();
    render(<IntegrationsDialog project={project()} onChanged={vi.fn()} onImported={vi.fn()} onClose={onClose} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    await userEvent.click(await screen.findByLabelText('Show Priority'));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });
});
