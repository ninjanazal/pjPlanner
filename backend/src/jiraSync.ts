// Pure rules for reading a Jira filter into pjPlanner issues: building the JQL, mapping types and states, resolving parents.
// Nothing here touches the database or the network.
import { bad } from './errors.js';
import { jiraFields, jiraSearch, type JiraConfig, type JiraField, type JiraIssue } from './jira.js';
import { PARENTS } from './routes/issues.js';

// What a project tracks in Jira: a JQL query the user writes (field names, so it works on any instance), and/or a label that
// marks the issues pjPlanner may import. Both may be set; at least one is needed.
export function parseJql(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw bad('jiraJql must be a non-empty string');
  if (v.length > 2000) throw bad('jiraJql must be at most 2000 characters');
  return v.trim();
}

export function parseJiraProjectId(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw bad('jiraProjectId must be a non-empty string');
  const t = v.trim();
  if (/\s/.test(t)) throw bad('jiraProjectId cannot contain spaces');
  if (t.length > 50) throw bad('jiraProjectId must be at most 50 characters');
  return t;
}

export function parseLabel(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw bad('jiraLabel must be a non-empty string');
  const t = v.trim();
  if (/\s/.test(t)) throw bad('a Jira label cannot contain spaces');
  if (t.length > 255) throw bad('jiraLabel must be at most 255 characters');
  return t;
}

