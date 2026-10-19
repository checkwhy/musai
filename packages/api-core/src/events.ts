import type { EventCursor } from "@musai/fold";
import { EMPTY_INSTALLED_MODULES, type InstalledModuleEntry, type InstalledModules } from "@musai/modules";
import type { EventKind } from "@musai/records";
import { OperationError } from "./errors.js";
import type { Workspace } from "./workspace.js";

/** `about` is the record's id, except for a module event, which is about the module's name. */
export interface Event {
  readonly kind: EventKind;
  readonly at: string;
  readonly about: string;
}

/** Empty (from the beginning), a commit sha, or `<sha>:<n>` (after position `n` in it). */
export type Cursor = string;

export interface EventsSinceResult {
  readonly events: readonly Event[];
  readonly cursor: Cursor;
}

const CURSOR_FORM = /^([0-9a-f]{40})(?::([0-9]+))?$/;

function placeCursor(cursor: string): EventCursor {
  const match = CURSOR_FORM.exec(cursor);
  if (match === null) {
    throw new OperationError({
      reason: "invalid-input",
      about: [cursor],
      detail: `cursor ${cursor} is neither a commit sha nor <sha>:<position> — read from the beginning with an empty cursor`,
    });
  }
  const [, commit, position] = match;
  return position === undefined ? { commit: commit! } : { commit: commit!, position: Number(position) };
}

/** The cursor past everything `opened` has folded. */
export function headCursor(opened: Workspace): Cursor {
  return opened.index.watermark() ?? "";
}

/** A cursor the fold does not hold is refused `stale`, never silently read from the beginning. */
export async function eventsSince(opened: Workspace, cursor?: Cursor): Promise<EventsSinceResult> {
  const after = cursor === undefined || cursor === "" ? undefined : placeCursor(cursor);
  // Read before the rows, so a fold landing between the two never moves the cursor past a row.
  const folded = headCursor(opened);
  const rows = opened.index.eventsAfter(after);
  if (rows === undefined) {
    throw new OperationError({
      reason: "stale",
      about: [cursor!],
      detail: `cursor ${cursor} names a commit this scope's folded history does not hold — read from the beginning to recover`,
    });
  }
  const events = rows.map((row): Event => ({ kind: row.kind, at: row.commit, about: row.about }));
  return { events, cursor: folded };
}

/** Each name resolves to the module record the latest commit wrote, since an id says nothing of
 * which record is newer. */
export async function installedModules(opened: Workspace): Promise<InstalledModules> {
  const byName = new Map<string, InstalledModuleEntry>();
  for (const installed of opened.index.installedModuleRecords()) {
    byName.set(installed.name, { moduleRecordId: installed.id, version: installed.version });
  }
  return byName.size === 0 ? EMPTY_INSTALLED_MODULES : { byName };
}
