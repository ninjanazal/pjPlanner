import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IssuesPage } from '../components/IssuesPage';
import { sprintHeat, ownerMap } from '../heatmap';
import { buildTimeline } from '../sprintTimeline';
import { ISSUE_STATES, STATE_LABEL, type Issue, type Module, type Sprint } from '../types';

const mk = (p: Partial<Issue> & Pick<Issue, 'id' | 'title'>): Issue => ({
  type: 'task', description: '', parentId: null, ownerId: null, state: 'open', moduleId: null, sprintId: null, childIds: [], rollupModuleIds: [], ...p,
});
afterEach(() => vi.unstubAllGlobals());

describe('issue workflow states', () => {
  it('runs open, code review, test validation, closed', () => {
    expect(ISSUE_STATES).toEqual(['open', 'code_review', 'test_validation', 'closed']);
    expect(STATE_LABEL.code_review).toBe('code review');
    expect(STATE_LABEL.test_validation).toBe('test validation');
  });

  it('shows the readable name on the badge and offers all four in the editor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({}) }));
    render(<IssuesPage issues={[mk({ id: 1, title: 'In review', state: 'code_review' }), mk({ id: 2, title: 'Validating', state: 'test_validation' })]} modules={[]} owners={[]} onChanged={() => {}} />);
    expect(screen.getByText('code review', { selector: '.state-badge' })).toHaveClass('state-badge', 's-code_review');
    expect(screen.getByText('test validation', { selector: '.state-badge' })).toHaveClass('s-test_validation');
    cleanup();
    render(<IssuesPage issues={[mk({ id: 1, title: 'In review', state: 'code_review' })]} modules={[]} owners={[]} issueId={1} onChanged={() => {}} />);
    const select = await screen.findByLabelText('State');
    expect(select).toHaveValue('code_review');
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(['open', 'code review', 'test validation', 'closed']);
  });

  it('keeps review and validation in the backlog and counts them as unfinished work', () => {
    const issues = [
      mk({ id: 1, title: 'a', moduleId: 1, sprintId: 1, state: 'code_review' }),
      mk({ id: 2, title: 'b', moduleId: 1, sprintId: 1, state: 'test_validation' }),
      mk({ id: 3, title: 'c', moduleId: 1, sprintId: 1, state: 'closed' }),
    ];
    expect(sprintHeat(issues, 1).get(1)).toMatchObject({ open: 2, done: 1 });
    const mod = { id: 1, name: 'M' } as unknown as Module;
    const sprint = { id: 1, state: 'active' } as Sprint;
    expect(ownerMap(issues.map((i) => ({ ...i, ownerId: 7 })), [mod], [sprint], 7, null).get(1)).toMatchObject({ open: 2, done: 1 });
    const tl = buildTimeline(issues.map((i) => ({ ...i, ownerId: 7 })), [mod], []);
    expect(tl.slots.map((s) => s.issue.id).sort()).toEqual([1, 2]); // the closed one is not scheduled
  });
});
