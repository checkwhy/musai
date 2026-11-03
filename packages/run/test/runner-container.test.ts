import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecipe } from "@musai/records";
import { type LocalImage, localImageRunning, processEndedWithin } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  CONTAINER_IMAGE_MEDIA_TYPE,
  CONTAINER_MOUNT_ROOT,
  ContainerUnavailableError,
  containerArgv,
  containerEngineAvailable,
  engineLineOf,
  RECIPE_CHECKOUT_PLACEHOLDER,
} from "../src/container.js";
import type { ScratchPaths } from "../src/hygiene.js";
import { ISOLATION_POLICY_SLOT_ID, performRecipe, RunRefusedError } from "../src/spawn.js";

const RUN_DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const NONEXISTENT_ENGINE = "musai-test-nonexistent-container-engine";
/** Answers `info` with exit 0, so a run passes the engine probe and spawns nothing that reads. */
const ANSWERING_ENGINE = "true";
const PINNED_DIGEST = "7".repeat(64);
const RUN_NAME = "musai-run-example";

function imageRecipe(
  command: readonly string[],
  workingDirectory: string,
  overrides: Partial<RunRecipe> = {},
): RunRecipe {
  return {
    command: [...command],
    workingDirectory,
    environment: {},
    declared: [],
    substrates: [
      { uri: "example/image:latest", digest: { sha256: PINNED_DIGEST }, mediaType: CONTAINER_IMAGE_MEDIA_TYPE },
    ],
    isolation: "container",
    ...overrides,
  };
}

describe("containerEngineAvailable: the engine's own answer to whether it is usable, never a socket path", () => {
  test("a probe against an engine the machine does not have reports unavailable within the bound", async () => {
    const started = Date.now();
    const available = await containerEngineAvailable(NONEXISTENT_ENGINE);
    const elapsed = Date.now() - started;

    expect(available).toBe(false);
    expect(elapsed).toBeLessThan(6000);
  });
});

/** The places on the host an argv names, where a test's recipe stands. */
function onHostAt(tree: string, scratch: ScratchPaths) {
  return { tree, scratch: scratch.root, name: RUN_NAME };
}

