export interface Owner { id: number; name: string; color: string | null; icon: string | null }
export interface Group { id: number; name: string; color: string | null; icon: string | null; parentId: number | null }
export type ApiKind = 'function' | 'endpoint' | 'event' | 'type' | 'other';
export const API_KINDS: ApiKind[] = ['function', 'endpoint', 'event', 'type', 'other'];
export interface ApiItem { id: number; kind: ApiKind; name: string; signature: string; description: string }
export type ApiItemInput = Omit<ApiItem, 'id'> & { id?: number };
export type StrokeStyle = 'solid' | 'dashed' | 'dotted';
export const STROKE_STYLES: StrokeStyle[] = ['solid', 'dashed', 'dotted'];
export interface Module {
  id: number; name: string; description: string; ownerIds: number[];
  color: string | null; icon: string | null; apiItems: ApiItem[];
  textColor: string | null; strokeColor: string | null; strokeStyle: StrokeStyle;
  x: number | null; y: number | null; groupId: number | null;
}
export interface Relation { id: number; sourceId: number; targetId: number; label: string | null; color: string | null }
export interface Graph { modules: Module[]; owners: Owner[]; relations: Relation[]; groups: Group[] }
export interface ModuleInput { name: string; description?: string; ownerIds?: number[];
  color?: string | null; icon?: string | null;
  textColor?: string | null; strokeColor?: string | null; strokeStyle?: StrokeStyle; apiItems?: ApiItemInput[]; groupId?: number | null }
export interface OwnerInput { name: string; color: string | null; icon: string | null }
export type GroupInput = OwnerInput & { parentId?: number | null };
export interface Project { id: number; name: string; description: string; createdAt: string; moduleCount: number; issueCount: number; sprintCount: number }
export type IssueType = 'epic' | 'story' | 'bug' | 'task';
export const ISSUE_TYPES: IssueType[] = ['epic', 'story', 'bug', 'task'];
export const TYPE_ICON: Record<IssueType, string> = { epic: '⚡', story: '📖', bug: '🐞', task: '✔' };
export type IssueState = 'open' | 'closed';
export const ISSUE_STATES: IssueState[] = ['open', 'closed'];
export interface Issue {
  id: number; type: IssueType; title: string; description: string; parentId: number | null;
  ownerId: number | null; state: IssueState; moduleId: number | null; sprintId: number | null; estimate?: number | null; childIds: number[];
  rollupModuleIds: number[]; // own module plus descendants'
}
export interface IssueInput {
  type: IssueType; title: string; description?: string; parentId?: number | null;
  ownerId?: number | null; state?: IssueState; moduleId?: number | null;
  sprintId?: number | null; // omitted = keep, null = backlog
  estimate?: number | null; // steps of effort (tasks only); omitted = keep, null = unset (1 step)
}
export type SprintState = 'planned' | 'active' | 'closed';
export interface Sprint {
  id: number; name: string; goal: string; state: SprintState;
  issueIds: number[]; openCount: number; closedCount: number;
}
export interface SprintInput { name: string; goal?: string; state?: SprintState }
