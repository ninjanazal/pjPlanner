export interface SprintIssue { id: number; type: string; title: string; state: string; ownerId: number | null; moduleId: number | null; sprintId: number | null }
export interface Named { id: number; name: string }

const brief = (i: SprintIssue, owners: Named[], modules: Named[]) => ({
  id: i.id, type: i.type, title: i.title, state: i.state,
  owner: owners.find((o) => o.id === i.ownerId)?.name ?? null,
  module: modules.find((m) => m.id === i.moduleId)?.name ?? null,
});

const bucket = (issues: SprintIssue[], items: Named[], idOf: (i: SprintIssue) => number | null, owners: Named[], modules: Named[]) => {
  const out = items
    .map((x) => ({ name: x.name, id: x.id, issues: issues.filter((i) => idOf(i) === x.id) }))
    .filter((g) => g.issues.length > 0)
    .map((g) => ({ ...g, open: g.issues.filter((i) => i.state !== 'closed').length, issues: g.issues.map((i) => brief(i, owners, modules)) }));
  const rest = issues.filter((i) => !items.some((x) => x.id === idOf(i)));
  if (rest.length) out.push({ name: '(none)', id: null as unknown as number, open: rest.filter((i) => i.state !== 'closed').length, issues: rest.map((i) => brief(i, owners, modules)) });
  return out;
};

/** A sprint's work answered the way a dev team asks it: by module and by owner, with open counts. */
export function sprintView(sprint: unknown, all: SprintIssue[], modules: Named[], owners: Named[]) {
  const id = (sprint as { id: number }).id;
  const issues = all.filter((i) => i.sprintId === id);
  return {
    sprint,
    byModule: bucket(issues, modules, (i) => i.moduleId, owners, modules),
    byOwner: bucket(issues, owners, (i) => i.ownerId, owners, modules),
  };
}
