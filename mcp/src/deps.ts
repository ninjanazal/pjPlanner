export interface Relation {
  id: number;
  sourceId: number;
  targetId: number;
  label?: string;
}

/**
 * Transitive walk over relations. A relation `source -> target` means source depends on target.
 * "upstream" = what the module depends on; "downstream" = what depends on the module.
 */
export function findDependencies(
  relations: Relation[],
  moduleId: number,
  direction: "upstream" | "downstream",
): number[] {
  const next = (id: number) =>
    relations
      .filter((r) => (direction === "upstream" ? r.sourceId === id : r.targetId === id))
      .map((r) => (direction === "upstream" ? r.targetId : r.sourceId));
  const seen = new Set<number>();
  const queue = [moduleId];
  while (queue.length) {
    for (const n of next(queue.shift()!)) {
      if (n !== moduleId && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}