// The query actually run: the JQL, narrowed to issues carrying the label. A trailing ORDER BY stays at the end.
export function effectiveJql(jql: string | null, label: string | null): string {
  if (!jql && !label) throw bad('set a JQL filter, a label, or both');
  if (!label) return jql!;
  const clause = `labels = "${label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (!jql) return clause;
  const m = /^([\s\S]*?)(\s+order\s+by\s[\s\S]*)?$/i.exec(jql)!;
  return `(${m[1].trim()}) AND ${clause}${m[2] ?? ''}`;
}

export type LocalType = 'epic' | 'story' | 'bug' | 'task';
const TYPES: Record<string, LocalType> = {
  epic: 'epic', 'business epic': 'epic', story: 'story', bug: 'bug', defect: 'bug',
  task: 'task', 'sub-task': 'task', subtask: 'task', 'major task': 'task', 'new feature': 'task',
};
export const mapType = (jiraType: string): LocalType | null => TYPES[jiraType.toLowerCase()] ?? null;

// Jira statuses are free-form, so a done category means closed and the name decides the review stages ("Waiting Code Review",
// "Validating", "In Test"...); everything else is plain open.
export function mapState(statusName: string, category: unknown): PlannedIssue['state'] {
  if (category === 'done') return 'closed';
  if (/review/i.test(statusName)) return 'code_review';
  if (/\bvalidat|\btest|\bqa\b/i.test(statusName)) return 'test_validation';
  return 'open';
}

export interface PlannedIssue {
  key: string;
  type: LocalType;
  title: string;
  description: string;
  state: 'open' | 'code_review' | 'test_validation' | 'closed';
  parentKey: string | null;
}
export interface ImportPlan {
  issues: PlannedIssue[];
  skipped: Record<string, number>; // Jira type name -> count, for types pjPlanner has no equivalent of
}

export interface LinkFields { epicLink: string | null; parentLink: string | null; epicName: string | null }

// Fields a search must ask for to plan an import.
export const searchFields = (links: LinkFields) =>
  ['summary', 'description', 'issuetype', 'status', 'parent', 'issuelinks', ...(links.epicLink ? [links.epicLink] : []), ...(links.parentLink ? [links.parentLink] : [])];

export const linkFields = (fields: JiraField[]): LinkFields => ({
  epicLink: fields.find((f) => f.custom && f.name === 'Epic Link')?.id ?? null,
  parentLink: fields.find((f) => f.custom && f.name === 'Parent Link')?.id ?? null,
  epicName: fields.find((f) => f.custom && f.name === 'Epic Name')?.id ?? null,
});

// Epic Link is a key string; Parent Link may be a string or an object depending on the plugin version.
const refKey = (v: unknown): string | null => {
  if (typeof v === 'string') return v || null;
  if (v && typeof v === 'object') {
    const o = v as any;
    return typeof o.key === 'string' ? o.key : typeof o.data?.key === 'string' ? o.data.key : null;
  }
  return null;
};

export function planImport(found: JiraIssue[], links: LinkFields): ImportPlan {
  const rawParent = (i: JiraIssue) =>
    refKey(i.fields.parent) ?? (links.epicLink ? refKey(i.fields[links.epicLink]) : null) ?? (links.parentLink ? refKey(i.fields[links.parentLink]) : null);
  const byKey = new Map(found.map((i) => [i.key, i]));
  const typeOf = (i: JiraIssue) => mapType(String(i.fields.issuetype?.name ?? ''));
  const skipped: Record<string, number> = {};
  const issues: PlannedIssue[] = [];
  for (const i of found) {
    const type = typeOf(i);
    if (!type) {
      const name = String(i.fields.issuetype?.name ?? 'unknown');
      skipped[name] = (skipped[name] ?? 0) + 1;
      continue;
    }
    // Nearest ancestor that may legally hold this type; skipped or invalid ones in between are stepped over.
    let parentKey: string | null = null;
    const seen = new Set<string>([i.key]);
    for (let cur = rawParent(i); cur && !seen.has(cur); ) {
      seen.add(cur);
      const p = byKey.get(cur);
      if (!p) break; // outside the filter
      const pt = typeOf(p);
      if (pt && PARENTS[type].includes(pt)) { parentKey = cur; break; }
      cur = rawParent(p);
    }
    // No real parent: a task is linked to its story/bug (or anything under an epic) by an issue link when pjPlanner uploaded it.
    // Upload creates that link with the child inward and the parent outward, so only outward links count: a link the other
    // way ("is blocked by" seen from the blocker, etc.) or one added by hand in the reverse direction is not a parent.
    if (!parentKey) {
      for (const l of Array.isArray(i.fields.issuelinks) ? i.fields.issuelinks : []) {
        const k = refKey(l?.outwardIssue);
        const pt = k ? byKey.get(k) && typeOf(byKey.get(k)!) : null;
        if (k && pt && PARENTS[type].includes(pt)) { parentKey = k; break; }
      }
    }
    issues.push({
      key: i.key, type,
      title: String(i.fields.summary ?? '').trim() || i.key,
      description: stripFootnote(typeof i.fields.description === 'string' ? i.fields.description : ''),
      state: mapState(String(i.fields.status?.name ?? ''), i.fields.status?.statusCategory?.key),
      parentKey,
    });
  }
  return { issues, skipped };
}

export const IMPORT_LIMIT = 1000;

// Runs the JQL and fetches what it matches (plus the ids of this instance's Epic Link and Parent Link fields). Refuses a filter that matches more than IMPORT_LIMIT.
export async function runFilter(cfg: JiraConfig, jql: string, fieldList?: JiraField[]): Promise<{ total: number; found: JiraIssue[]; links: LinkFields }> {
  const links = linkFields(fieldList ?? (await jiraFields(cfg)));
  const { total, issues } = await jiraSearch(cfg, jql, searchFields(links), IMPORT_LIMIT);
  if (total > IMPORT_LIMIT) throw bad(`the filter matches ${total} issues, more than the limit of ${IMPORT_LIMIT}; narrow it`);
  return { total, found: issues, links };
}

// Writing: the Jira issue type for a local one. A task is always a Task (never a Sub-task); under a story or bug it is linked instead.
export function jiraTypeName(type: LocalType): string {
  return { epic: 'Epic', story: 'Story', bug: 'Bug', task: 'Task' }[type];
}

// The link type used when none is chosen: the first named 'Relates' (any case), else the first the instance has.
export function defaultLinkType<T extends { name: string }>(types: T[]): T | null {
  return types.find((t) => t.name.trim().toLowerCase() === 'relates') ?? types[0] ?? null;
}

/** The `project` field of a create payload for a configured value: all digits is a Jira project id, anything else a project key. */
export const jiraProjectRef = (v: string): { key: string } | { id: string } => (/^\d+$/.test(v) ? { id: v } : { key: v });

const FOOTNOTE = '_Updated from pjPlanner_';
const FOOTNOTE_END = /\s*_Updated from pjPlanner_\s*$/;

export function stripFootnote(description: string): string {
  return description.replace(FOOTNOTE_END, '');
}

export function addFootnote(description: string): string {
  const body = stripFootnote(description).trimEnd();
  return body ? `${body}\n\n${FOOTNOTE}` : FOOTNOTE;
}

export interface CreateInput {
  project: { key: string } | { id: string };
  type: LocalType;
  title: string;
  description: string;
  label: string | null;
  parentType: LocalType | null;
  parentKey: string | null; // Jira key of the parent, if any
  links?: LinkFields; // only read for epics and epic children
  labels?: string[]; // explicit labels (an empty list means none); when omitted, `label` is used
  extra?: Record<string, unknown>; // further create-form fields, already in Jira's shape; never override the ones set here
}

export function buildCreatePayload(i: CreateInput): { fields: Record<string, unknown>; issueType: string } {
  const issueType = jiraTypeName(i.type);
  const fields: Record<string, unknown> = {
    ...i.extra, project: i.project, summary: i.title, description: addFootnote(i.description), issuetype: { name: issueType },
  };
  const labels = i.labels ?? (i.label ? [i.label] : []);
  if (labels.length) fields.labels = labels;
  if (i.type === 'epic') {
    if (!i.links?.epicName) throw bad("Jira has no 'Epic Name' field");
    fields[i.links.epicName] = i.title;
  } else if (i.parentKey && i.parentType === 'epic') {
    if (!i.links?.epicLink) throw bad("Jira has no 'Epic Link' field");
    fields[i.links.epicLink] = i.parentKey;
  }
  return { fields, issueType };
}

// Only summary, description and labels are ever pushed. Labels keep whatever Jira has and gain the project label if missing.
export function buildUpdatePayload(i: { title: string; description: string; label: string | null; currentLabels: string[] }): { fields: Record<string, unknown> } {
  const fields: Record<string, unknown> = { summary: i.title, description: addFootnote(i.description) };
  if (i.label) fields.labels = i.currentLabels.includes(i.label) ? i.currentLabels : [...i.currentLabels, i.label];
  return { fields };
}

// The Jira issue an unlinked local one already corresponds to: same mapped type and same title (trimmed, case-insensitive).
// `taken` are keys already linked to another local issue.
export function findMatch(found: JiraIssue[], type: LocalType, title: string, taken: Set<string> = new Set()): JiraIssue | null {
  const t = title.trim().toLowerCase();
  return found.find((j) => !taken.has(j.key) && mapType(String(j.fields.issuetype?.name ?? '')) === type && String(j.fields.summary ?? '').trim().toLowerCase() === t) ?? null;
}
