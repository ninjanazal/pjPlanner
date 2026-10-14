import { descendantIds } from './issueTree';
import type { Issue, IssueType, Module, Owner, Relation, Sprint } from './types';

// Everything here is derived from the current issues, sprints and modules: the data has no history yet, so these are
// snapshots (where the work stands), not trends. A task's size is its estimate in steps (1 when unset).
export const stepsOf = (i: Issue) => i.estimate ?? 1;
const isTask = (i: Issue) => i.type === 'task';
const unfinished = (i: Issue) => i.state !== 'closed';

export interface Tally {
  tasks: number; open: number; codeReview: number; testValidation: number; closed: number;
  steps: number; doneSteps: number; remainingSteps: number; pct: number; // pct = share of steps done, 0-100
}

export function tally(tasks: Issue[]): Tally {
  const t: Tally = { tasks: tasks.length, open: 0, codeReview: 0, testValidation: 0, closed: 0, steps: 0, doneSteps: 0, remainingSteps: 0, pct: 0 };
  for (const i of tasks) {
    const s = stepsOf(i);
    t.steps += s;
    if (i.state === 'closed') { t.closed++; t.doneSteps += s; }
    else { t.remainingSteps += s; if (i.state === 'open') t.open++; else if (i.state === 'code_review') t.codeReview++; else t.testValidation++; }
  }
  t.pct = t.steps ? Math.round((t.doneSteps / t.steps) * 100) : 0;
  return t;
}

export interface OwnerLoad { owner: Owner; open: number; remaining: number; share: number; overloaded: boolean }

// Remaining steps per owner; "overloaded" = clearly above the team average (1.5x, with at least two owners).
export function ownerLoads(issues: Issue[], owners: Owner[]): OwnerLoad[] {
  const rows = owners.map((owner) => {
    const mine = issues.filter((i) => isTask(i) && i.ownerId === owner.id && unfinished(i));
    return { owner, open: mine.length, remaining: mine.reduce((n, i) => n + stepsOf(i), 0) };
  });
  const total = rows.reduce((n, r) => n + r.remaining, 0);
  const avg = rows.length ? total / rows.length : 0;
  return rows
    .map((r) => ({ ...r, share: total ? r.remaining / total : 0, overloaded: rows.length >= 2 && avg > 0 && r.remaining > avg * 1.5 }))
    .sort((a, b) => b.remaining - a.remaining || a.owner.name.localeCompare(b.owner.name));
}

export interface OwnerMetrics {
  tally: Tally; avgSteps: number; share: number; rank: number; ownerCount: number; overloaded: boolean;
  activeSprintSteps: number; activeSprintName: string | null;
  perModule: { module: Module; tally: Tally }[];
}

export function ownerMetrics(issues: Issue[], owners: Owner[], modules: Module[], sprints: Sprint[], ownerId: number): OwnerMetrics {
  const mine = issues.filter((i) => isTask(i) && i.ownerId === ownerId);
  const loads = ownerLoads(issues, owners);
  const me = loads.find((l) => l.owner.id === ownerId);
  const active = sprints.find((s) => s.state === 'active') ?? null;
  const t = tally(mine);
  return {
    tally: t,
    avgSteps: t.tasks ? Math.round((t.steps / t.tasks) * 10) / 10 : 0,
    share: me?.share ?? 0,
    rank: Math.max(1, loads.findIndex((l) => l.owner.id === ownerId) + 1),
    ownerCount: owners.length,
    overloaded: me?.overloaded ?? false,
    activeSprintName: active?.name ?? null,
    activeSprintSteps: active ? mine.filter((i) => i.sprintId === active.id && unfinished(i)).reduce((n, i) => n + stepsOf(i), 0) : 0,
    perModule: modules
      .map((module) => ({ module, tally: tally(mine.filter((i) => i.moduleId === module.id)) }))
      .filter((r) => r.tally.tasks > 0)
      .sort((a, b) => b.tally.remainingSteps - a.tally.remainingSteps || a.module.name.localeCompare(b.module.name)),
  };
}

export interface ProjectMetrics {
  tasks: Tally;
  byType: Record<IssueType, { total: number; closed: number }>;
  inFlight: number; // tasks in code review or test validation
  unassignedOpen: number; backlogOpen: number; unestimatedOpen: number;
  sprints: { sprint: Sprint; tally: Tally }[]; // active first, then planned, then closed
  owners: OwnerLoad[];
  modules: { module: Module; tally: Tally; ownerCount: number; dependents: number }[];
  modulesWithoutOwner: Module[];
  epics: { issue: Issue; tally: Tally }[];
}