describe("containerArgv: a pure function over a recipe, a resolved digest and a scratch", () => {
  let scratch: ScratchPaths | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "musai-container-argv-"));
    scratch = { root };
    cleanup = () => rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await cleanup?.();
  });

  test("holds a resolved digest and not a tag, mounts exactly two paths, and disables networking", () => {
    const recipe = imageRecipe(["python", "-V"], "/checkout", {
      substrates: [{ uri: "example/image:latest", digest: {}, mediaType: CONTAINER_IMAGE_MEDIA_TYPE }],
    });
    const argv = containerArgv(recipe, PINNED_DIGEST, onHostAt("/checkout", scratch!));

    const imageArgument = argv.find((entry) => entry.includes("@sha256:"));
    expect(imageArgument).toBeDefined();
    expect(imageArgument).toContain(PINNED_DIGEST);
    expect(imageArgument).not.toContain(":latest");

    const mountCount = argv.filter((entry) => entry === "-v").length;
    expect(mountCount).toBe(2);
    expect(argv).toContain(`/checkout:${CONTAINER_MOUNT_ROOT}:ro`);
    expect(argv.some((entry) => entry.startsWith(`${scratch!.root}:`) && entry.endsWith(":rw"))).toBe(true);

    const networkIndex = argv.indexOf("--network");
    expect(networkIndex).toBeGreaterThanOrEqual(0);
    expect(argv[networkIndex + 1]).toBe("none");

    expect(argv.slice(argv.indexOf(imageArgument!) + 1)).toEqual(recipe.command.slice(1));
  });

  test("runs the recipe's program as the entrypoint, so an image's own never receives the command", () => {
    const recipe = imageRecipe(["python", "-V"], "/checkout");
    const argv = containerArgv(recipe, PINNED_DIGEST, onHostAt("/checkout", scratch!));
    const image = argv.findIndex((entry) => entry.includes("@sha256:"));

    expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("python");
    expect(argv.indexOf("--entrypoint")).toBeLessThan(image);
    expect(argv.slice(image + 1)).toEqual(["-V"]);
  });

  test("a registry with a port in its address is never mistaken for a tag", () => {
    const recipe = imageRecipe(["true"], "/checkout", {
      substrates: [{ uri: "registry.example:5000/team/image:v2", digest: {}, mediaType: CONTAINER_IMAGE_MEDIA_TYPE }],
    });
    const argv = containerArgv(recipe, PINNED_DIGEST, onHostAt("/checkout", scratch!));
    const imageArgument = argv.find((entry) => entry.includes("@sha256:"))!;

    expect(imageArgument).toBe(`registry.example:5000/team/image@sha256:${PINNED_DIGEST}`);
  });

  test("mounts the host working directory handed in, never the recipe's own relative one", () => {
    const recipe = imageRecipe(["true"], ".");
    const argv = containerArgv(recipe, PINNED_DIGEST, onHostAt("/host/checkout", scratch!));

    expect(argv).toContain(`/host/checkout:${CONTAINER_MOUNT_ROOT}:ro`);
    expect(argv).not.toContain(`.:${CONTAINER_MOUNT_ROOT}:ro`);
  });

  test("keeps home, temp and XDG directories on a tmpfs inside the container, never in the host scratch", () => {
    const recipe = imageRecipe(["true"], "/checkout", { environment: { EXAMPLE_NAME: "example-value" } });
    const argv = containerArgv(recipe, PINNED_DIGEST, onHostAt("/checkout", scratch!));

    expect(argv.filter((_, index) => argv[index - 1] === "-e")).toEqual([
      "HOME=/musai/private/home",
      "TMPDIR=/musai/private/tmp",
      "TEMP=/musai/private/tmp",
      "TMP=/musai/private/tmp",
      "XDG_CONFIG_HOME=/musai/private/xdg-config",
      "XDG_CACHE_HOME=/musai/private/xdg-cache",
      "XDG_DATA_HOME=/musai/private/xdg-data",
      "XDG_STATE_HOME=/musai/private/xdg-state",
      "SSH_AUTH_SOCK=",
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_CONFIG_GLOBAL=/musai/scratch/unwritten-global-config",
      "EXAMPLE_NAME=example-value",
    ]);
    const tmpfs = argv.filter((_, index) => argv[index - 1] === "--tmpfs");
    for (const directory of ["home", "tmp", "xdg-config", "xdg-cache", "xdg-data", "xdg-state"]) {
      expect(tmpfs).toContain(`/musai/private/${directory}:exec,mode=1777`);
    }
  });

  test("hands a declared name to the engine alone, so no bound value rides the engine's argv", () => {
    const recipe = imageRecipe(["true"], "/checkout", {
      environment: { EXAMPLE_NAME: "example-value" },
      declared: [{ name: "TOKEN", secret: true }],
    });
    const argv = containerArgv(recipe, PINNED_DIGEST, onHostAt("/checkout", scratch!));

    expect(argv.filter((_, index) => argv[index - 1] === "-e").slice(-2)).toEqual([
      "EXAMPLE_NAME=example-value",
      "TOKEN",
    ]);
  });

  test("names the recipe's literals in their canonical order, whatever order the caller built them in", () => {
    const literals = (environment: Record<string, string>) => {
      const argv = containerArgv(imageRecipe(["true"], "/", { environment }), PINNED_DIGEST, onHostAt("/", scratch!));
      return argv.filter((_, index) => argv[index - 1] === "-e").slice(-2);
    };

    expect(literals({ ZED: "1", ALPHA: "2" })).toEqual(["ALPHA=2", "ZED=1"]);
    expect(literals({ ALPHA: "2", ZED: "1" })).toEqual(["ALPHA=2", "ZED=1"]);
  });

  test("orders literals by UTF-16 code units, as RFC 8785 orders keys, integer-like or beyond the BMP", () => {
    const environment = { "9": "nine", "10": "ten", "\uFF5E": "tilde", "\u{1F600}": "grin" };
    const argv = containerArgv(imageRecipe(["true"], "/", { environment }), PINNED_DIGEST, onHostAt("/", scratch!));

    expect(argv.filter((_, index) => argv[index - 1] === "-e").slice(-4)).toEqual([
      "10=ten",
      "9=nine",
      "\u{1F600}=grin",
      "\uFF5E=tilde",
    ]);
  });

  test("passes a name declared twice once, as the run's environment holds it once", () => {
    const recipe = imageRecipe(["true"], "/", {
      declared: [
        { name: "TOKEN", secret: true },
        { name: "TOKEN", secret: false },
      ],
    });
    const argv = containerArgv(recipe, PINNED_DIGEST, onHostAt("/", scratch!));

    expect(argv.filter((entry) => entry === "TOKEN")).toHaveLength(1);
  });
});

