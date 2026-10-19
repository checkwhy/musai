import { versionString } from "./numbers.js";

/** Bumped when a change to status, authority or staleness would relabel a claim. A case whose pin
 * differs goes stale rather than being refused. */
export const EVALUATOR_VERSION = versionString("1");