export function projectMetrics(issues: Issue[], owners: Owner[], modules: Module[], sprints: Sprint[], relations: Relation[]): ProjectMetrics {
  const tasks = issues.filter(isTask);
  const open = tasks.filter(unfinished);
  const byType = { epic: { total: 0, closed: 0 }, story: { total: 0, closed: 0 }, bug: { total: 0, closed: 0 }, task: { total: 0, closed: 0 } };
  for (const i of issues) { byType[i.type].total++; if (i.state === 'closed') byType[i.type].closed++; }
  const rank = { active: 0, planned: 1, closed: 2 } as const;
  return {
    tasks: tally(tasks),
    byType,
    inFlight: tasks.filter((i) => i.state === 'code_review' || i.state === 'test_validation').length,
    unassignedOpen: open.filter((i) => i.ownerId == null).length,
    backlogOpen: open.filter((i) => i.sprintId == null).length,
    unestimatedOpen: open.filter((i) => i.estimate == null).length,
    sprints: [...sprints].sort((a, b) => rank[a.state] - rank[b.state] || a.id - b.id)
      .map((sprint) => ({ sprint, tally: tally(tasks.filter((i) => i.sprintId === sprint.id)) })),
    owners: ownerLoads(issues, owners),
    modules: modules
      .map((module) => ({
        module, tally: tally(tasks.filter((i) => i.moduleId === module.id)), ownerCount: module.ownerIds.length,
        dependents: relations.filter((r) => r.targetId === module.id).length, // source -> target means source depends on target
      }))
      .sort((a, b) => b.tally.remainingSteps - a.tally.remainingSteps || a.module.name.localeCompare(b.module.name)),
    modulesWithoutOwner: modules.filter((m) => m.ownerIds.length === 0),
    epics: issues.filter((i) => i.type === 'epic').sort((a, b) => a.id - b.id)
      .map((issue) => { const below = descendantIds(issues, issue.id); return { issue, tally: tally(tasks.filter((i) => below.has(i.id))) }; }),
  };
}

// ---- Timing (needs the server's timestamps: only tasks closed in pjPlanner have a close time) ----

