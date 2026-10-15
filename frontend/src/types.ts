export interface Owner { id: number; name: string; color: string | null; icon: string | null }
export interface Group { id: number; name: string; color: string | null; icon: string | null; parentId: number | null }
export type ApiKind = 'function' | 'endpoint' | 'event' | 'type' | 'other';
export const API_KINDS: ApiKind[] = ['function', 'endpoint', 'event', 'type', 'other'];
export interface ApiItem { id: number; kind: ApiKind; name: string; signature: string; description: string }
export type ApiItemInput = Omit<ApiItem, 'id'> & { id?: number };
export type StrokeStyle = 'solid' | 'dashed' | 'dotted';
export const STROKE_STYLES: StrokeStyle[] = ['solid', 'dashed', 'dotted'];
export type TestStatus = 'none' | 'partial' | 'full';
export const TEST_STATUSES: TestStatus[] = ['none', 'partial', 'full'];
export interface Module {
  id: number; name: string; description: string; ownerIds: number[];
  color: string | null; icon: string | null; apiItems: ApiItem[];
  textColor: string | null; strokeColor: string | null; strokeStyle: StrokeStyle;
  x: number | null; y: number | null; groupId: number | null;
  testStatus?: TestStatus | null; testNotes?: string; // null/absent = not assessed yet
}
export interface Relation { id: number; sourceId: number; targetId: number; label: string | null; color: string | null }
export interface Graph { modules: Module[]; owners: Owner[]; relations: Relation[]; groups: Group[] }
export interface ModuleInput {
  name: string; description?: string; ownerIds?: number[];
  color?: string | null; icon?: string | null;
  textColor?: string | null; strokeColor?: string | null; strokeStyle?: StrokeStyle; apiItems?: ApiItemInput[]; groupId?: number | null;
  testStatus?: TestStatus | null; testNotes?: string
}
export interface OwnerInput { name: string; color: string | null; icon: string | null }
export type GroupInput = OwnerInput & { parentId?: number | null };
export interface JiraUploadConfig { hidden: string[]; defaults: Record<string, string | number | (string | number)[]> }
export interface Project { id: number; name: string; description: string; createdAt: string; moduleCount: number; issueCount: number; sprintCount: number; jiraJql?: string | null; jiraLabel?: string | null; jiraWrite?: boolean; jiraEnabled?: boolean; jiraProjectId?: string | null; jiraUploadConfig?: JiraUploadConfig | null; jiraSyncedAt?: string | null }
export interface JiraStatus { configured: boolean; available?: boolean; missing?: string[]; url: string | null; writeAllowed?: boolean }
export interface JiraWriteResult { issue: Issue; adopted: boolean; url?: string; linkWarning?: string }
export interface JiraLinkType { id: string; name: string; inward: string; outward: string }
export type JiraFieldKind = 'string' | 'text' | 'number' | 'date' | 'datetime' | 'option' | 'priority' | 'component' | 'version' | 'user' | 'labels' | 'unsupported';
export interface JiraFieldDescriptor { id: string; name: string; required: boolean; kind: JiraFieldKind; multi?: boolean; allowedValues?: { id?: string; name?: string; value?: string }[]; unsupported?: boolean; default?: string | number | (string | number)[]; hidden?: boolean }
export interface JiraUploadForm {
  // A root issue with no Jira project known yet comes back with ref null, no types and no fields: the user types a project and the form reloads.
  project: { ref: string | null; key?: string; id?: string; name?: string; locked: boolean };
  issueTypes: { id: string; name: string; subtask: boolean }[]; issueType: { id: string; name: string } | null;
  values: { title: string; description: string; labels: string[] };
  link: { kind: 'link' | 'epic' | 'none'; parentKey?: string; label: string; linkTypes?: JiraLinkType[]; linkType?: string | null };
  match: { key: string; url: string; title: string } | null; fields: JiraFieldDescriptor[]; fieldsUnavailable?: boolean;
}
export interface JiraCreateFields {
  project: { ref: string | null; key?: string; id?: string; name?: string };
  issueTypes: { id: string; name: string; subtask: boolean }[]; issueType: { id: string; name: string } | null;
  fields: JiraFieldDescriptor[]; fieldsUnavailable?: boolean;
}
export interface JiraUploadBody { projectRef?: string; issueType?: string; title?: string; description?: string; labels?: string[]; fields?: Record<string, unknown>; linkExisting?: string; linkType?: string }
export interface JiraInfo { version: string; deploymentType: string; user: { name: string; displayName: string } }
export interface JiraPreview {
  jql: string; total: number; importable: number;
  byType: Record<string, number>; skipped: Record<string, number>;
  sample: { key: string; type: IssueType; title: string; state: IssueState; parentKey: string | null }[];
}
export interface JiraImportResult { jql: string; total: number; created: number; updated: number; linked: number; skipped: Record<string, number>; notInFilter: number }
export type IssueType = 'epic' | 'story' | 'bug' | 'task';
export const ISSUE_TYPES: IssueType[] = ['epic', 'story', 'bug', 'task'];
export const TYPE_ICON: Record<IssueType, string> = { epic: '⚡', story: '📖', bug: '🐞', task: '✔' };
// open -> code review -> test validation -> closed. Anything but closed is unfinished work.
export type IssueState = 'open' | 'code_review' | 'test_validation' | 'closed';
export const ISSUE_STATES: IssueState[] = ['open', 'code_review', 'test_validation', 'closed'];
export const STATE_LABEL: Record<IssueState, string> = { open: 'open', code_review: 'code review', test_validation: 'test validation', closed: 'closed' };
export interface Issue {
  id: number; type: IssueType; title: string; description: string; implementation?: string; parentId: number | null;
  ownerId: number | null; state: IssueState; moduleId: number | null; sprintId: number | null; estimate?: number | null; childIds: number[];
  rollupModuleIds: number[]; // own module plus descendants'
  jiraKey?: string | null; // set when imported from Jira
  createdAt?: string; startedAt?: string | null; closedAt?: string | null; closedOwnerId?: number | null; reopenCount?: number; updatedAt?: string; // timing, set by the server
}
export interface IssueInput {
  type: IssueType; title: string; description?: string; parentId?: number | null;
  implementation?: string; // how-to notes (tasks only); omitted = keep
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

// The client currently holding a project's editor lease (null: nobody).
export type Editor = { clientId: string; name: string } | null;
