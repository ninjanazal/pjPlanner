import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JiraUploadForm } from '../components/JiraUploadForm';
import type { Issue, JiraFieldDescriptor, JiraUploadForm as Meta } from '../types';

const issue = { id: 1, type: 'story', title: 'Issue 1', description: '' } as Issue;
const base = (extra: Partial<Meta> = {}): Meta => ({
  project: { ref: '10000', key: 'PJ', name: 'Proj', locked: false },
  issueTypes: [{ id: '1', name: 'Story', subtask: false }, { id: '2', name: 'Bug', subtask: false }], issueType: { id: '1', name: 'Story' },
  values: { title: 'Issue 1', description: 'Desc', labels: ['pj'] }, link: { kind: 'none', label: 'Created as a top-level issue' }, match: null, fields: [], ...extra,
});
const F = (f: Partial<JiraFieldDescriptor> & { id: string }): JiraFieldDescriptor => ({ name: f.id, required: false, kind: 'string', ...f });

// Serves upload-form (via `forms`, keyed by "project|type") and records uploads.
function setup(forms: (q: URLSearchParams) => { status?: number; body: unknown }, upload: { status?: number; body: unknown } = { body: { issue: { jiraKey: 'PJ-7' }, adopted: false } }) {
  const f = vi.fn(async (url: string, init: any = {}) => {
    const [path, qs = ''] = url.split('?');
    let r: { status?: number; body: unknown } = { status: 404, body: { error: { code: 'not_found', message: 'no mock' } } };
    if (path === '/api/issues/1/jira/upload-form') r = forms(new URLSearchParams(qs));
    else if (path === '/api/issues/1/jira/upload' && init.method === 'POST') r = upload;
    const st = r.status ?? 200;
    return { status: st, ok: st < 400, json: async () => r.body };
  });
  vi.stubGlobal('fetch', f);
  const onDone = vi.fn(); const onClose = vi.fn();
  render(<JiraUploadForm issue={issue} onClose={onClose} onDone={onDone} />);
  return { f, onDone, onClose };
}
const posts = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([, i]: any[]) => i?.method === 'POST').map(([, i]: any[]) => JSON.parse(i.body));
const gets = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([, i]: any[]) => i?.method === 'GET').map(([u]: any[]) => u as string);
const last = <T,>(a: T[]) => a[a.length - 1];
afterEach(() => vi.unstubAllGlobals());

