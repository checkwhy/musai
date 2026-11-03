import { AUDIENCES_FILE, type Audience, type AudienceForm, parseAudience, TrustFileError } from "@musai/records";

export interface DeclaredAudience {
  readonly members: ReadonlySet<string>;
  readonly includes: ReadonlySet<string>;
}

export interface Audiences {
  readonly names: ReadonlyMap<string, DeclaredAudience>;
}

/** Lines, as `roles` is, so a membership change is one line and git merges two of them. */
export function parseAudiences(content: string): Audiences {
  const members = new Map<string, Set<string>>();
  const includes = new Map<string, Set<string>>();
  const unread = (why: string, index: number, rawLine: string) =>
    TrustFileError.atLine(AUDIENCES_FILE, index, why, rawLine);
  const declare = (name: string, index: number, rawLine: string): void => {
    if (formOf(name) !== "name") {
      throw unread("a declaration of something other than a name", index, rawLine);
    }
    if (!members.has(name)) {
      members.set(name, new Set());
      includes.set(name, new Set());
    }
  };
  const included: { name: string; target: string; index: number; rawLine: string }[] = [];
  for (const [index, rawLine] of content.split("\n").entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length === 1) {
      declare(fields[0]!, index, rawLine);
    } else if (fields.length === 3 && fields[1] === "member") {
      declare(fields[0]!, index, rawLine);
      const form = formOf(fields[2]!);
      if (form !== "key" && form !== "identity") {
        throw unread("a member that is neither a key nor an identity", index, rawLine);
      }
      members.get(fields[0]!)!.add(fields[2]!);
    } else if (fields.length === 3 && fields[1] === "includes") {
      declare(fields[0]!, index, rawLine);
      included.push({ name: fields[0]!, target: fields[2]!, index, rawLine });
    } else {
      throw unread("no declaration, member or includes", index, rawLine);
    }
  }
  const includedAt = new Map<string, { index: number; rawLine: string }>();
  for (const { name, target, index, rawLine } of included) {
    if (!members.has(target)) {
      throw unread("an includes naming an audience it does not declare", index, rawLine);
    }
    includes.get(name)!.add(target);
    const edge = includeEdge(name, target);
    if (!includedAt.has(edge)) {
      includedAt.set(edge, { index, rawLine });
    }
  }
  const cycle = cycleOf(includes);
  if (cycle !== null) {
    const { index, rawLine } = includedAt.get(includeEdge(cycle.at(-2)!, cycle.at(-1)!))!;
    throw unread(`an includes closing the cycle ${cycle.join(" includes ")}`, index, rawLine);
  }
  return {
    names: new Map(
      [...members.keys()].map((name) => [name, { members: members.get(name)!, includes: includes.get(name)! }]),
    ),
  };
}

/** What a refused line still declares, so a line naming that audience is not refused for it. */
export function setAsideAudiencesLine(rawLine: string): string {
  const fields = rawLine.trim().split(/\s+/);
  const declares = fields.length === 3 && (fields[1] === "member" || fields[1] === "includes");
  return declares && formOf(fields[0]!) === "name" ? fields[0]! : "";
}

function formOf(text: string): AudienceForm["form"] | undefined {
  try {
    return parseAudience(text).form;
  } catch {
    return undefined;
  }
}

function includeEdge(name: string, target: string): string {
  return `${name} includes ${target}`;
}

/** The first cycle a walk in name order meets, ending on the name it starts from; null for none. */
function cycleOf(includes: ReadonlyMap<string, ReadonlySet<string>>): readonly string[] | null {
  const done = new Set<string>();
  const visit = (name: string, path: readonly string[]): readonly string[] | null => {
    if (path.includes(name)) {
      return [...path.slice(path.indexOf(name)), name];
    }
    if (done.has(name)) {
      return null;
    }
    for (const target of includes.get(name) ?? []) {
      const cycle = visit(target, [...path, name]);
      if (cycle !== null) {
        return cycle;
      }
    }
    done.add(name);
    return null;
  };
  for (const name of [...includes.keys()].sort()) {
    const cycle = visit(name, []);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
}

/** Every name a release to `name` reaches through what each name includes, `name` among them. */
export function reachedFrom(audiences: Audiences, name: string): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [name];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (reached.has(next)) {
      continue;
    }
    reached.add(next);
    pending.push(...(audiences.names.get(next)?.includes ?? []));
  }
  return reached;
}

/** Whether a release to `granted` reaches `target`: coverage is declared, never inferred. */
export function covers(audiences: Audiences, granted: Audience | string, target: Audience | string): boolean {
  if (granted === "public" || granted === target) {
    return true;
  }
  if (parseAudience(granted).form !== "name" || target === "public") {
    return false;
  }
  const reached = reachedFrom(audiences, granted);
  if (parseAudience(target).form === "name") {
    return reached.has(target);
  }
  return [...reached].some((name) => audiences.names.get(name)?.members.has(target) ?? false);
}
