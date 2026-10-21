import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContributionEntry, RunRecipe } from "@musai/records";
import { canonicalBytes, textOf, versionString } from "@musai/records";
import { currentKey, readKeyFile } from "@musai/store";
import { bindCheckouts, COMMIT_ENV, headCommit, headTree, makeCheckout } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";
import {
  authorisedBinary,
  BinaryNotFoundError,
  ConflictingRequirementError,
  type RequirementRegistry,
  requirementsFromModules,
} from "../src/binaries.js";
import { BindingError } from "../src/bindings.js";
import {
  ABSENT_CHANNELS,
  AMBIENT_CHANNELS,
  hygienicEnvironment,
  RunRefusedError,
  UndeclaredBinaryError,
  withScratch,
} from "../src/hygiene.js";
import { secretObservation } from "../src/secrets.js";
import { performRecipe } from "../src/spawn.js";

/** Windows refuses a symlink with `EPERM` without Developer Mode, so those tests skip there. */
async function symlinksPermitted(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "musai-symlink-probe-"));
  try {
    await symlink(".", join(dir, "link"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SYMLINKS_PERMITTED = await symlinksPermitted();
const SYMLINK_PRIVILEGE_MISSING =
  "creating a symbolic link needs a privilege this process lacks (on Windows, Developer Mode or the create-symbolic-link privilege)";

function recipe(overrides: Partial<RunRecipe> = {}): RunRecipe {
  return {
    command: ["true"],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
    ...overrides,
  };
}

/** Declares exactly the binaries named, each by a fixture module. */
function registryDeclaring(...binaries: readonly string[]): RequirementRegistry {
  return requirementsFromModules(binaries.map((binary) => requirementRow("test.fixture", binary, null)));
}

/** Stamps the predicate onto the contribution id, so two modules can declare one binary. */
function requirementRow(
  moduleName: string,
  binary: string,
  versionPredicate: string | null,
): { readonly moduleName: string; readonly entry: ContributionEntry } {
  return {
    moduleName,
    entry: {
      kind: "requirement",
      id: `${moduleName}/${binary}/${versionPredicate ?? "any"}`,
      version: versionString("1"),
      input: {
        binary,
        versionPredicate,
        neededBy: `${moduleName}'s own fixture`,
        install: "already on this machine",
      },
      output: true,
      documentation: `${binary}, needed by ${moduleName}`,
    },
  };
}

describe("requirementsFromModules: two modules declaring one binary", () => {
  test("agreeing on the version predicate folds to one entry, attributed to whichever module was folded first", () => {
    const registry = requirementsFromModules([
      requirementRow("first.module", "git", ">=2.40"),
      requirementRow("second.module", "git", ">=2.40"),
    ]);
    const entry = registry.byBinary.get("git");
    expect(entry?.declaredBy).toBe("first.module");
    expect(entry?.versionPredicate).toBe(">=2.40");
  });

  test("disagreeing on the version predicate folds a conflict naming both modules, and authorising that binary is refused by name", () => {
    let registry: RequirementRegistry | undefined;
    expect(() => {
      registry = requirementsFromModules([
        requirementRow("first.module", "git", ">=2.40"),
        requirementRow("second.module", "git", ">=2.45"),
      ]);
    }).not.toThrow();
    expect(registry!.conflicts.get("git")).toEqual({ binary: "git", first: "first.module", second: "second.module" });
    expect(() => authorisedBinary(registry!, "git")).toThrow(ConflictingRequirementError);
    expect(() => authorisedBinary(registry!, "git")).toThrow(
      "first.module and second.module declare it with different version predicates",
    );
  });
});

describe("hygienicEnvironment: the exact record a child receives", () => {
  test("a recipe declaring no environment sees exactly the assigned channels, with every absent channel left out", async () => {
    await withScratch(async (scratch) => {
      const env = hygienicEnvironment(recipe(), scratch, {});
      const absent: readonly string[] = ABSENT_CHANNELS;
      expect(Object.keys(env).sort()).toEqual(AMBIENT_CHANNELS.filter((name) => !absent.includes(name)).sort());
    });
  });

  test("a recipe literal or a declared name carrying a channel left absent is refused, naming the variable", async () => {
    await withScratch(async (scratch) => {
      const literal = recipe({ environment: { GIT_DIR: "/elsewhere/.git" } });
      expect(() => hygienicEnvironment(literal, scratch, {})).toThrow(/GIT_DIR/);
      const declared = recipe({ declared: [{ name: "GIT_WORK_TREE", secret: false }] });
      expect(() => hygienicEnvironment(declared, scratch, { GIT_WORK_TREE: "/elsewhere" })).toThrow(RunRefusedError);
    });
  });

  test("a declared name bound to the empty string is present and empty, distinct from a name never declared", async () => {
    await withScratch(async (scratch) => {
      const withDeclared = recipe({ declared: [{ name: "MUSAI_TEST_DECLARED", secret: false }] });
      const env = hygienicEnvironment(withDeclared, scratch, { MUSAI_TEST_DECLARED: "" });
      expect(env["MUSAI_TEST_DECLARED"]).toBe("");
      expect("MUSAI_TEST_UNDECLARED" in env).toBe(false);
    });
  });

  test("a recipe literal named HOME is refused before spawn, naming the variable", async () => {
    await withScratch(async (scratch) => {
      const collides = recipe({ environment: { HOME: "/elsewhere" } });
      expect(() => hygienicEnvironment(collides, scratch, {})).toThrow(RunRefusedError);
      expect(() => hygienicEnvironment(collides, scratch, {})).toThrow(/HOME/);
    });
  });

  test("a declared name PATH is refused the same way", async () => {
    await withScratch(async (scratch) => {
      const declaresPath = recipe({ declared: [{ name: "PATH", secret: false }] });
      expect(() => hygienicEnvironment(declaresPath, scratch, {})).toThrow(RunRefusedError);
      expect(() => hygienicEnvironment(declaresPath, scratch, {})).toThrow(/PATH/);
    });
  });

  test("a recipe literal named PATH is refused", async () => {
    await withScratch(async (scratch) => {
      const literalPath = recipe({ environment: { PATH: "/usr/bin" } });
      expect(() => hygienicEnvironment(literalPath, scratch, {})).toThrow(RunRefusedError);
    });
  });
});

describe("performRecipe: a child sees exactly the hygiene assignments and nothing else", () => {
  test("a recipe declaring no environment sees exactly the hygiene assignments, read back through the child's own stdout", async () => {
    const { observation } = await performRecipe(
      recipe({ command: ["node", "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"] }),
      { requirementRegistry: registryDeclaring("node") },
    );
    const seenKeys: string[] = JSON.parse(textOf(observation.output, "the probe's output"));
    // A platform may inject variables of its own, so this asserts only that nothing of ours leaked.
    const absent: readonly string[] = ABSENT_CHANNELS;
    const assigned: readonly string[] = AMBIENT_CHANNELS.filter((key) => !absent.includes(key));
    const undeclaredKeys = seenKeys.filter((key) => !assigned.includes(key) && key !== "PATH");
    for (const key of undeclaredKeys) {
      expect(key.startsWith("__CF_")).toBe(true);
    }
    expect([...assigned, "PATH"].every((key) => seenKeys.includes(key))).toBe(true);
  });
});

describe("performRecipe: exit codes and lossy decoding", () => {
  test("a recipe naming no command is refused before anything spawns", async () => {
    await expect(performRecipe(recipe({ command: [] }))).rejects.toThrow(RunRefusedError);
  });

  test("a clean exit records exit code 0", async () => {
    const { observation } = await performRecipe(recipe({ command: ["true"] }), {
      requirementRegistry: registryDeclaring("true"),
    });
    expect(observation.exitCode).toBe(0);
  });

  test("a non-zero exit is data the caller reads back, never a thrown error", async () => {
    const { observation } = await performRecipe(recipe({ command: ["node", "-e", "process.exit(3)"] }), {
      requirementRegistry: registryDeclaring("node"),
    });
    expect(observation.exitCode).toBe(3);
  });

  test("a signal-terminated run records an exit code outside 0-255", async () => {
    const { observation } = await performRecipe(
      recipe({ command: ["node", "-e", "process.kill(process.pid, 'SIGTERM')"] }),
      { requirementRegistry: registryDeclaring("node") },
    );
    expect(observation.exitCode).toBeGreaterThan(255);
  });

  test("output that is not valid UTF-8 is decoded with replacement and flagged lossy", async () => {
    const { observation } = await performRecipe(
      recipe({ command: ["node", "-e", "process.stdout.write(Buffer.from([0xff, 0xfe, 0xfd]))"] }),
      { requirementRegistry: registryDeclaring("node") },
    );
    expect(observation.outputLossy).toBe(true);
    expect(observation.output).toContain("�");
  });

  test("a recipe declaring a binary the machine has records its name and a digest and never its path", async () => {
    const { observation } = await performRecipe(recipe({ command: ["true"] }), {
      requirementRegistry: registryDeclaring("true"),
    });
    expect(observation.binaries).toHaveLength(1);
    expect(Object.keys(observation.binaries[0]!).sort()).toEqual(["digest", "name"]);
    expect(observation.binaries[0]!.name).toBe("true");
  });

  test("a recipe declaring a binary the machine does not have is refused by name before spawning", async () => {
    await expect(
      performRecipe(recipe({ command: ["definitely-not-a-real-binary-musai-test"] }), {
        requirementRegistry: registryDeclaring("definitely-not-a-real-binary-musai-test"),
      }),
    ).rejects.toThrow(BinaryNotFoundError);
  });
});

describe("performRecipe: a run ends with every process it started", () => {
  const RUN_DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));

  /** A grandchild writing its pid to the file its argument names, then waiting forever. */
  const LINGERING =
    'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)';
  const IGNORING_SIGTERM = `process.on("SIGTERM", () => {}); ${LINGERING}`;

  /** A command starting `grandchild` with the run's own output streams, then waiting forever. */
  function startingGrandchild(grandchild: string, pidFile: string): string[] {
    const child = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}, ${JSON.stringify(pidFile)}], { stdio: "inherit" }); setInterval(() => {}, 1000)`;
    return ["node", "-e", child];
  }

  /** A zombie has ended: PID 1 in a container may never reap an orphan. */
  async function running(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    if (process.platform !== "linux") {
      return true;
    }
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    return stat !== "" && stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  }

  async function pidIn(file: string): Promise<number> {
    for (;;) {
      const written = await readFile(file, "utf8").catch(() => "");
      if (written !== "") {
        return Number(written);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function endedWithin(pid: number, ms: number): Promise<boolean> {
    for (const until = Date.now() + ms; Date.now() < until; ) {
      if (!(await running(pid))) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function pidFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "musai-grandchild-"));
    dirs.push(dir);
    return join(dir, "pid");
  }

  test("a grandchild holding the run's output ends with the run at its deadline", async () => {
    const file = await pidFile();
    const { timedOut } = await performRecipe(recipe({ command: startingGrandchild(LINGERING, file) }), {
      requirementRegistry: registryDeclaring("node"),
      timeoutMs: 2000,
    });

    expect(timedOut).toBe(true);
    expect(await running(await pidIn(file))).toBe(false);
  });

  test("a grandchild ignoring SIGTERM is killed once the deadline's grace has passed", async () => {
    const file = await pidFile();
    const { timedOut } = await performRecipe(recipe({ command: startingGrandchild(IGNORING_SIGTERM, file) }), {
      requirementRegistry: registryDeclaring("node"),
      timeoutMs: 2000,
    });

    expect(timedOut).toBe(true);
    expect(await running(await pidIn(file))).toBe(false);
  });

  test("a grandchild ignoring SIGTERM ends at the deadline though it holds none of the run's output", async () => {
    const file = await pidFile();
    const quiet = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IGNORING_SIGTERM)}, ${JSON.stringify(file)}], { stdio: "ignore" }); setInterval(() => {}, 1000)`;
    const { timedOut } = await performRecipe(recipe({ command: ["node", "-e", quiet] }), {
      requirementRegistry: registryDeclaring("node"),
      timeoutMs: 2000,
    });

    expect(timedOut).toBe(true);
    expect(await endedWithin(await pidIn(file), 1000)).toBe(true);
  });

  test("a caller interrupted mid-run ends the grandchildren of its run", async () => {
    const file = await pidFile();
    const command = JSON.stringify(startingGrandchild(LINGERING, file));
    const caller = execa(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { performRecipe } from ${JSON.stringify(RUN_DIST)}; await performRecipe({ command: ${command}, workingDirectory: "/", environment: {}, declared: [], substrates: [], isolation: "hygiene" });`,
      ],
      { reject: false },
    );
    const grandchild = await pidIn(file);
    caller.kill("SIGINT");

    expect((await caller).signal).toBe("SIGINT");
    expect(await endedWithin(grandchild, 5000)).toBe(true);
  });
});

describe("performRecipe: a binary is tooling somebody declared, or it does not run", () => {
  test("a command naming a binary no installed module declares is refused before resolveBinaries ever runs, naming the binary", async () => {
    const error = await performRecipe(recipe({ command: ["true"] }), {
      requirementRegistry: registryDeclaring("some-other-binary"),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UndeclaredBinaryError);
    expect((error as UndeclaredBinaryError).binary).toBe("true");
    expect((error as Error).message).toContain("true");
    // Undeclared and absent: had `resolveBinaries` run first, this would be `BinaryNotFoundError`.
    const secondError = await performRecipe(recipe({ command: ["definitely-not-a-real-binary-musai-test"] }), {
      requirementRegistry: registryDeclaring("some-other-binary"),
    }).catch((caught: unknown) => caught);
    expect(secondError).toBeInstanceOf(UndeclaredBinaryError);
  });

  test("a recipe naming tooling no installed module declares is refused before anything spawns, naming the tool", async () => {
    const error = await performRecipe(recipe({ command: ["true"], tooling: ["git"] }), {
      requirementRegistry: registryDeclaring("true"),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UndeclaredBinaryError);
    expect((error as UndeclaredBinaryError).binary).toBe("git");
  });

  test("a program the workspace's tools name is admitted", async () => {
    const { observation } = await performRecipe(recipe({ command: ["true"] }), {
      requirementRegistry: requirementsFromModules([], ["true"]),
    });
    expect(observation.binaries.map((binary) => binary.name)).toEqual(["true"]);
  });

  test("a program named nowhere is refused, naming the config entry that admits it", async () => {
    const error = await performRecipe(recipe({ command: ["true"] }), {
      requirementRegistry: requirementsFromModules([], ["false"]),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UndeclaredBinaryError);
    expect((error as Error).message).toContain(`config.json's "tools"`);
  });

  test("a recipe whose program and every tool are declared runs, recording each in the observation", async () => {
    const { observation } = await performRecipe(recipe({ command: ["true"], tooling: ["git"] }), {
      requirementRegistry: registryDeclaring("true", "git"),
    });
    expect(observation.binaries.map((binary) => binary.name)).toEqual(["true", "git"]);
  });

  test("a binary a fold holds two disagreeing declarations of is refused naming both, while another binary in the same registry runs", async () => {
    const registry = requirementsFromModules([
      requirementRow("first.module", "true", ">=1"),
      requirementRow("second.module", "true", ">=2"),
      requirementRow("first.module", "node", null),
    ]);
    const error = await performRecipe(recipe({ command: ["true"] }), { requirementRegistry: registry }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConflictingRequirementError);
    expect((error as Error).message).toContain("first.module and second.module");
    const { observation } = await performRecipe(recipe({ command: ["node", "-e", "process.exit(0)"] }), {
      requirementRegistry: registry,
    });
    expect(observation.exitCode).toBe(0);
  });

  test("a substrate pinned by digest resolves whether or not its own reference is authorised as tooling — the requirement lookup never sees a substrate", async () => {
    const { observation } = await performRecipe(
      recipe({
        command: ["true"],
        substrates: [{ uri: "some-tool-under-test", digest: { sha256: "a".repeat(64) } }],
      }),
      { requirementRegistry: registryDeclaring("true") },
    );
    expect(observation.resolved).toHaveLength(1);
    expect(observation.resolved[0]!.digest).toEqual({ sha256: "a".repeat(64) });
  });

  test("the recipe minted for an authorised binary carries no digest for it — the digest lives only in the observation's own binaries entry", async () => {
    const { recipe: minted, observation } = await performRecipe(recipe({ command: ["true"] }), {
      requirementRegistry: registryDeclaring("true"),
    });
    expect(JSON.stringify(minted)).not.toContain(observation.binaries[0]!.digest);
    expect(observation.binaries[0]!.digest.length).toBeGreaterThan(0);
  });
});

