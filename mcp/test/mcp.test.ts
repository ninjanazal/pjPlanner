import { describe, expect, it } from "vitest";
import { ApiError, PlannerApi } from "../src/api.js";
import { findDependencies } from "../src/deps.js";
import { dropApiItems, mergeApiItems } from "../src/apiItems.js";

const rel = (id: number, sourceId: number, targetId: number) => ({ id, sourceId, targetId });

describe("findDependencies", () => {
  const rels = [rel(1, 1, 2), rel(2, 2, 3), rel(3, 4, 2), rel(4, 3, 1)];
  it("walks upstream transitively and survives cycles", () => {
    expect(findDependencies(rels, 1, "upstream")).toEqual([2, 3]);
  });
  it("walks downstream", () => {
    expect(findDependencies(rels, 2, "downstream")).toEqual([1, 3, 4]);
  });
});

describe("PlannerApi", () => {
  const mk = (res: Response) => new PlannerApi("http://x/", "k", (async () => res) as typeof fetch);
  it("returns parsed JSON", async () => {
    expect(await mk(Response.json({ a: 1 })).request("GET", "/graph")).toEqual({ a: 1 });
  });
  it("maps API errors", async () => {
    const res = Response.json({ error: { code: "not_found", message: "nope" } }, { status: 404 });
    await expect(mk(res).request("GET", "/modules/9")).rejects.toThrow(new ApiError("not_found: nope"));
  });
  it("sends the agent marker and key", async () => {
    let seen: Headers | undefined;
    const api = new PlannerApi("http://x", "secret", (async (_u: unknown, init: RequestInit) => {
      seen = new Headers(init.headers);
      return Response.json({});
    }) as typeof fetch);
    await api.request("POST", "/modules", { name: "a" });
    expect(seen!.get("x-api-key")).toBe("secret");
    expect(seen!.get("x-agent")).toBe("mcp");
  });
  it("sends x-project only when a project is configured", async () => {
    const seen: Headers[] = [];
    const f = (async (_u: unknown, init: RequestInit) => { seen.push(new Headers(init.headers)); return Response.json({}); }) as typeof fetch;
    await new PlannerApi("http://x", "k", f).request("GET", "/graph");
    await new PlannerApi("http://x", "k", f, "3").request("GET", "/graph");
    expect(seen[0].get("x-project")).toBeNull();
    expect(seen[1].get("x-project")).toBe("3");
  });
  it("handles 204", async () => {
    expect(await mk(new Response(null, { status: 204 })).request("DELETE", "/relations/1")).toBeUndefined();
  });
});

describe("api items", () => {
  const cur = [{ id: 1, kind: "endpoint", name: "GET /a" }, { id: 2, kind: "function", name: "run" }];
  it("adds new items and updates same kind+name in place", () => {
    const out = mergeApiItems(cur, [{ kind: "endpoint", name: "get /a", description: "d" }, { kind: "event", name: "done" }]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ id: 1, description: "d" });
    expect(out[2].name).toBe("done");
  });
  it("removes by id or name", () => {
    expect(dropApiItems(cur, [1], ["RUN"])).toEqual([]);
  });
});
