import type { Issue, IssueInput, Module, Owner } from './types';

export type GroupBy = 'module' | 'owner' | 'epic' | 'none';
export interface IssueGroup { key: string; label: string; issues: Issue[] }

// Epics, stories and bugs only group other issues: they never appear as sprint work, but an epic can be the grouping itself.
export const isWork = (i: Issue) => i.type === 'task';

// The epic an issue belongs to, directly or through a story or a bug.
export function epicOf(i: Issue, all: Issue[]): Issue | undefined {
  const p = all.find((x) => x.id === i.parentId);
  return p?.type === 'epic' ? p : p ? epicOf(p, all) : undefined;
}

// Splits a sprint's issues into labelled groups (by module, owner or epic); issues without one go last.
// `all` is every issue, used to find the epic an issue belongs to.
export function groupIssues(issues: Issue[], by: GroupBy, modules: Module[], owners: Owner[], all: Issue[] = []): IssueGroup[] {
  if (by === 'none') return [{ key: 'all', label: '', issues }];
  const epics = all.filter((i) => i.type === 'epic');
  const items: { id: number; name: string; icon: string | null }[] =
    by === 'module' ? modules : by === 'owner' ? owners : epics.map((e) => ({ id: e.id, name: e.title, icon: '⚡' }));
  const idOf = (i: Issue) => (by === 'module' ? i.moduleId : by === 'owner' ? i.ownerId : epicOf(i, all)?.id ?? null);
  const groups: IssueGroup[] = items
    .map((x) => ({ key: String(x.id), label: `${x.icon ? `${x.icon} ` : ''}${x.name}`, issues: issues.filter((i) => idOf(i) === x.id) }))
    .filter((g) => g.issues.length > 0);
  const rest = issues.filter((i) => idOf(i) == null || !items.some((x) => x.id === idOf(i)));
  if (rest.length) groups.push({ key: 'none', label: by === 'module' ? 'No module' : by === 'owner' ? 'Unassigned' : 'No epic', issues: rest });
  return groups;
}

// Full-update body for an issue (the API's PUT replaces every field) with the sprint changed.
export const withSprint = (i: Issue, sprintId: number | null): IssueInput => ({
  type: i.type, title: i.title, description: i.description, parentId: i.parentId,
  ownerId: i.ownerId, moduleId: i.moduleId, state: i.state, sprintId,
});

// Full-update body with the state flipped (sprintId is left out, so the API keeps it).
export const withState = (i: Issue, state: Issue['state']): IssueInput => ({
  type: i.type, title: i.title, description: i.description, parentId: i.parentId,
  ownerId: i.ownerId, moduleId: i.moduleId, state,
});

export const withOwner = (i: Issue, ownerId: number | null): IssueInput => ({
  type: i.type, title: i.title, description: i.description, parentId: i.parentId,
  ownerId, moduleId: i.moduleId, state: i.state,
});