describe('JiraUploadForm', () => {
  it('prefills base fields and the integration label, and posts the edited form', async () => {
    const { f, onDone } = setup(() => ({ body: base() }));
    expect(await screen.findByLabelText(/Title/)).toHaveValue('Issue 1');
    expect(screen.getByLabelText('Description')).toHaveValue('Desc');
    expect(screen.getByLabelText('Project')).toHaveValue('10000');
    expect(screen.getByText('Created as a top-level issue')).toBeInTheDocument();
    expect(screen.getByText('pj')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Title/), ' x');
    await userEvent.type(screen.getByLabelText('Labels'), 'extra{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Remove label pj' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create in Jira' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts(f)).toEqual([{ projectRef: '10000', issueType: 'Story', title: 'Issue 1 x', description: 'Desc', labels: ['extra'], fields: {} }]);
  });

  it('renders each field kind and sends its value', async () => {
    const fields = [
      F({ id: 'customfield_1', name: 'Points', kind: 'number' }),
      F({ id: 'duedate', name: 'Due', kind: 'date' }),
      F({ id: 'priority', name: 'Priority', kind: 'priority', allowedValues: [{ id: '1', name: 'High' }, { id: '2', name: 'Low' }] }),
      F({ id: 'components', name: 'Components', kind: 'component', multi: true, allowedValues: [{ id: '5', name: 'Api' }, { id: '6', name: 'Web' }] }),
      F({ id: 'assignee', name: 'Assignee', kind: 'user' }),
      F({ id: 'customfield_2', name: 'Notes', kind: 'text' }),
    ];
    const { f, onDone } = setup(() => ({ body: base({ fields }) }));
    await userEvent.type(await screen.findByLabelText('Points'), '5');
    await userEvent.type(screen.getByLabelText('Due'), '2026-05-01');
    await userEvent.selectOptions(screen.getByLabelText('Priority'), 'High');
    await userEvent.selectOptions(screen.getByLabelText('Components'), ['5', '6']);
    await userEvent.type(screen.getByLabelText('Assignee'), 'jdoe');
    await userEvent.type(screen.getByLabelText('Notes'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Create in Jira' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts(f)[0].fields).toEqual({ customfield_1: 5, duedate: '2026-05-01', priority: '1', components: ['5', '6'], assignee: 'jdoe', customfield_2: 'hi' });
  });

  it('marks required fields and blocks submit until they are filled', async () => {
    setup(() => ({ body: base({ fields: [F({ id: 'customfield_1', name: 'Team', required: true })] }) }));
    const btn = await screen.findByRole('button', { name: 'Create in Jira' });
    expect(screen.getByLabelText(/Team/).closest('label')).toHaveTextContent('Team *');
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Team/), 'A');
    expect(btn).toBeEnabled();
  });

  it('shows an unsupported required field as a disabled hint that blocks submit', async () => {
    setup(() => ({ body: base({ fields: [F({ id: 'customfield_9', name: 'Cascade', required: true, kind: 'unsupported', unsupported: true })] }) }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cascade');
    expect(screen.getByRole('button', { name: 'Create in Jira' })).toBeDisabled();
  });

  it('does not block on an unsupported optional field', async () => {
    setup(() => ({ body: base({ fields: [F({ id: 'customfield_9', name: 'Cascade', kind: 'unsupported', unsupported: true })] }) }));
    await screen.findByText(/cannot fill this field/);
    expect(screen.getByRole('button', { name: 'Create in Jira' })).toBeEnabled();
  });

  it('reloads fields when the issue type changes, keeping edited text', async () => {
    const { f } = setup((q) => ({ body: q.get('issueType') === 'Bug'
      ? base({ issueType: { id: '2', name: 'Bug' }, fields: [F({ id: 'customfield_3', name: 'Severity' })] }) : base() }));
    await userEvent.type(await screen.findByLabelText(/Title/), '!');
    await userEvent.selectOptions(screen.getByLabelText('Issue type'), 'Bug');
    expect(await screen.findByLabelText('Severity')).toBeInTheDocument();
    expect(screen.getByLabelText(/Title/)).toHaveValue('Issue 1!');
    expect(last(gets(f))).toContain('issueType=Bug');
    expect(last(gets(f))).toContain('jiraProject=10000');
  });

  it('sends a datetime as an ISO string', async () => {
    const { f, onDone } = setup(() => ({ body: base({ fields: [F({ id: 'customfield_9', name: 'When', kind: 'datetime' })] }) }));
    await userEvent.type(await screen.findByLabelText('When'), '2026-05-01T10:30');
    await userEvent.click(screen.getByRole('button', { name: 'Create in Jira' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts(f)[0].fields.customfield_9).toBe(new Date('2026-05-01T10:30').toISOString());
  });

  it('shows a hint when Jira did not offer its fields', async () => {
    setup(() => ({ body: base({ fieldsUnavailable: true }) }));
    expect(await screen.findByText('Jira did not tell us which fields it offers; required ones are checked by Jira.')).toBeInTheDocument();
  });

  it('disables submit after a failed project reload until a load succeeds', async () => {
    setup((q) => (q.get('jiraProject') === 'BAD' ? { status: 400, body: { error: { code: 'validation_error', message: 'no such project' } } } : { body: base() }));
    const input = await screen.findByLabelText('Project');
    expect(screen.getByRole('button', { name: 'Create in Jira' })).toBeEnabled();
    await userEvent.clear(input);
    await userEvent.type(input, 'BAD');
    await userEvent.click(screen.getByLabelText(/Title/));
    expect(await screen.findByText('no such project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create in Jira' })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, 'GOOD');
    await userEvent.click(screen.getByLabelText(/Title/));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create in Jira' })).toBeEnabled());
  });

  it('a root with no project asks for one, blocks submit and reloads on blur', async () => {
    const { f } = setup((q) => ({ body: q.get('jiraProject') === 'NEW'
      ? base({ project: { ref: 'NEW', key: 'NEW', locked: false } })
      : base({ project: { ref: null, locked: false }, issueTypes: [], issueType: null, fields: [] }) }));
    const input = await screen.findByLabelText('Project');
    expect(await screen.findByText(/Enter the Jira project id or key/)).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription(/Enter the Jira project id or key/);
    expect(screen.getByRole('button', { name: 'Create in Jira' })).toBeDisabled();
    await userEvent.type(input, 'NEW');
    await userEvent.click(screen.getByLabelText(/Title/));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create in Jira' })).toBeEnabled());
    expect(last(gets(f))).toContain('jiraProject=NEW');
    expect(screen.queryByText(/Enter the Jira project id or key/)).toBeNull();
  });

  it('a changed project reloads with its default issue type, not the stale one', async () => {
    const { f } = setup((q) => ({ body: q.get('jiraProject') === 'OTHER' ? base({ project: { ref: 'OTHER', locked: false } }) : base() }));
    await userEvent.selectOptions(await screen.findByLabelText('Issue type'), 'Bug');
    const input = screen.getByLabelText('Project');
    await userEvent.clear(input);
    await userEvent.type(input, 'OTHER');
    await userEvent.click(screen.getByLabelText(/Title/));
    await waitFor(() => expect(last(gets(f))).toContain('jiraProject=OTHER'));
    expect(last(gets(f))).not.toContain('issueType');
  });

  it('splits a multi-valued user field on commas', async () => {
    const { f, onDone } = setup(() => ({ body: base({ fields: [F({ id: 'customfield_5', name: 'Reviewers', kind: 'user', multi: true })] }) }));
    await userEvent.type(await screen.findByLabelText('Reviewers'), 'ann, bob,, ');
    await userEvent.click(screen.getByRole('button', { name: 'Create in Jira' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts(f)[0].fields.customfield_5).toEqual(['ann', 'bob']);
  });

  it('unfinished label text is dropped on Cancel but kept when creating', async () => {
    const { f, onClose, onDone } = setup(() => ({ body: base() }));
    const box = await screen.findByLabelText('Labels');
    await userEvent.type(box, 'draft');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText('draft', { selector: '.chip' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Create in Jira' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts(f)[0].labels).toEqual(['pj', 'draft']);
  });

  it('reloads for the new project on blur', async () => {
    const { f } = setup((q) => ({ body: q.get('jiraProject') === 'OTHER' ? base({ project: { ref: 'OTHER', key: 'OTHER', locked: false } }) : base() }));
    const input = await screen.findByLabelText('Project');
    await userEvent.clear(input);
    await userEvent.type(input, 'OTHER');
    await userEvent.click(screen.getByLabelText(/Title/)); // blur (the modal traps Tab, which jsdom cannot move)
    await waitFor(() => expect(last(gets(f))).toContain('jiraProject=OTHER'));
    expect(gets(f)).toHaveLength(2);
  });

  it('shows a link-type select with the default and posts the chosen one', async () => {
    const link = { kind: 'link' as const, parentKey: 'PJ-1', label: 'Linked to PJ-1', linkType: 'Relates', linkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, { id: '2', name: 'Relates', inward: 'relates to', outward: 'relates to' }] };
    const { f, onDone } = setup(() => ({ body: base({ project: { ref: 'PJ', key: 'PJ', locked: true }, link }) }));
    const sel = await screen.findByLabelText('Link type');
    expect(sel).toHaveValue('Relates');
    await userEvent.selectOptions(sel, 'Blocks');
    await userEvent.click(screen.getByRole('button', { name: 'Create in Jira' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts(f)[0]).toMatchObject({ linkType: 'Blocks' });
  });

  it('has no link-type select under an epic', async () => {
    setup(() => ({ body: base({ link: { kind: 'epic', parentKey: 'PJ-1', label: 'In epic PJ-1' } }) }));
    await screen.findByText('In epic PJ-1');
    expect(screen.queryByLabelText('Link type')).toBeNull();
  });

  it('locks the project for a parented issue and omits it from the post', async () => {
    const { f, onDone } = setup(() => ({ body: base({ project: { ref: 'PJ', key: 'PJ', locked: true }, link: { kind: 'link', parentKey: 'PJ-1', label: 'Linked to PJ-1' } }) }));
    expect(await screen.findByLabelText('Project')).toBeDisabled();
    expect(screen.getByText('Linked to PJ-1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create in Jira' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts(f)[0]).not.toHaveProperty('projectRef');
  });

  it('shows the match banner; Link to it posts linkExisting only', async () => {
    const { f, onDone } = setup(() => ({ body: base({ match: { key: 'PJ-45', url: 'https://j/browse/PJ-45', title: 'Issue 1' } }) }));
    const banner = await screen.findByText(/already has/);
    expect(within(banner).getByRole('link', { name: 'PJ-45' })).toHaveAttribute('href', 'https://j/browse/PJ-45');
    await userEvent.click(screen.getByRole('button', { name: 'Link to it' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts(f)).toEqual([{ linkExisting: 'PJ-45' }]);
  });

  it('Create anyway dismisses the banner and creates with the form values', async () => {
    const { f, onDone } = setup(() => ({ body: base({ match: { key: 'PJ-45', url: 'u', title: 'Issue 1' } }) }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create anyway' }));
    expect(screen.queryByText(/already has/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Create in Jira' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts(f)[0]).toMatchObject({ title: 'Issue 1', issueType: 'Story' });
  });

  it('shows server errors inline and keeps the form open', async () => {
    const { onDone } = setup(() => ({ body: base() }), { status: 400, body: { error: { code: 'validation_error', message: 'field X is required' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Create in Jira' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('field X is required');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create in Jira' })).toBeEnabled();
  });

  it('shows a load error inline', async () => {
    setup(() => ({ status: 409, body: { error: { code: 'conflict', message: 'parent not uploaded' } } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('parent not uploaded');
    expect(screen.getByRole('button', { name: 'Create in Jira' })).toBeDisabled();
  });

  it('asks before discarding edits, and closes straight away when untouched', async () => {
    const { onClose } = setup(() => ({ body: base() }));
    await screen.findByLabelText(/Title/);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('guards edits with the discard prompt', async () => {
    const { onClose } = setup(() => ({ body: base() }));
    await userEvent.type(await screen.findByLabelText(/Title/), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('prefills defaults, omits hidden fields and says how many are hidden', async () => {
    const fields = [
      F({ id: 'customfield_1', name: 'Points', kind: 'number', default: 3 }),
      F({ id: 'priority', name: 'Priority', kind: 'priority', allowedValues: [{ id: '1', name: 'High' }], default: '1' }),
      F({ id: 'customfield_9', name: 'Secret', default: 'x', hidden: true }),
      F({ id: 'customfield_8', name: 'Gone', hidden: true, required: true, default: 'y' }),
    ];
    const { f, onDone } = setup(() => ({ body: base({ fields }) }));
    expect(await screen.findByLabelText('Points')).toHaveValue(3);
    expect(screen.getByLabelText('Priority')).toHaveValue('1');
    expect(screen.queryByLabelText('Secret')).toBeNull();
    expect(screen.queryByLabelText(/Gone/)).toBeNull();
    expect(screen.getByText(/2 fields hidden by the project's integration settings/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create in Jira' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posts(f)[0].fields).toEqual({ customfield_1: 3, priority: '1' });
  });
});
