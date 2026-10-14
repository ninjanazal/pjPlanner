import { describe, expect, it } from "vitest";
import { sprintView } from "../src/sprint.js";

const issue = (id: number, o: object = {}) => ({ id, type: "task", title: `T${id}`, state: "open", ownerId: null, moduleId: null, sprintId: 1, ...o });

describe("sprintView", () => {
  const modules = [{ id: 1, name: "Auth" }, { id: 2, name: "Billing" }];
  const owners = [{ id: 7, name: "Ana" }];
  const issues = [issue(1, { moduleId: 1, ownerId: 7 }), issue(2, { moduleId: 1, state: "closed" }), issue(3), issue(4, { sprintId: 2, moduleId: 2 })];
  const v = sprintView({ id: 1 }, issues, modules, owners);

  it("only includes the sprint's issues, grouped by module with open counts", () => {
    expect(v.byModule.map((g) => [g.name, g.open, g.issues.map((i) => i.id)])).toEqual([["Auth", 1, [1, 2]], ["(none)", 1, [3]]]);
  });
  it("groups by owner with names resolved", () => {
    expect(v.byOwner.map((g) => [g.name, g.issues.map((i) => i.id)])).toEqual([["Ana", [1]], ["(none)", [2, 3]]]);
    expect(v.byOwner[0].issues[0]).toMatchObject({ owner: "Ana", module: "Auth" });
  });
});

import { buildTimeline } from "../src/timeline.js";
describe("buildTimeline", () => {
  it("puts the dependent owner after the dependency, using estimates", () => {
    const t = (id: number, moduleId: number, ownerId: number, estimate: number | null = null) => ({ id, title: `t${id}`, state: "open", moduleId, ownerId, estimate });
    const tl = buildTimeline([t(1, 1, 1, 2), t(2, 2, 2)], [{ id: 1 }, { id: 2 }], [{ sourceId: 1, targetId: 2 }]);
    expect(tl.slots.find((s) => s.issue.id === 2)).toMatchObject({ start: 2, length: 1 });
    expect(tl.length).toBe(3);
  });
});