describe("engineLineOf: the engine line a stranger types to re-run a container recipe by hand", () => {
  test("mounts the checkout a placeholder names, with the recipe's working directory after it, and a fresh scratch", () => {
    const line = engineLineOf(imageRecipe(["true"], "pkg/sub/"), PINNED_DIGEST);

    expect(line[0]).toBe("docker");
    expect(line).toContain(`${RECIPE_CHECKOUT_PLACEHOLDER}/pkg/sub/:${CONTAINER_MOUNT_ROOT}:ro`);
    expect(line).toContain("$(mktemp -d):/musai/scratch:rw");
    expect(engineLineOf(imageRecipe(["true"], "."), PINNED_DIGEST)).toContain(
      `${RECIPE_CHECKOUT_PLACEHOLDER}:${CONTAINER_MOUNT_ROOT}:ro`,
    );
  });

  test("keeps a working directory above the checkout under the placeholder, never cleaned against it", () => {
    expect(engineLineOf(imageRecipe(["true"], "../sibling"), PINNED_DIGEST)).toContain(
      `${RECIPE_CHECKOUT_PLACEHOLDER}/../sibling:${CONTAINER_MOUNT_ROOT}:ro`,
    );
  });

  test("names no container, since a run's name is its own and reaches no receipt", () => {
    expect(engineLineOf(imageRecipe(["true"], "."), PINNED_DIGEST)).not.toContain("--name");
  });

  test("keeps an absolute working directory as the recipe spells it", () => {
    expect(engineLineOf(imageRecipe(["true"], "/srv/app"), PINNED_DIGEST)).toContain(
      `/srv/app:${CONTAINER_MOUNT_ROOT}:ro`,
    );
  });
});

