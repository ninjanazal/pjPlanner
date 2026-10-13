import { buildTree, descendantIds, hideClosed, parentOptions } from '../issueTree';
import type { Issue, IssueType } from '../types';

const mk = (id: number, type: IssueType, parentId: number | null, state: Issue['state'] = 'open'): Issue => ({
  id, type, title: `i${id}`, description: '', parentId, ownerId: null, state, moduleId: null, sprintId: null, childIds: [], rollupModuleIds: [],
});
const issues = [mk(1, 'epic', null), mk(2, 'bug', 1), mk(3, 'task', 2), mk(4, 'bug', null), mk(5, 'task', 99)];

describe('issueTree', () => {
  it('nests children and keeps orphans at top level', () => {
    const t = buildTree(issues);
    expect(t.map((n) => n.issue.id)).toEqual([1, 4, 5]);
    expect(t[0].children[0].children[0].issue.id).toBe(3);
  });
  it('hides closed issues but keeps closed parents with open descendants', () => {
    const t = buildTree([mk(1, 'epic', null, 'closed'), mk(2, 'task', 1, 'open'), mk(3, 'epic', null, 'closed'), mk(4, 'task', 3, 'closed')]);
    expect(hideClosed(t).map((n) => n.issue.id)).toEqual([1]);
    expect(hideClosed(t)[0].children.map((n) => n.issue.id)).toEqual([2]);
  });
  it('computes descendants', () => {
    expect([...descendantIds(issues, 1)].sort()).toEqual([2, 3]);
  });
  it('filters parent options by type and excludes self/descendants', () => {
    expect(parentOptions(issues, 'epic')).toEqual([]);
    expect(parentOptions(issues, 'bug').map((i) => i.id)).toEqual([1]);
    expect(parentOptions(issues, 'task').map((i) => i.id)).toEqual([1, 2, 4]);
    expect(parentOptions(issues, 'task', 2).map((i) => i.id)).toEqual([1, 4]);
  });
  it('stories sit under epics and hold tasks', () => {
    const withStory = [...issues, mk(6, 'story', 1)];
    expect(parentOptions(withStory, 'story').map((i) => i.id)).toEqual([1]);
    expect(parentOptions(withStory, 'task').map((i) => i.id)).toEqual([1, 2, 4, 6]);
    expect(parentOptions(withStory, 'bug').map((i) => i.id)).toEqual([1]);
  });
});
