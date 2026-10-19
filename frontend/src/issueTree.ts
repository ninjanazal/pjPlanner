import type { Issue, IssueType } from './types';

export interface IssueNode { issue: Issue; children: IssueNode[] }

const byId = (a: IssueNode, b: IssueNode) => a.issue.id - b.issue.id;

// Issues whose parent is missing become top-level, so orphans never vanish.
export function buildTree(issues: Issue[]): IssueNode[] {
  const nodes = new Map(issues.map((i) => [i.id, { issue: i, children: [] as IssueNode[] }]));
  const roots: IssueNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.issue.parentId != null ? nodes.get(n.issue.parentId) : undefined;
    (parent && parent !== n ? parent.children : roots).push(n);
  }
  const sort = (l: IssueNode[]) => { l.sort(byId); l.forEach((n) => sort(n.children)); };
  sort(roots);
  return roots;
}

// A closed issue stays visible while any descendant is open, so open work is never hidden.
export function hideClosed(nodes: IssueNode[]): IssueNode[] {
  return nodes.flatMap((n) => {
    const children = hideClosed(n.children);
    return n.issue.state !== 'closed' || children.length > 0 ? [{ issue: n.issue, children }] : [];
  });
}

export function descendantIds(issues: Issue[], id: number): Set<number> {
  const out = new Set<number>();
  const walk = (p: number) => issues.forEach((i) => { if (i.parentId === p && !out.has(i.id)) { out.add(i.id); walk(i.id); } });
  walk(id);
  return out;
}

const PARENT_TYPES: Record<IssueType, IssueType[]> = {
  epic: [], story: ['epic'], bug: ['epic'], task: ['epic', 'story', 'bug'],
};

// Valid parents for `type`, excluding the issue being edited and its descendants.
export function parentOptions(issues: Issue[], type: IssueType, selfId?: number | null): Issue[] {
  const blocked = selfId != null ? descendantIds(issues, selfId) : new Set<number>();
  return issues.filter((i) => i.id !== selfId && !blocked.has(i.id) && PARENT_TYPES[type].includes(i.type));
}

// Types that may be created under `type`; empty means it cannot be broken down.
export const childTypes = (type: IssueType): IssueType[] =>
  (Object.keys(PARENT_TYPES) as IssueType[]).filter((t) => PARENT_TYPES[t].includes(type));

// Keeps matching nodes and the ancestors leading to them, so a hit is shown in context.
export function filterTree(nodes: IssueNode[], pred: (i: Issue) => boolean): IssueNode[] {
  return nodes.flatMap((n) => {
    const children = filterTree(n.children, pred);
    return pred(n.issue) || children.length > 0 ? [{ issue: n.issue, children }] : [];
  });
}