const DAY = 86_400_000;
const at = (v?: string | null) => (v ? Date.parse(v) : NaN);

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '–';
  const min = ms / 60_000;
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  const h = min / 60;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  const d = h / 24;
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} d`;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface Speed { count: number; steps: number; avgLeadMs: number; msPerStep: number; reopens: number }
export interface OwnerSpeed extends Speed { owner: Owner; fastest: boolean }
export interface ModuleTemp extends Speed {
  module: Module; open: number; closedRecent: number; touchedRecent: number; lastActivity: number; idleDays: number;
  hottest: boolean; coldest: boolean; quickest: boolean; slowest: boolean;
}
export interface WeekBucket { start: number; closed: number; created: number; steps: number }

export interface TimeMetrics {
  closedCount: number; // tasks with a recorded close time
  avgLeadMs: number; medianLeadMs: number; avgWorkMs: number; msPerStep: number;
  reopenRate: number; reopenedTasks: number;
  avgOpenAgeMs: number; oldestOpen: { issue: Issue; ageMs: number } | null;
  weeks: WeekBucket[]; // oldest first, 7-day windows ending now
  thisWeek: number; lastWeek: number;
  owners: OwnerSpeed[]; modules: ModuleTemp[];
}

const MIN_SAMPLES = 2; // "fastest"/"slowest" need at least this many closed tasks, and two candidates to compare

function speed(done: Issue[], allOfThem: Issue[]): Speed {
  const lead = done.map((i) => at(i.closedAt) - at(i.createdAt)).filter((x) => x >= 0);
  const steps = done.reduce((n, i) => n + stepsOf(i), 0);
  const leadTotal = done.reduce((n, i) => n + Math.max(0, at(i.closedAt) - at(i.createdAt)), 0);
  return { count: done.length, steps, avgLeadMs: mean(lead), msPerStep: steps ? leadTotal / steps : NaN, reopens: allOfThem.reduce((n, i) => n + (i.reopenCount ?? 0), 0) };
}

export function timeMetrics(issues: Issue[], owners: Owner[], modules: Module[], now = Date.now(), weeks = 8, recentDays = 14): TimeMetrics {
  const tasks = issues.filter(isTask);
  const done = tasks.filter((i) => i.state === 'closed' && Number.isFinite(at(i.closedAt)) && Number.isFinite(at(i.createdAt)));
  const open = tasks.filter(unfinished).filter((i) => Number.isFinite(at(i.createdAt)));
  const all = speed(done, tasks);
  const work = done.map((i) => at(i.closedAt) - at(i.startedAt)).filter((x) => Number.isFinite(x) && x >= 0);
  const reopens = tasks.reduce((n, i) => n + (i.reopenCount ?? 0), 0);

  const buckets: WeekBucket[] = Array.from({ length: weeks }, (_, k) => ({ start: now - (weeks - k) * 7 * DAY, closed: 0, created: 0, steps: 0 }));
  const bucket = (t: number) => buckets.find((b, k) => t >= b.start && (t < b.start + 7 * DAY || (k === weeks - 1 && t <= now)));
  for (const i of done) { const b = bucket(at(i.closedAt)); if (b) { b.closed++; b.steps += stepsOf(i); } }
  for (const i of tasks) { const b = bucket(at(i.createdAt)); if (b) b.created++; }

  const recentFrom = now - recentDays * DAY;
  const ownerRows = owners.map((owner) => {
    const mine = done.filter((i) => (i.closedOwnerId ?? i.ownerId) === owner.id);
    return { owner, ...speed(mine, tasks.filter((i) => (i.closedOwnerId ?? i.ownerId) === owner.id)), fastest: false };
  });
  const qualified = ownerRows.filter((r) => r.count >= MIN_SAMPLES && Number.isFinite(r.msPerStep));
  if (qualified.length >= 2) qualified.reduce((a, b) => (b.msPerStep < a.msPerStep ? b : a)).fastest = true;

  const moduleRows: ModuleTemp[] = modules.map((module) => {
    const mine = tasks.filter((i) => i.moduleId === module.id);
    const mineDone = done.filter((i) => i.moduleId === module.id);
    const last = Math.max(0, ...mine.map((i) => at(i.updatedAt ?? i.createdAt)).filter(Number.isFinite));
    return {
      module, ...speed(mineDone, mine), open: mine.filter(unfinished).length,
      closedRecent: mineDone.filter((i) => at(i.closedAt) >= recentFrom).length,
      touchedRecent: mine.filter((i) => at(i.updatedAt ?? i.createdAt) >= recentFrom).length,
      lastActivity: last, idleDays: last ? Math.floor((now - last) / DAY) : 0,
      hottest: false, coldest: false, quickest: false, slowest: false,
    };
  });
  // Hottest: most tasks closed lately (ties: most touched). Coldest: a module that still has open work but was left alone the longest.
  const hot = moduleRows.filter((r) => r.closedRecent > 0 || r.touchedRecent > 0).sort((a, b) => b.closedRecent - a.closedRecent || b.touchedRecent - a.touchedRecent)[0];
  if (hot) hot.hottest = true;
  const cold = moduleRows.filter((r) => r.open > 0 && r !== hot).sort((a, b) => a.lastActivity - b.lastActivity)[0];
  if (cold && moduleRows.length >= 2) cold.coldest = true;
  const fast = moduleRows.filter((r) => r.count >= MIN_SAMPLES && Number.isFinite(r.msPerStep));
  if (fast.length >= 2) {
    fast.reduce((a, b) => (b.msPerStep < a.msPerStep ? b : a)).quickest = true;
    fast.reduce((a, b) => (b.msPerStep > a.msPerStep ? b : a)).slowest = true;
  }

  const oldest = open.sort((a, b) => at(a.createdAt) - at(b.createdAt))[0];
  return {
    closedCount: done.length, avgLeadMs: all.avgLeadMs, medianLeadMs: median(done.map((i) => at(i.closedAt) - at(i.createdAt))),
    avgWorkMs: mean(work), msPerStep: all.msPerStep,
    reopenRate: done.length + reopens ? reopens / (done.length + reopens) : 0, reopenedTasks: tasks.filter((i) => (i.reopenCount ?? 0) > 0).length,
    avgOpenAgeMs: mean(open.map((i) => now - at(i.createdAt))),
    oldestOpen: oldest ? { issue: oldest, ageMs: now - at(oldest.createdAt) } : null,
    weeks: buckets, thisWeek: buckets[buckets.length - 1]?.closed ?? 0, lastWeek: buckets[buckets.length - 2]?.closed ?? 0,
    owners: ownerRows.sort((a, b) => (Number.isFinite(a.msPerStep) ? a.msPerStep : Infinity) - (Number.isFinite(b.msPerStep) ? b.msPerStep : Infinity) || b.count - a.count),
    modules: moduleRows,
  };
}

export interface OwnerWeek { start: number; closed: number; steps: number }

// Tasks (and steps) an owner closed in each of the last `weeks` 7-day windows ending now, oldest first.
export function ownerWeeks(issues: Issue[], ownerId: number, now = Date.now(), weeks = 8): OwnerWeek[] {
  const buckets = Array.from({ length: weeks }, (_, k) => ({ start: now - (weeks - k) * 7 * DAY, closed: 0, steps: 0 }));
  for (const i of issues) {
    if (!isTask(i) || i.state !== 'closed' || (i.closedOwnerId ?? i.ownerId) !== ownerId) continue;
    const t = at(i.closedAt);
    const b = buckets.find((x, k) => t >= x.start && (t < x.start + 7 * DAY || (k === weeks - 1 && t <= now)));
    if (b) { b.closed++; b.steps += stepsOf(i); }
  }
  return buckets;
}
