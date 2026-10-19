import type { RecordId } from "@musai/records";

/** Breadth first, since an export's bytes follow the order in which a walk reaches each id. */
export async function walkCitations<T>(
  from: readonly RecordId[],
  visit: (id: RecordId) => T | Promise<T>,
  onward: (visited: T) => readonly RecordId[],
  reached: Set<RecordId> = new Set(),
): Promise<T[]> {
  const visited: T[] = [];
  const pending = [...new Set(from)].filter((id) => !reached.has(id));
  for (const id of pending) {
    reached.add(id);
  }
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const member = await visit(next);
    visited.push(member);
    for (const id of onward(member)) {
      if (!reached.has(id)) {
        reached.add(id);
        pending.push(id);
      }
    }
  }
  return visited;
}
