import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { afterAll } from "vitest";

interface Guard {
  readonly open: Map<DatabaseSync, string>;
}

const GUARD = Symbol.for("musai.test-support.index-guard");

// A builtin is one object per process, so a file sharing a worker patches it once.
function installedGuard(): Guard {
  const held = globalThis as { [GUARD]?: Guard };
  if (held[GUARD] !== undefined) {
    return held[GUARD];
  }
  const guard: Guard = { open: new Map() };
  const engine = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
  engine.DatabaseSync = class extends engine.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof DatabaseSync>) {
      super(...args);
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 40;
      const frames = (new Error().stack ?? "").split("\n").slice(2);
      Error.stackTraceLimit = limit;
      const own = frames.filter((frame) => !/node_modules|node:internal/.test(frame));
      guard.open.set(this, [String(args[0]), ...own].join("\n"));
    }
    override close(): void {
      super.close();
      guard.open.delete(this);
    }
  };
  held[GUARD] = guard;
  return guard;
}

const guard = installedGuard();

afterAll(() => {
  const left = [...guard.open.values()];
  guard.open.clear();
  if (left.length > 0) {
    throw new Error(`${left.length} index handles were left open, opened at:\n\n${left.join("\n\n")}`);
  }
});
