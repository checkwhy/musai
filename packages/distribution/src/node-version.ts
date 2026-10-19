const MINIMUM_NODE_MAJOR = 24;

/** The refusal for a Node below the floor, or `null`: an older one fails linking `node:module`. */
export function oldNodeRefusal(version: string): string | null {
  return Number(version.split(".")[0]) >= MINIMUM_NODE_MAJOR
    ? null
    : `musai needs Node ${MINIMUM_NODE_MAJOR} or later, and this is Node ${version}: install a newer Node and run it again`;
}