/** One behaviour in two files differing only by a comment: two machines' builds of one tool. */
async function writeProgramCopy(dir: string, name: string, distinguishingComment: string): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, ["#!/bin/sh", `# ${distinguishingComment}`, "exit 0", ""].join("\n"));
  await chmod(path, 0o755);
}

describe("performRecipe: a recipe is what travels, and an observation is what this machine saw", () => {
  /** A receipt id differs between machines by construction: it names the program's own digest. */
  test("one recipe performed under two PATHs, each finding a different program of one name, keeps its canonical bytes and records two different binary digests", async () => {
    const program = "musai-probe-program";
    const dirA = await mkdtemp(join(tmpdir(), "musai-program-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "musai-program-b-"));
    const originalPath = process.env["PATH"];
    try {
      await writeProgramCopy(dirA, program, "the copy one machine holds");
      await writeProgramCopy(dirB, program, "the copy another machine holds");
      // Decoded only so a difference prints as JSON; the bytes compared are the kernel's.
      const canonicalText = (value: RunRecipe): string => new TextDecoder().decode(canonicalBytes(value));
      const declared = canonicalText(recipe({ command: [program] }));
      const options = { requirementRegistry: registryDeclaring(program) };

      process.env["PATH"] = dirA;
      const seenA = await performRecipe(recipe({ command: [program] }), options);
      process.env["PATH"] = dirB;
      const seenB = await performRecipe(recipe({ command: [program] }), options);

      expect(canonicalText(seenA.recipe), "the recipe performed under the first PATH").toBe(declared);
      expect(canonicalText(seenB.recipe), "the recipe performed under the second PATH").toBe(declared);
      expect(seenA.observation.binaries.map((binary) => binary.name)).toEqual([program]);
      expect(seenB.observation.binaries.map((binary) => binary.name)).toEqual([program]);
      expect(seenB.observation.binaries[0]!.digest, "the two observations' binary digests").not.toBe(
        seenA.observation.binaries[0]!.digest,
      );
    } finally {
      if (originalPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = originalPath;
      }
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });
});

/** Runs the tool its first argument names, by bare name through the child's own `PATH`. */
async function writeCallingProgram(dir: string, name: string): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, ["#!/bin/sh", '"$1"', ""].join("\n"));
  await chmod(path, 0o755);
}

describe("performRecipe: a recipe names the tools it reaches for, and the child's PATH holds those and nothing else", () => {
  /** The program's directory, a named tool's, and one holding a tool no recipe names. */
  async function withThreeDirectories(
    fn: (names: { program: string; tool: string; unnamed: string }) => Promise<void>,
  ): Promise<void> {
    const names = { program: "musai-calling-program", tool: "musai-named-tool", unnamed: "musai-unnamed-tool" };
    const programDir = await mkdtemp(join(tmpdir(), "musai-program-"));
    const toolDir = await mkdtemp(join(tmpdir(), "musai-tool-"));
    const unnamedDir = await mkdtemp(join(tmpdir(), "musai-unnamed-"));
    const originalPath = process.env["PATH"];
    try {
      await writeCallingProgram(programDir, names.program);
      await writeProgramCopy(toolDir, names.tool, "a tool the recipe names");
      await writeProgramCopy(unnamedDir, names.unnamed, "a tool no recipe names");
      process.env["PATH"] = [programDir, toolDir, unnamedDir].join(delimiter);
      await fn(names);
    } finally {
      if (originalPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = originalPath;
      }
      await rm(programDir, { recursive: true, force: true });
      await rm(toolDir, { recursive: true, force: true });
      await rm(unnamedDir, { recursive: true, force: true });
    }
  }

  test.skipIf(process.platform === "win32")(
    "a program calling a tool the recipe does not name cannot reach it, though the tool is on the invoking PATH",
    async () => {
      await withThreeDirectories(async ({ program, tool }) => {
        const { observation } = await performRecipe(recipe({ command: [program, tool] }));
        expect(observation.exitCode).not.toBe(0);
        expect(observation.binaries.map((binary) => binary.name)).toEqual([program]);
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "a tool sharing the program's directory stays out of reach while the recipe does not name it",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "musai-shared-dir-"));
      const originalPath = process.env["PATH"];
      try {
        await writeCallingProgram(dir, "musai-calling-program");
        await writeProgramCopy(dir, "musai-neighbour-tool", "a tool beside the program");
        process.env["PATH"] = dir;

        const { observation } = await performRecipe(
          recipe({ command: ["musai-calling-program", "musai-neighbour-tool"] }),
        );

        expect(observation.exitCode).toBe(127);
      } finally {
        process.env["PATH"] = originalPath;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "a program calling a tool the recipe names reaches it, and the observation names the program first and the tool after",
    async () => {
      await withThreeDirectories(async ({ program, tool }) => {
        const { observation } = await performRecipe(recipe({ command: [program, tool], tooling: [tool] }));
        expect(observation.exitCode).toBe(0);
        expect(observation.binaries.map((binary) => binary.name)).toEqual([program, tool]);
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "a tool on the invoking PATH that the recipe does not name stays unreachable beside one it does",
    async () => {
      await withThreeDirectories(async ({ program, tool, unnamed }) => {
        const { observation } = await performRecipe(recipe({ command: [program, unnamed], tooling: [tool] }));
        expect(observation.exitCode).not.toBe(0);
      });
    },
  );

  test("a malformed tooling list is refused before anything spawns", async () => {
    await withLocalDir(async (localDir) => {
      const markerPath = join(localDir, "spawned-marker");
      const bad = recipe({
        command: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, '')`],
        tooling: ["node"],
      });
      await expect(performRecipe(bad)).rejects.toThrow(RunRefusedError);
      await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describe("performRecipe: a relative working directory needs a root to resolve against", () => {
  test("a relative working directory with no working root is refused before resolveBinaries ever runs, naming the working directory", async () => {
    // Absent here: had `resolveBinaries` run first, this would be `BinaryNotFoundError`.
    const bad = recipe({
      command: ["definitely-not-a-real-binary-musai-test"],
      workingDirectory: "nested/dir",
    });

    const error = await performRecipe(bad).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunRefusedError);
    expect(error).not.toBeInstanceOf(BinaryNotFoundError);
    expect((error as Error).message).toContain("nested/dir");
  });

  test("a relative working directory resolves against the supplied working root, read back through the spawned child's own cwd", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "musai-working-root-")));
    try {
      const { observation } = await performRecipe(
        recipe({
          command: ["node", "-e", "process.stdout.write(process.cwd())"],
          workingDirectory: ".",
        }),
        { requirementRegistry: registryDeclaring("node"), workingRoot: root },
      );
      expect(textOf(observation.output, "the probe's own cwd")).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function withLocalDir<T>(fn: (localDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "musai-spawn-local-"));
  const localDir = join(root, "local");
  await mkdir(localDir, { recursive: true });
  try {
    return await fn(localDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("performRecipe: a machine adds the programs its own launchers reach for", () => {
  const CALLS_SED = ["node", "-e", "require('child_process').execFileSync('sed', ['-n', 'p'], { input: '' })"];

  test("a program this machine lists reaches the run's PATH and its receipt by digest, and the recipe names none", async () => {
    await withLocalDir(async (localDir) => {
      const refused = await performRecipe(recipe({ command: CALLS_SED }), {
        localDir,
        requirementRegistry: registryDeclaring("node"),
      });
      await writeFile(join(localDir, "tools.json"), JSON.stringify(["sed"]));
      const listed = recipe({ command: CALLS_SED });

      const { observation } = await performRecipe(listed, { localDir, requirementRegistry: registryDeclaring("node") });

      expect(refused.observation.exitCode).not.toBe(0);
      expect(observation.exitCode).toBe(0);
      expect(observation.binaries.map((binary) => binary.name)).toContain("sed");
      expect(listed.tooling).toBeUndefined();
    });
  });

  test("refuses a list naming a path rather than a program", async () => {
    await withLocalDir(async (localDir) => {
      await writeFile(join(localDir, "tools.json"), JSON.stringify(["/usr/bin/sed"]));

      const message = await refusalMessage(localDir);
      expect(message).toMatch(/tools\.json/);
      expect(message).not.toContain(localDir);
    });
  });

  test("refuses a list that is not JSON, naming the file and no path on this machine", async () => {
    await withLocalDir(async (localDir) => {
      await writeFile(join(localDir, "tools.json"), "[sed");

      const message = await refusalMessage(localDir);
      expect(message).toMatch(/tools\.json/);
      expect(message).not.toContain(localDir);
    });
  });

  async function refusalMessage(localDir: string): Promise<string> {
    const error = await performRecipe(recipe({ command: CALLS_SED }), {
      localDir,
      requirementRegistry: registryDeclaring("node"),
    }).then(
      () => undefined,
      (refused: unknown) => refused,
    );
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
});

describe("performRecipe: a recipe naming a working tree runs in it, measured as it stands", () => {
  const TREE = { name: "tree", uri: "musai:tree" };
  const printCwd = ["node", "-e", "process.stdout.write(process.cwd())"];

  test("a run over a working tree records the tree's digest as measured", async () => {
    const checkout = await makeCheckout("committed");
    try {
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { tree: checkout.dir });
        const run = () =>
          performRecipe(recipe({ command: printCwd, workingDirectory: ".", substrates: [TREE] }), {
            localDir,
            requirementRegistry: registryDeclaring("node"),
          });

        const clean = await run();
        await writeFile(join(checkout.dir, "untracked.txt"), "not yet committed");
        const edited = await run();

        expect(clean.observation.resolved).toEqual([
          { name: "tree", digest: { gitTree: await headTree(checkout.dir) } },
        ]);
        expect(textOf(clean.observation.output, "the child's cwd")).toBe(await realpath(checkout.dir));
        expect(edited.observation.resolved[0]!.digest!.gitTree).toMatch(/^[0-9a-f]{40}$/);
        expect(edited.observation.resolved[0]!.digest!.gitTree).not.toBe(await headTree(checkout.dir));
      });
    } finally {
      await checkout.cleanup();
    }
  });

  test("a run over a tree holding its own workspace measures the tree without the workspace or its blobs", async () => {
    const checkout = await makeCheckout("committed");
    try {
      const localDir = join(checkout.dir, ".musai", "local");
      await mkdir(localDir, { recursive: true });
      await writeFile(join(checkout.dir, ".musai", "HEAD"), "ref: refs/heads/main\n");
      await mkdir(join(checkout.dir, ".musai", "blobs", "ab"), { recursive: true });
      await writeFile(join(checkout.dir, ".musai", "blobs", "ab", "a-module-bundle"), "bundle bytes");
      await bindCheckouts(localDir, { tree: checkout.dir });

      const { observation } = await performRecipe(
        recipe({ command: printCwd, workingDirectory: ".", substrates: [TREE] }),
        { localDir, requirementRegistry: registryDeclaring("node") },
      );

      expect(observation.resolved[0]!.digest).toEqual({ gitTree: await headTree(checkout.dir) });
    } finally {
      await checkout.cleanup();
    }
  });

  test("a project's own top-level blobs directory is measured with its tree", async () => {
    const checkout = await makeCheckout("committed");
    try {
      const localDir = join(checkout.dir, ".musai", "local");
      await mkdir(localDir, { recursive: true });
      await writeFile(join(checkout.dir, ".musai", "HEAD"), "ref: refs/heads/main\n");
      await mkdir(join(checkout.dir, "blobs"), { recursive: true });
      await writeFile(join(checkout.dir, "blobs", "fixture.bin"), "the project's own bytes");
      await bindCheckouts(localDir, { tree: checkout.dir });

      const { observation } = await performRecipe(
        recipe({ command: printCwd, workingDirectory: ".", substrates: [TREE] }),
        { localDir, requirementRegistry: registryDeclaring("node") },
      );

      expect(observation.resolved[0]!.digest!.gitTree).not.toBe(await headTree(checkout.dir));
    } finally {
      await checkout.cleanup();
    }
  });

  test("a workspace named through a symlink is still left out of the tree it sits in", async (context) => {
    if (!SYMLINKS_PERMITTED) {
      context.skip(SYMLINK_PRIVILEGE_MISSING);
    }
    const checkout = await makeCheckout("committed");
    const links = await mkdtemp(join(tmpdir(), "musai-tree-link-"));
    try {
      const link = join(links, "project");
      await symlink(checkout.dir, link);
      const localDir = join(link, ".musai", "local");
      await mkdir(localDir, { recursive: true });
      await bindCheckouts(localDir, { tree: checkout.dir });

      const { observation } = await performRecipe(
        recipe({ command: printCwd, workingDirectory: ".", substrates: [TREE] }),
        { localDir, requirementRegistry: registryDeclaring("node") },
      );

      expect(observation.resolved[0]!.digest).toEqual({ gitTree: await headTree(checkout.dir) });
    } finally {
      await rm(links, { recursive: true, force: true });
      await checkout.cleanup();
    }
  });

  test("a working directory leaving the tree is refused", async () => {
    const checkout = await makeCheckout();
    try {
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { tree: checkout.dir });
        for (const workingDirectory of ["..", "/", "nested/../.."]) {
          const error = await performRecipe(recipe({ command: printCwd, workingDirectory, substrates: [TREE] }), {
            localDir,
            requirementRegistry: registryDeclaring("node"),
          }).catch((caught: unknown) => caught);
          expect(error, workingDirectory).toBeInstanceOf(RunRefusedError);
          expect((error as Error).message, workingDirectory).toContain("leaves the checkout tree");
        }
      });
    } finally {
      await checkout.cleanup();
    }
  });

  test("a tree the workspace binds nowhere stands in the repository the workspace sits in", async () => {
    const checkout = await makeCheckout("committed");
    try {
      const localDir = join(checkout.dir, ".musai", "local");
      await mkdir(localDir, { recursive: true });

      const { observation } = await performRecipe(
        recipe({ command: printCwd, workingDirectory: ".", substrates: [TREE] }),
        { localDir, requirementRegistry: registryDeclaring("node") },
      );

      expect(textOf(observation.output, "the child's cwd")).toBe(await realpath(checkout.dir));
      expect(observation.resolved).toEqual([{ name: "tree", digest: { gitTree: await headTree(checkout.dir) } }]);
    } finally {
      await checkout.cleanup();
    }
  });

  test("a tree bound nowhere stands at the working root a caller names, ahead of any repository", async () => {
    const checkout = await makeCheckout("committed");
    try {
      const { observation } = await performRecipe(
        recipe({ command: printCwd, workingDirectory: ".", substrates: [TREE] }),
        { workingRoot: checkout.dir, requirementRegistry: registryDeclaring("node") },
      );

      expect(textOf(observation.output, "the child's cwd")).toBe(await realpath(checkout.dir));
    } finally {
      await checkout.cleanup();
    }
  });

  test("a tree bound nowhere, with the workspace in no repository, is refused naming checkouts.json", async () => {
    await withLocalDir(async (localDir) => {
      const error = await performRecipe(recipe({ command: printCwd, workingDirectory: ".", substrates: [TREE] }), {
        localDir,
        requirementRegistry: registryDeclaring("node"),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RunRefusedError);
      expect((error as Error).message).toContain("checkouts.json");
    });
  });
});

describe("performRecipe: a recipe naming a checkout runs in it, and only once its tree is the commit's", () => {
  test("a relative working directory resolves against the bound checkout, read back through a file the child reads from it", async () => {
    const checkout = await makeCheckout("the checkout's own content");
    try {
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { repo: checkout.dir });
        const { observation } = await performRecipe(
          recipe({
            command: ["node", "-e", "process.stdout.write(require('node:fs').readFileSync('tracked.txt', 'utf8'))"],
            workingDirectory: ".",
            substrates: [{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }],
          }),
          { localDir, requirementRegistry: registryDeclaring("node") },
        );
        expect(textOf(observation.output, "the file the child read")).toBe("the checkout's own content");
      });
    } finally {
      await checkout.cleanup();
    }
  });

  test("a child running git in the bound checkout reaches the checkout's own repository", async () => {
    const checkout = await makeCheckout();
    try {
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { repo: checkout.dir });
        const { observation } = await performRecipe(
          recipe({
            command: [
              "node",
              "-e",
              "process.stdout.write(require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD^{tree}']))",
            ],
            workingDirectory: ".",
            substrates: [{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }],
            tooling: ["git"],
          }),
          { localDir, requirementRegistry: registryDeclaring("node", "git") },
        );
        const tree = (await execa("git", ["-C", checkout.dir, "rev-parse", "HEAD^{tree}"])).stdout;
        expect(textOf(observation.output, "the tree git answered in the child").trim()).toBe(tree);
        expect(observation.exitCode).toBe(0);
      });
    } finally {
      await checkout.cleanup();
    }
  });

  test("the canonical bytes of the recipe and the observation hold no byte of the bound directory's path", async () => {
    const checkout = await makeCheckout();
    try {
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { repo: checkout.dir });
        const { recipe: performed, observation } = await performRecipe(
          recipe({
            command: ["true"],
            workingDirectory: ".",
            substrates: [{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }],
          }),
          { localDir, requirementRegistry: registryDeclaring("true") },
        );
        const text = new TextDecoder().decode(canonicalBytes({ recipe: performed, observation }));
        expect(observation.resolved).toHaveLength(1);
        expect(text).not.toContain(basename(checkout.dir));
        expect(text).not.toContain(basename(dirname(localDir)));
      });
    } finally {
      await checkout.cleanup();
    }
  });

  test("a checkout whose tree is not its commit's spawns nothing", async () => {
    const checkout = await makeCheckout();
    try {
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { repo: checkout.dir });
        const commit = await headCommit(checkout.dir);
        await writeFile(join(checkout.dir, "tracked.txt"), "dirtied");
        const markerPath = join(localDir, "spawned-marker");
        const dirty = recipe({
          command: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, '')`],
          workingDirectory: ".",
          substrates: [{ name: "repo", digest: { gitCommit: commit } }],
        });
        const error = await performRecipe(dirty, { localDir, requirementRegistry: registryDeclaring("node") }).catch(
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(RunRefusedError);
        expect((error as Error).message).toContain(commit);
        await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      await checkout.cleanup();
    }
  });

  test("a binary this machine does not have is refused before the checkout it stands on is measured", async () => {
    const checkout = await makeCheckout();
    try {
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { repo: checkout.dir });
        const commit = await headCommit(checkout.dir);
        await writeFile(join(checkout.dir, "tracked.txt"), "dirtied");
        const dirty = recipe({
          command: ["definitely-not-a-real-binary-musai-test"],
          workingDirectory: ".",
          substrates: [{ name: "repo", digest: { gitCommit: commit } }],
        });
        const error = await performRecipe(dirty, {
          localDir,
          requirementRegistry: registryDeclaring("definitely-not-a-real-binary-musai-test"),
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(BinaryNotFoundError);
      });
    } finally {
      await checkout.cleanup();
    }
  });

  test("a relative working directory beside two checkouts is refused, since it names no single root", async () => {
    const first = await makeCheckout("first");
    const second = await makeCheckout("second");
    try {
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { first: first.dir, second: second.dir });
        const markerPath = join(localDir, "spawned-marker");
        const ambiguous = recipe({
          command: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, '')`],
          workingDirectory: ".",
          substrates: [
            { name: "first", digest: { gitCommit: await headCommit(first.dir) } },
            { name: "second", digest: { gitCommit: await headCommit(second.dir) } },
          ],
        });
        const error = await performRecipe(ambiguous, {
          localDir,
          requirementRegistry: registryDeclaring("node"),
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(RunRefusedError);
        expect((error as Error).message).toContain("first");
        expect((error as Error).message).toContain("second");
        await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  test("a working directory that is absolute or leaves the checkout, in either separator, spawns nothing", async () => {
    const checkout = await makeCheckout();
    try {
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { repo: checkout.dir });
        const markerPath = join(localDir, "spawned-marker");
        for (const workingDirectory of [
          dirname(checkout.dir),
          "/",
          "..",
          "nested/../..",
          "..\\sibling",
          "C:\\elsewhere",
        ]) {
          const escaping = recipe({
            command: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, '')`],
            workingDirectory,
            substrates: [{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }],
          });
          const error = await performRecipe(escaping, {
            localDir,
            requirementRegistry: registryDeclaring("node"),
          }).catch((caught: unknown) => caught);
          expect(error, workingDirectory).toBeInstanceOf(RunRefusedError);
          expect((error as Error).message, workingDirectory).toContain("leaves the checkout");
          await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    } finally {
      await checkout.cleanup();
    }
  });

  test("a working directory that climbs and comes back down inside the checkout runs there", async () => {
    const checkout = await makeCheckout("the checkout's own content");
    try {
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { repo: checkout.dir });
        const { observation } = await performRecipe(
          recipe({
            command: ["node", "-e", "process.stdout.write(require('node:fs').readFileSync('tracked.txt', 'utf8'))"],
            workingDirectory: "nowhere/..",
            substrates: [{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }],
          }),
          { localDir, requirementRegistry: registryDeclaring("node") },
        );
        expect(textOf(observation.output, "the file the child read")).toBe("the checkout's own content");
      });
    } finally {
      await checkout.cleanup();
    }
  });

  test("a working directory through a committed symlink to a sibling whose name extends the checkout's spawns nothing", async (context) => {
    context.skip(!SYMLINKS_PERMITTED, SYMLINK_PRIVILEGE_MISSING);
    const checkout = await makeCheckout();
    const sibling = `${checkout.dir}-sibling`;
    try {
      await mkdir(sibling);
      await symlink(sibling, join(checkout.dir, "link"));
      await execa("git", ["-C", checkout.dir, "add", "link"]);
      await execa("git", ["-C", checkout.dir, "commit", "--quiet", "-m", "link"], { env: COMMIT_ENV });
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { repo: checkout.dir });
        const error = await performRecipe(
          recipe({
            command: ["true"],
            workingDirectory: "link",
            substrates: [{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }],
          }),
          { localDir, requirementRegistry: registryDeclaring("true") },
        ).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(RunRefusedError);
        expect((error as Error).message).toContain("resolves outside the checkout bound for substrate repo");
      });
    } finally {
      await checkout.cleanup();
      await rm(sibling, { recursive: true, force: true });
    }
  });

  test("a working directory through a committed symlink to a directory outside the checkout spawns nothing, though the checkout measures as its commit, naming the substrate and no directory", async (context) => {
    context.skip(!SYMLINKS_PERMITTED, SYMLINK_PRIVILEGE_MISSING);
    const checkout = await makeCheckout();
    const outside = await mkdtemp(join(tmpdir(), "musai-symlink-target-"));
    try {
      await symlink(outside, join(checkout.dir, "link"));
      await execa("git", ["-C", checkout.dir, "add", "link"]);
      await execa("git", ["-C", checkout.dir, "commit", "--quiet", "-m", "link"], { env: COMMIT_ENV });
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { repo: checkout.dir });
        const markerPath = join(localDir, "spawned-marker");
        const error = await performRecipe(
          recipe({
            command: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, '')`],
            workingDirectory: "link",
            substrates: [{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }],
          }),
          { localDir, requirementRegistry: registryDeclaring("node") },
        ).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(RunRefusedError);
        expect((error as Error).message).toContain("repo");
        expect((error as Error).message).not.toContain(basename(outside));
        expect((error as Error).message).not.toContain(basename(checkout.dir));
        await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      await checkout.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a working directory through a committed symlink to a directory inside the checkout runs there", async (context) => {
    context.skip(!SYMLINKS_PERMITTED, SYMLINK_PRIVILEGE_MISSING);
    const checkout = await makeCheckout("the checkout's own content");
    try {
      await symlink(".", join(checkout.dir, "here"));
      await execa("git", ["-C", checkout.dir, "add", "here"]);
      await execa("git", ["-C", checkout.dir, "commit", "--quiet", "-m", "here"], { env: COMMIT_ENV });
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { repo: checkout.dir });
        const { observation } = await performRecipe(
          recipe({
            command: ["node", "-e", "process.stdout.write(require('node:fs').readFileSync('tracked.txt', 'utf8'))"],
            workingDirectory: "here",
            substrates: [{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }],
          }),
          { localDir, requirementRegistry: registryDeclaring("node") },
        );
        expect(textOf(observation.output, "the file the child read")).toBe("the checkout's own content");
      });
    } finally {
      await checkout.cleanup();
    }
  });

  test("a working directory the commit does not hold spawns nothing, naming the error code and no directory", async () => {
    const checkout = await makeCheckout();
    try {
      await withLocalDir(async (localDir) => {
        await bindCheckouts(localDir, { repo: checkout.dir });
        const error = await performRecipe(
          recipe({
            command: ["true"],
            workingDirectory: "absent-at-this-commit",
            substrates: [{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }],
          }),
          { localDir, requirementRegistry: registryDeclaring("true") },
        ).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(RunRefusedError);
        expect((error as Error).message).toContain("ENOENT");
        expect((error as Error).message).not.toContain(basename(checkout.dir));
        expect((error as Error).message).not.toContain("absent-at-this-commit");
      });
    } finally {
      await checkout.cleanup();
    }
  });

  test("a working directory leaving a commit that carries no name is refused naming the commit", async () => {
    const commit = "a".repeat(40);
    const error = await performRecipe(recipe({ command: ["true"], substrates: [{ digest: { gitCommit: commit } }] }), {
      requirementRegistry: registryDeclaring("true"),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunRefusedError);
    expect((error as Error).message).toContain(`leaves the checkout commit ${commit},`);
  });

  test("a checkout the workspace binds nowhere is refused naming checkouts.json and no directory", async () => {
    await withLocalDir(async (localDir) => {
      const error = await performRecipe(
        recipe({
          command: ["true"],
          workingDirectory: ".",
          substrates: [{ name: "repo", digest: { gitCommit: "a".repeat(40) } }],
        }),
        { localDir, requirementRegistry: registryDeclaring("true") },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RunRefusedError);
      expect((error as Error).message).toContain("checkouts.json");
      expect((error as Error).message).not.toContain(basename(dirname(localDir)));
    });
  });
});

describe("performRecipe: a plain binding's recorded value names no path of this machine", () => {
  const PRINTS_IT = ["node", "-e", "process.stdout.write(String(process.env.MUSAI_TEST_PATH))"];
  const DECLARED = [{ name: "MUSAI_TEST_PATH", secret: false }];

  async function withRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "musai-portable-")));
    try {
      return await body(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("a path under the working root is recorded relative to it, and the run still sees it whole", async () => {
    await withRoot(async (root) => {
      const value = join(root, "sub", "file.js");
      const { observation } = await performRecipe(
        recipe({ command: PRINTS_IT, workingDirectory: ".", declared: DECLARED }),
        {
          requirementRegistry: registryDeclaring("node"),
          workingRoot: root,
          bindings: { MUSAI_TEST_PATH: { secret: false, value } },
        },
      );

      expect(textOf(observation.output, "the probe's output")).toBe(value);
      expect(observation.bindings[0]!.value).toBe("./sub/file.js");
    });
  });

  test("a path under a named root is recorded under that root's name", async () => {
    await withRoot(async (root) => {
      const { observation } = await performRecipe(recipe({ command: PRINTS_IT, declared: DECLARED }), {
        requirementRegistry: registryDeclaring("node"),
        bindingRoots: { "esbuild@0.28.2": root },
        bindings: { MUSAI_TEST_PATH: { secret: false, value: join(root, "lib", "main.js") } },
      });

      expect(observation.bindings[0]!.value).toBe("esbuild@0.28.2:lib/main.js");
    });
  });

  test("an absolute path under no root is refused before anything runs, naming the binding", async () => {
    for (const value of ["/opt/elsewhere/tool.js", "C:\\tools\\tool.js"]) {
      await expect(
        performRecipe(recipe({ command: PRINTS_IT, declared: DECLARED }), {
          requirementRegistry: registryDeclaring("node"),
          bindings: { MUSAI_TEST_PATH: { secret: false, value } },
        }),
      ).rejects.toThrow(/MUSAI_TEST_PATH/);
    }
  });

  test("a value that names no path is recorded as it is", async () => {
    const { observation } = await performRecipe(recipe({ command: PRINTS_IT, declared: DECLARED }), {
      requirementRegistry: registryDeclaring("node"),
      bindings: { MUSAI_TEST_PATH: { secret: false, value: "relative/file.js" } },
    });

    expect(observation.bindings[0]!.value).toBe("relative/file.js");
  });
});

describe("performRecipe: a binding table the caller hands over stands in for the workspace's bindings file", () => {
  test("a declared plain name bound from the handed-over table, with no local directory, reaches the child's environment and is recorded as bound", async () => {
    const { observation } = await performRecipe(
      recipe({
        command: ["node", "-e", "process.stdout.write(String(process.env.MUSAI_TEST_HANDED_OVER))"],
        declared: [{ name: "MUSAI_TEST_HANDED_OVER", secret: false }],
      }),
      {
        requirementRegistry: registryDeclaring("node"),
        bindings: { MUSAI_TEST_HANDED_OVER: { secret: false, value: "handed-over-value" } },
      },
    );

    expect(textOf(observation.output, "the probe's output")).toBe("handed-over-value");
    expect(observation.bindings).toEqual([
      {
        name: "MUSAI_TEST_HANDED_OVER",
        secret: false,
        layer: "bindings",
        value: "handed-over-value",
        keyedHash: null,
        keyId: null,
      },
    ]);
  });

  test("a name the recipe declares secret stays secret when the handed-over table flags it plain, and its value is keyed-hashed rather than recorded", async () => {
    await withLocalDir(async (localDir) => {
      const { observation } = await performRecipe(
        recipe({
          command: ["node", "-e", "process.stdout.write(String(process.env.MUSAI_TEST_HANDED_OVER.length))"],
          declared: [{ name: "MUSAI_TEST_HANDED_OVER", secret: true }],
        }),
        {
          localDir,
          requirementRegistry: registryDeclaring("node"),
          bindings: { MUSAI_TEST_HANDED_OVER: { secret: false, value: "handed-over-secret" } },
        },
      );

      expect(textOf(observation.output, "the probe's output")).toBe(String("handed-over-secret".length));
      const expected = secretObservation(
        currentKey(await readKeyFile(localDir)),
        "MUSAI_TEST_HANDED_OVER",
        "handed-over-secret",
      );
      expect(observation.bindings).toEqual([expected]);
      expect(observation.bindings[0]!.value).toBeNull();
      expect(JSON.stringify(observation)).not.toContain("handed-over-secret");
    });
  });
});

describe("performRecipe: the fixed order of refuse, build, spawn, observe", () => {
  test("a recipe that would both fail its argument-list check and fail on an unbound name is refused for whichever condition the fixed order reaches first, spawning no child", async () => {
    await withLocalDir(async (localDir) => {
      const path = join(localDir, "bindings.json");
      await writeFile(path, JSON.stringify({ BOUND_SECRET: { secret: true, value: "leaked-value" } }), { mode: 0o600 });
      await execa("chmod", ["0600", path]);

      const markerPath = join(localDir, "spawned-marker");
      const bad = recipe({
        command: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, '')`, "leaked-value"],
        declared: [
          { name: "BOUND_SECRET", secret: true },
          { name: "NEVER_BOUND", secret: false },
        ],
      });

      await expect(performRecipe(bad, { localDir, requirementRegistry: registryDeclaring("node") })).rejects.toThrow();
      await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("an unbound name is refused before an argument-list check ever runs, since resolution fails first in this kernel's fixed order", async () => {
    await withLocalDir(async (localDir) => {
      const path = join(localDir, "bindings.json");
      await writeFile(path, JSON.stringify({ BOUND_SECRET: { secret: true, value: "leaked-value" } }), { mode: 0o600 });
      await execa("chmod", ["0600", path]);

      const bad = recipe({
        command: ["true", "leaked-value"],
        declared: [
          { name: "BOUND_SECRET", secret: true },
          { name: "NEVER_BOUND", secret: false },
        ],
      });

      await expect(performRecipe(bad, { localDir, requirementRegistry: registryDeclaring("true") })).rejects.toThrow(
        BindingError,
      );
    });
  });
});
