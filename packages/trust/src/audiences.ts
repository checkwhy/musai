import { type Audience, type AudienceForm, KernelError, parseAudience } from "@musai/records";

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
  const declare = (name: string, rawLine: string): void => {
    if (formOf(name) !== "name") {
      throw new RangeError(`declares something other than a name: ${rawLine}`);
    }
    if (!members.has(name)) {
      members.set(name, new Set());
      includes.set(name, new Set());
    }
  };
  const included: { name: string; target: string; rawLine: string }[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length === 1) {
      declare(fields[0]!, rawLine);
    } else if (fields.length === 3 && fields[1] === "member") {
      declare(fields[0]!, rawLine);
      const form = formOf(fields[2]!);
      if (form !== "key" && form !== "identity") {
        throw new RangeError(`a member is a key or an identity: ${rawLine}`);
      }
      members.get(fields[0]!)!.add(fields[2]!);
    } else if (fields.length === 3 && fields[1] === "includes") {
      declare(fields[0]!, rawLine);
      included.push({ name: fields[0]!, target: fields[2]!, rawLine });
    } else {
      throw new RangeError(`not an audiences file line: ${rawLine}`);
    }
  }
  for (const { name, target, rawLine } of included) {
    if (!members.has(target)) {
      throw new RangeError(`includes an audience this file does not declare: ${rawLine}`);
    }
    includes.get(name)!.add(target);
  }
  refuseCycles(includes);
  return {
    names: new Map(
      [...members.keys()].map((name) => [name, { members: members.get(name)!, includes: includes.get(name)! }]),
    ),
  };
}

function formOf(text: string): AudienceForm["form"] | undefined {
  try {
    return parseAudience(text).form;
  } catch {
    return undefined;
  }
}

function refuseCycles(includes: ReadonlyMap<string, ReadonlySet<string>>): void {
  const done = new Set<string>();
  const visit = (name: string, path: readonly string[]): void => {
    if (path.includes(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name];
      throw new KernelError({
        reason: "declaration-conflict",
        detail: `the audiences file declares a cycle: ${cycle.join(" includes ")}`,
        about: cycle,
      });
    }
    if (done.has(name)) {
      return;
    }
    for (const target of includes.get(name) ?? []) {
      visit(target, [...path, name]);
    }
    done.add(name);
  };
  for (const name of [...includes.keys()].sort()) {
    visit(name, []);
  }
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
