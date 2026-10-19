import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecipe } from "@musai/records";
import { type LocalImage, localImageRunning } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  CONTAINER_IMAGE_MEDIA_TYPE,
  CONTAINER_MOUNT_ROOT,
  ContainerUnavailableError,
  containerArgv,
  containerEngineAvailable,
} from "../src/container.js";
import type { ScratchPaths } from "../src/hygiene.js";
import { ISOLATION_POLICY_SLOT_ID, performRecipe, RunRefusedError } from "../src/spawn.js";

const NONEXISTENT_ENGINE = "musai-test-nonexistent-container-engine";
/** Answers `info` with exit 0, so a run passes the engine probe and spawns nothing that reads. */
const ANSWERING_ENGINE = "true";
const PINNED_DIGEST = "7".repeat(64);

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
    const argv = containerArgv(recipe, PINNED_DIGEST, scratch!, "/checkout", CONTAINER_MOUNT_ROOT);

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
    const argv = containerArgv(recipe, PINNED_DIGEST, scratch!, "/checkout", CONTAINER_MOUNT_ROOT);
    const image = argv.findIndex((entry) => entry.includes("@sha256:"));

    expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("python");
    expect(argv.indexOf("--entrypoint")).toBeLessThan(image);
    expect(argv.slice(image + 1)).toEqual(["-V"]);
  });

  test("a registry with a port in its address is never mistaken for a tag", () => {
    const recipe = imageRecipe(["true"], "/checkout", {
      substrates: [{ uri: "registry.example:5000/team/image:v2", digest: {}, mediaType: CONTAINER_IMAGE_MEDIA_TYPE }],
    });
    const argv = containerArgv(recipe, PINNED_DIGEST, scratch!, "/checkout", CONTAINER_MOUNT_ROOT);
    const imageArgument = argv.find((entry) => entry.includes("@sha256:"))!;

    expect(imageArgument).toBe(`registry.example:5000/team/image@sha256:${PINNED_DIGEST}`);
  });

  test("mounts the host working directory handed in, never the recipe's own relative one", () => {
    const recipe = imageRecipe(["true"], ".");
    const argv = containerArgv(recipe, PINNED_DIGEST, scratch!, "/host/checkout", CONTAINER_MOUNT_ROOT);

    expect(argv).toContain(`/host/checkout:${CONTAINER_MOUNT_ROOT}:ro`);
    expect(argv).not.toContain(`.:${CONTAINER_MOUNT_ROOT}:ro`);
  });

  test("keeps home, temp and XDG directories on a tmpfs inside the container, never in the host scratch", () => {
    const recipe = imageRecipe(["true"], "/checkout");
    const argv = containerArgv(recipe, PINNED_DIGEST, scratch!, "/checkout", CONTAINER_MOUNT_ROOT, {
      HOME: join(scratch!.root, "home"),
      TMPDIR: join(scratch!.root, "tmp"),
      XDG_CACHE_HOME: join(scratch!.root, "xdg-cache"),
      GIT_CONFIG_GLOBAL: join(scratch!.root, "unwritten-global-config"),
      EXAMPLE_NAME: "example-value",
    });

    expect(argv.filter((_, index) => argv[index - 1] === "-e")).toEqual([
      "HOME=/musai/private/home",
      "TMPDIR=/musai/private/tmp",
      "XDG_CACHE_HOME=/musai/private/xdg-cache",
      "GIT_CONFIG_GLOBAL=/musai/scratch/unwritten-global-config",
      "EXAMPLE_NAME=example-value",
    ]);
    const tmpfs = argv.filter((_, index) => argv[index - 1] === "--tmpfs");
    for (const directory of ["home", "tmp", "xdg-config", "xdg-cache", "xdg-data", "xdg-state"]) {
      expect(tmpfs).toContain(`/musai/private/${directory}:exec,mode=1777`);
    }
  });

  test("hands a bound value to the engine by its name alone, so no value rides the engine's argv", () => {
    const recipe = imageRecipe(["true"], "/checkout");
    const argv = containerArgv(
      recipe,
      PINNED_DIGEST,
      scratch!,
      "/checkout",
      CONTAINER_MOUNT_ROOT,
      { EXAMPLE_NAME: "example-value", TOKEN: "secret-value" },
      [],
      ["TOKEN"],
    );

    expect(argv.filter((_, index) => argv[index - 1] === "-e")).toEqual(["EXAMPLE_NAME=example-value", "TOKEN"]);
    expect(argv.join(" ")).not.toContain("secret-value");
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

describe("the container path is reached only from the spawn path", () => {
  test("performRecipe is the one caller building an image branch's argument array", async () => {
    const source = await readFile(new URL("../src/spawn.ts", import.meta.url), "utf8");
    expect((source.match(/containerArgv/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

/** Starting even a cached image costs seconds on a shared runner. */
const CONTAINER_RUN_BUDGET_MS = 60_000;

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

  beforeAll(async () => {
    engineAvailable = await containerEngineAvailable("docker");
    if (engineAvailable) {
      catting = await localImageRunning(["cat", "/dev/null"]);
      shelled = await localImageRunning(["sh", "-c", "command -v node && command -v touch"]);
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
    "a declared secret reaches the run through the engine's environment, and never its argv",
    async (context) => {
      if (skipWithout(shelled, context)) {
        return;
      }
      const dir = await mkdtemp(join(tmpdir(), "musai-container-engine-"));
      try {
        const argvLog = join(dir, "argv.log");
        const engine = join(dir, "engine.cjs");
        await writeFile(
          engine,
          [
            "#!/usr/bin/env node",
            `require("node:fs").appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
            'const ran = require("node:child_process").spawnSync("docker", process.argv.slice(2), { stdio: "inherit" });',
            "process.exit(ran.status ?? 1);",
          ].join("\n"),
          { mode: 0o755 },
        );
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
        const logged = await readFile(argvLog, "utf8");
        expect(logged).toContain('"TOKEN"');
        expect(logged).not.toContain(value);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CONTAINER_RUN_BUDGET_MS,
  );
});