describe("performRecipe: an image branch inside the existing refusal block, before anything spawns", () => {
  const scratchDirs: string[] = [];

  afterEach(async () => {
    for (const dir of scratchDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function scratchFile(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "musai-container-spawn-"));
    scratchDirs.push(dir);
    return join(dir, name);
  }

  test("a recipe declaring container isolation with no image substrate is refused", async () => {
    const recipe: RunRecipe = {
      command: ["true"],
      workingDirectory: "/",
      environment: {},
      declared: [],
      substrates: [],
      isolation: "container",
    };
    await expect(performRecipe(recipe)).rejects.toThrow(RunRefusedError);
  });

  test("a recipe declaring an image, with the refusing policy and no engine available, is refused before spawn naming both the image and the engine, with no child process created", async () => {
    const markerPath = await scratchFile("spawned-marker");
    const recipe = imageRecipe(["node", "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, '')`], "/");

    try {
      await performRecipe(recipe, { containerEngine: NONEXISTENT_ENGINE });
      throw new Error("expected performRecipe to refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerUnavailableError);
      expect((error as Error).message).toContain("example/image:latest");
      expect((error as Error).message).toContain(NONEXISTENT_ENGINE);
    }
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a registry no installed module of which declares it refuses the isolation-policy slot, workspace-incomplete, naming it", async () => {
    const markerPath = await scratchFile("spawned-marker");
    const recipe = imageRecipe(["node", "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, '')`], "/");

    await expect(
      performRecipe(recipe, { containerEngine: NONEXISTENT_ENGINE, slotRegistry: new Map() }),
    ).rejects.toMatchObject({ reason: "workspace-incomplete", code: "workspace", about: [ISOLATION_POLICY_SLOT_ID] });
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("with a permitting policy and no engine available, the run proceeds under hygiene and the receipt's declared and held isolation values differ", async () => {
    const recipe = imageRecipe(["node", "-e", "process.stdout.write('ran under hygiene')"], "/");

    const { recipe: receiptRecipe, observation } = await performRecipe(recipe, {
      containerEngine: NONEXISTENT_ENGINE,
      containerPolicy: "degrade",
    });

    expect(receiptRecipe.isolation).toBe("container");
    expect(observation.isolationHeld).toBe("hygiene");
    expect(observation.isolationHeld).not.toBe(receiptRecipe.isolation);
    expect(observation.output).toBe("ran under hygiene");
  });

  test("a recipe declaring an image and a name its engine's own client reads is refused before anything spawns", async () => {
    const markerPath = await scratchFile("spawned-marker");
    const command = ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, '')`];
    for (const name of ["DOCKER_HOST", "CONTAINER_HOST", "LD_PRELOAD"]) {
      const recipe = imageRecipe(command, "/", { declared: [{ name, secret: false }] });
      const refused = performRecipe(recipe, {
        containerEngine: NONEXISTENT_ENGINE,
        bindings: { [name]: { secret: false, value: "unix:///elsewhere.sock" } },
      });
      await expect(refused).rejects.toBeInstanceOf(RunRefusedError);
      await expect(refused).rejects.toThrow(name);
    }
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a host run binds a name an engine's client reads as it binds any other", async () => {
    const recipe: RunRecipe = {
      command: ["node", "-e", "process.stdout.write(process.env.DOCKER_HOST)"],
      workingDirectory: "/",
      environment: {},
      declared: [{ name: "DOCKER_HOST", secret: false }],
      substrates: [],
      isolation: "hygiene",
    };
    const { observation } = await performRecipe(recipe, {
      bindings: { DOCKER_HOST: { secret: false, value: "unix:///elsewhere.sock" } },
    });

    expect([observation.exitCode, observation.output]).toEqual([0, "unix:///elsewhere.sock"]);
  });

  test("a declared-image run names no host binary, and names the image it ran in by its digest", async () => {
    const { observation } = await performRecipe(imageRecipe(["node", "--version"], "/", { tooling: ["git"] }), {
      containerEngine: ANSWERING_ENGINE,
    });

    expect(observation.isolationHeld).toBe("container");
    expect(observation.binaries).toEqual([]);
    expect(observation.resolved).toContainEqual(expect.objectContaining({ digest: { sha256: PINNED_DIGEST } }));
  });

  test("a declared-image run of a program only the image holds is performed, never refused for the host's lack", async () => {
    const { observation } = await performRecipe(imageRecipe(["musai-test-program-only-in-image"], "/"), {
      containerEngine: ANSWERING_ENGINE,
    });

    expect([observation.isolationHeld, observation.exitCode]).toEqual(["container", 0]);
  });

  test("a declared-image run degraded to the host names the host's copy of its program, which is what ran", async () => {
    const { observation } = await performRecipe(imageRecipe(["node", "-e", ""], "/"), {
      containerEngine: NONEXISTENT_ENGINE,
      containerPolicy: "degrade",
    });

    expect(observation.binaries.map((binary) => binary.name)).toEqual(["node"]);
  });

  test("a receipt never claims a containment it did not get: the held level is never stronger than what the policy and the engine actually allowed", async () => {
    const recipe = imageRecipe(["true"], "/");
    const { observation } = await performRecipe(recipe, {
      containerEngine: NONEXISTENT_ENGINE,
      containerPolicy: "degrade",
    });
    expect(observation.isolationHeld).not.toBe("container");
  });
});

/** What a logging engine does with `run`: exit at once, hang past SIGTERM until a `kill` ends it,
 * or hand it to docker. */
type RunBehaviour = "exits" | "hangs" | "delegates";

const RUN_BEHAVIOURS: Record<RunBehaviour, string> = {
  exits: "",
  hangs: [
    'if (argv[0] === "run") {',
    "  fs.writeFileSync(pidFile, String(process.pid));",
    '  process.on("SIGTERM", () => {});',
    "  setInterval(() => {}, 1000);",
    "}",
    'if (argv[0] === "kill") process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");',
  ].join("\n"),
  delegates: 'process.exit(require("node:child_process").spawnSync("docker", argv, { stdio: "inherit" }).status ?? 1);',
};

/** A name a run binds, which an engine logs as it saw it. */
const BOUND_NAME = "MUSAI_TEST_BOUND";

interface EngineCall {
  readonly argv: string[];
  readonly bound: string | null;
}

/** An engine that logs each argv it is given, and the bound name as it saw it, before it acts. */
async function loggingEngine(
  dir: string,
  behaviour: RunBehaviour,
): Promise<{
  engine: string;
  calls: () => Promise<EngineCall[]>;
  argvs: () => Promise<string[][]>;
  runPid: () => Promise<number>;
}> {
  const log = join(dir, "argv.log");
  const pidFile = join(dir, "run.pid");
  const engine = join(dir, "engine.cjs");
  await writeFile(
    engine,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `const pidFile = ${JSON.stringify(pidFile)};`,
      "const argv = process.argv.slice(2);",
      `const bound = process.env[${JSON.stringify(BOUND_NAME)}] ?? null;`,
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, bound }) + "\\n");`,
      RUN_BEHAVIOURS[behaviour],
    ].join("\n"),
    { mode: 0o755 },
  );
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as EngineCall);
  const argvs = async () => (await calls()).map((call) => call.argv);
  const runPid = async () => Number(await readFile(pidFile, "utf8"));
  return { engine, calls, argvs, runPid };
}

/** A caller importing the built kernel and probing its engine before the run it starts. */
const RUN_START_BUDGET_MS = 20_000;

/** A killed process is reaped by whichever parent it has left. */
const PROCESS_END_BUDGET_MS = 5000;

function nameOf(runArgv: readonly string[]): string {
  return runArgv[runArgv.indexOf("--name") + 1]!;
}

// The engine stands in as a `#!` script, which Windows does not execute.
describe.skipIf(process.platform === "win32")(
  "a container run ended early ends its container, not only the engine's client",
  () => {
    const dirs: string[] = [];

    afterEach(async () => {
      for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
      }
    });

    async function engineDir(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "musai-container-deadline-"));
      dirs.push(dir);
      return dir;
    }

    test("a deadline kills and removes the container by the name its run gave it", async () => {
      const { engine, argvs, runPid } = await loggingEngine(await engineDir(), "hangs");

      const { timedOut } = await performRecipe(imageRecipe(["sleep", "300"], "/"), {
        containerEngine: engine,
        timeoutMs: 1000,
      });

      expect(timedOut).toBe(true);
      const [run, ...after] = (await argvs()).filter((argv) => argv[0] !== "info");
      expect(run![0]).toBe("run");
      expect(nameOf(run!)).toMatch(/^musai-run-/);
      expect(after).toEqual([
        ["kill", nameOf(run!)],
        ["rm", "-f", nameOf(run!)],
      ]);
      expect(await processEndedWithin(await runPid(), PROCESS_END_BUDGET_MS)).toBe(true);
    });

    test("the engine that ends a container is reached with the run's own environment", async () => {
      const { engine, calls } = await loggingEngine(await engineDir(), "hangs");

      await performRecipe(imageRecipe(["sleep", "300"], "/", { declared: [{ name: BOUND_NAME, secret: false }] }), {
        containerEngine: engine,
        bindings: { [BOUND_NAME]: { secret: false, value: "bound-value" } },
        timeoutMs: 1000,
      });

      const seen = (await calls()).filter((call) => call.argv[0] !== "info");
      expect(seen.map((call) => [call.argv[0], call.bound])).toEqual([
        ["run", "bound-value"],
        ["kill", "bound-value"],
        ["rm", "bound-value"],
      ]);
    });

    test("an interrupted caller kills its run's container by name, reaching the engine as its run did", async () => {
      const { engine, calls, runPid } = await loggingEngine(await engineDir(), "hangs");
      const recipe = JSON.stringify(
        imageRecipe(["sleep", "300"], "/", { declared: [{ name: BOUND_NAME, secret: false }] }),
      );
      const options = JSON.stringify({
        containerEngine: engine,
        bindings: { [BOUND_NAME]: { secret: false, value: "bound-value" } },
      });
      const caller = execa(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { performRecipe } from ${JSON.stringify(RUN_DIST)}; await performRecipe(${recipe}, ${options});`,
        ],
        { reject: false },
      );
      const until = Date.now() + RUN_START_BUDGET_MS;
      while (!(await calls()).some((call) => call.argv[0] === "run")) {
        if (Date.now() > until) {
          caller.kill("SIGKILL");
          throw new Error(`the caller never started its run: ${(await caller).stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      caller.kill("SIGINT");

      expect((await caller).signal).toBe("SIGINT");
      const [run, ...after] = (await calls()).filter((call) => call.argv[0] !== "info");
      expect(after).toEqual([{ argv: ["kill", nameOf(run!.argv)], bound: "bound-value" }]);
      expect(await processEndedWithin(await runPid(), PROCESS_END_BUDGET_MS)).toBe(true);
    });

    test("a run that meets no deadline sends its engine nothing after the run", async () => {
      const { engine, argvs } = await loggingEngine(await engineDir(), "exits");

      const { timedOut } = await performRecipe(imageRecipe(["true"], "/"), {
        containerEngine: engine,
        timeoutMs: 10_000,
      });

      expect(timedOut).toBe(false);
      expect((await argvs()).filter((argv) => argv[0] !== "info").map((argv) => argv[0])).toEqual(["run"]);
    });

    test("two runs at once name two different containers", async () => {
      const { engine, argvs } = await loggingEngine(await engineDir(), "exits");

      await Promise.all([
        performRecipe(imageRecipe(["true"], "/"), { containerEngine: engine }),
        performRecipe(imageRecipe(["true"], "/"), { containerEngine: engine }),
      ]);

      const names = (await argvs()).filter((argv) => argv[0] === "run").map(nameOf);
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);
    });
  },
);

// The engine stands in as a `#!` script, which Windows does not execute.
describe.skipIf(process.platform === "win32")("the engine line a stranger types beside the run it took", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("engineLineOf equals the argv a live run took, placeholders aside, and holds no bound value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "musai-container-line-"));
    dirs.push(dir);
    const { engine, argvs } = await loggingEngine(dir, "exits");
    const checkout = join(dir, "checkout");
    await mkdir(join(checkout, "pkg"), { recursive: true });
    await mkdir(join(dir, "local"));
    const recipe = imageRecipe(["sh", "-c", 'echo "$HOME" && ls'], "pkg", {
      environment: { ZED: "last", ALPHA: "a value" },
      declared: [{ name: BOUND_NAME, secret: true }],
    });

    await performRecipe(recipe, {
      containerEngine: engine,
      workingRoot: checkout,
      localDir: join(dir, "local"),
      bindings: { [BOUND_NAME]: { secret: true, value: "bound-secret-value" } },
    });

    const run = (await argvs()).find((argv) => argv[0] === "run")!;
    const scratchRoot = run[run.findIndex((entry) => entry.endsWith(":/musai/scratch:rw"))]!.split(":")[0]!;
    const named = run.indexOf("--name");
    const asStranger = [...run.slice(0, named), ...run.slice(named + 2)].map((entry) =>
      entry.replace(join(checkout, "pkg"), `${RECIPE_CHECKOUT_PLACEHOLDER}/pkg`).replace(scratchRoot, "$(mktemp -d)"),
    );
    const line = engineLineOf(recipe, PINNED_DIGEST);
    expect(line).toEqual(["docker", ...asStranger]);
    expect(line).toContain(BOUND_NAME);
    expect(line.join(" ")).not.toContain("bound-secret-value");
  });
});

describe("the container path is reached only from the spawn path", () => {
  test("performRecipe is the one caller building an image branch's argument array", async () => {
    const source = await readFile(new URL("../src/spawn.ts", import.meta.url), "utf8");
    expect((source.match(/containerArgv/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

/** Starting even a cached image costs seconds on a shared runner. */
const CONTAINER_RUN_BUDGET_MS = 60_000;

const CONTAINER_DEADLINE_MS = 2000;

/** The spawn path's five-second grace before it kills, and the engine's own kill and removal. */
const DEADLINE_GRACE_AND_KILL_MS = 10_000;

/** A container run of `command` in `image`, standing in `workingDirectory` on the host. */
function localImageRecipe(image: LocalImage, command: readonly string[], workingDirectory: string): RunRecipe {
  return {
    command: [...command],
    workingDirectory,
    environment: {},
    declared: [],
    substrates: [
      { uri: `${image.repository}:probe`, digest: { sha256: image.digest }, mediaType: CONTAINER_IMAGE_MEDIA_TYPE },
    ],
    isolation: "container",
  };
}

/** The `PATH` the image's own configuration sets. */
async function imagePath(image: LocalImage): Promise<string> {
  const inspected = await execa("docker", [
    "inspect",
    "--format",
    "{{json .Config.Env}}",
    `${image.repository}@sha256:${image.digest}`,
  ]);
  const path = (JSON.parse(inspected.stdout) as string[]).find((entry) => entry.startsWith("PATH="));
  return path!.slice("PATH=".length);
}

describe("a container run in a locally held image, guarded on engine availability", () => {
  let engineAvailable = false;
  let catting: LocalImage | undefined;
  let shelled: LocalImage | undefined;
  let sleeping: LocalImage | undefined;

  beforeAll(async () => {
    engineAvailable = await containerEngineAvailable("docker");
    if (engineAvailable) {
      catting = await localImageRunning(["cat", "/dev/null"]);
      shelled = await localImageRunning(["sh", "-c", "command -v node && command -v touch"]);
      sleeping = await localImageRunning(["sleep", "0"]);
    }
  }, CONTAINER_RUN_BUDGET_MS);

  function skipWithout(image: LocalImage | undefined, context: { skip: () => void }): image is undefined {
    if (!engineAvailable) {
      console.log("skip: no container engine is available on this machine");
      context.skip();
      return true;
    }
    if (image === undefined) {
      console.log("skip: no locally held image runs the command this test needs");
      context.skip();
      return true;
    }
    return false;
  }

  test(
    "a declared image actually runs inside the engine and the receipt records held containment",
    async (context) => {
      if (skipWithout(catting, context)) {
        return;
      }
      const scratchDir = await mkdtemp(join(tmpdir(), "musai-container-e2e-"));
      try {
        const checkoutDir = join(scratchDir, "checkout");
        await mkdir(checkoutDir, { recursive: true });
        await writeFile(join(checkoutDir, "marker.txt"), "mounted read-only");

        const recipe = localImageRecipe(catting!, ["cat", `${CONTAINER_MOUNT_ROOT}/marker.txt`], checkoutDir);
        const { observation } = await performRecipe(recipe);
        expect(observation.isolationHeld).toBe("container");
        expect(observation.output).toContain("mounted read-only");
        expect(observation.binaries).toEqual([]);
        expect(observation.resolved).toContainEqual(expect.objectContaining({ digest: { sha256: catting!.digest } }));
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    },
    CONTAINER_RUN_BUDGET_MS,
  );

  test(
    "the image's own PATH is the one in effect, and HOME and TMPDIR are writable on the container's own tmpfs",
    async (context) => {
      if (skipWithout(shelled, context)) {
        return;
      }
      const script = 'printf "%s\\n" "$HOME" "$TMPDIR" "$PATH" && touch "$HOME/h" "$TMPDIR/t"';
      const { observation } = await performRecipe(localImageRecipe(shelled!, ["sh", "-c", script], tmpdir()));

      expect(observation.exitCode).toBe(0);
      const [home, temporary, path] = String(observation.output).trim().split("\n");
      expect(home).toBe("/musai/private/home");
      expect(temporary).toBe("/musai/private/tmp");
      expect(path).toBe(await imagePath(shelled!));
    },
    CONTAINER_RUN_BUDGET_MS,
  );

  test(
    "a program the image keeps on its own PATH runs, wherever the host keeps its own",
    async (context) => {
      if (skipWithout(shelled, context)) {
        return;
      }
      const { observation } = await performRecipe(
        localImageRecipe(shelled!, ["node", "-e", "process.stdout.write(process.env.HOME)"], tmpdir()),
      );

      expect([observation.exitCode, observation.output]).toEqual([0, "/musai/private/home"]);
    },
    CONTAINER_RUN_BUDGET_MS,
  );

  test(
    "a program the run writes under its home or its temp can be executed there",
    async (context) => {
      if (skipWithout(shelled, context)) {
        return;
      }
      const script = [
        'for d in "$TMPDIR" "$HOME"; do',
        'printf "#!/bin/sh\\nexit 0\\n" > "$d/run.sh" && chmod +x "$d/run.sh" && "$d/run.sh" || exit $?;',
        "done",
      ].join(" ");
      const { observation } = await performRecipe(localImageRecipe(shelled!, ["sh", "-c", script], tmpdir()));

      expect([observation.exitCode, observation.output]).toEqual([0, ""]);
    },
    CONTAINER_RUN_BUDGET_MS,
  );

  // Root reads past any file mode, so only an author who is not root meets what root left.
  test.skipIf(process.getuid?.() === 0)(
    "a root image writing nested directories under its home and temp leaves its author a scratch to remove",
    async (context) => {
      if (skipWithout(shelled, context)) {
        return;
      }
      const script = 'mkdir -p "$HOME/.cache/a/b" "$TMPDIR/x/y" && touch "$HOME/.cache/a/b/f" "$TMPDIR/x/y/f" && id -u';
      const { observation } = await performRecipe(localImageRecipe(shelled!, ["sh", "-c", script], tmpdir()));

      expect([observation.exitCode, String(observation.output).trim()]).toEqual([0, "0"]);
    },
    CONTAINER_RUN_BUDGET_MS,
  );

  test(
    "a container whose PID 1 ignores SIGTERM is no longer running once its deadline's run returns",
    async (context) => {
      if (skipWithout(sleeping, context)) {
        return;
      }
      const dir = await mkdtemp(join(tmpdir(), "musai-container-deadline-"));
      const { engine, argvs } = await loggingEngine(dir, "delegates");
      try {
        const started = Date.now();
        const { timedOut } = await performRecipe(localImageRecipe(sleeping!, ["sleep", "300"], tmpdir()), {
          containerEngine: engine,
          timeoutMs: CONTAINER_DEADLINE_MS,
        });
        const elapsed = Date.now() - started;

        expect(timedOut).toBe(true);
        expect(elapsed).toBeLessThan(CONTAINER_DEADLINE_MS + DEADLINE_GRACE_AND_KILL_MS);
        const run = (await argvs()).find((argv) => argv[0] === "run")!;
        const inspected = await execa("docker", ["inspect", "--format", "{{.State.Running}}", nameOf(run)], {
          reject: false,
        });
        expect(inspected.exitCode !== 0 || inspected.stdout.trim() === "false").toBe(true);
      } finally {
        const run = (await argvs()).find((argv) => argv[0] === "run");
        if (run !== undefined) {
          await execa("docker", ["rm", "-f", nameOf(run)], { reject: false });
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
    CONTAINER_RUN_BUDGET_MS,
  );

  test(
    "a declared secret reaches the run through the engine's environment, and never its argv",
    async (context) => {
      if (skipWithout(shelled, context)) {
        return;
      }
      const dir = await mkdtemp(join(tmpdir(), "musai-container-engine-"));
      try {
        const { engine, argvs } = await loggingEngine(dir, "delegates");
        const value = "container-secret-4f1d9b";
        const recipe: RunRecipe = {
          ...localImageRecipe(shelled!, ["sh", "-c", 'printf %s "$TOKEN" | cut -c11-'], tmpdir()),
          declared: [{ name: "TOKEN", secret: true }],
        };
        const { observation } = await performRecipe(recipe, {
          containerEngine: engine,
          bindings: { TOKEN: { secret: true, value } },
          localDir: dir,
        });

        expect([observation.exitCode, String(observation.output).trim()]).toEqual([0, "secret-4f1d9b"]);
        const logged = JSON.stringify(await argvs());
        expect(logged).toContain('"TOKEN"');
        expect(logged).not.toContain(value);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CONTAINER_RUN_BUDGET_MS,
  );
});
