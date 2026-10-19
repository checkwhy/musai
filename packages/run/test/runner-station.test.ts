import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { type Audience, type RunRecipe, recordId } from "@musai/records";
import { afterEach, describe, expect, test } from "vitest";
import { CONTAINER_IMAGE_MEDIA_TYPE, CONTAINER_MOUNT_ROOT, containerArgv } from "../src/container.js";
import { performRecipe, RunRefusedError, refuseStationRun } from "../src/spawn.js";
import {
  STATION_IMAGE_CONFIG_KEY,
  type Station,
  StationRefusedError,
  stationImageFromConfig,
  stationRecipe,
} from "../src/station.js";
import { pathWithin, relativeWithin, TREE_SUBSTRATE_URI } from "../src/substrate.js";

const CLEARANCE = "writer" as Audience;
const NONEXISTENT_ENGINE = "musai-test-nonexistent-container-engine";
/** Answers `info` with exit 0, so a run passes the engine probe and spawns nothing that reads. */
const ANSWERING_ENGINE = "true";
const STATION_DIGEST = "5".repeat(64);
const DECLARED_DIGEST = "7".repeat(64);
const STATION_IMAGE = {
  uri: "registry.example/station",
  digest: { sha256: STATION_DIGEST },
  mediaType: CONTAINER_IMAGE_MEDIA_TYPE,
};

function hostRecipe(overrides: Partial<RunRecipe> = {}): RunRecipe {
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

function station(musaiDir: string): Station {
  return { clearance: CLEARANCE, image: STATION_IMAGE, musaiDir };
}

function imagelessStation(musaiDir: string): Station {
  return { clearance: CLEARANCE, image: undefined, musaiDir };
}

const scratchDirs: string[] = [];

afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "musai-station-"));
  scratchDirs.push(dir);
  return dir;
}

/** A command that leaves a file behind if it ever runs on the host. */
function markingRecipe(marker: string): RunRecipe {
  return hostRecipe({ command: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`] });
}

describe("a station's container argument array", () => {
  const scratch = { root: "/host/scratch" };
  const declared = hostRecipe({
    command: ["find", "."],
    substrates: [{ uri: "example/image:latest", digest: {}, mediaType: CONTAINER_IMAGE_MEDIA_TYPE }],
    isolation: "container",
  });

  test("masks each named directory of the tree with an empty read-only mount, networking still off", () => {
    const argv = containerArgv(declared, DECLARED_DIGEST, scratch, "/host/tree", CONTAINER_MOUNT_ROOT, {}, [".musai"]);

    const mask = argv.indexOf("--mount");
    expect(argv[mask + 1]).toBe(`type=tmpfs,destination=${CONTAINER_MOUNT_ROOT}/.musai,readonly`);
    expect(argv.indexOf(`/host/tree:${CONTAINER_MOUNT_ROOT}:ro`)).toBeLessThan(mask);
    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
  });

  test("with nothing masked it is the author's, byte for byte", () => {
    expect(containerArgv(declared, DECLARED_DIGEST, scratch, "/host/tree", CONTAINER_MOUNT_ROOT, { A: "b" })).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `/host/tree:${CONTAINER_MOUNT_ROOT}:ro`,
      "-v",
      "/host/scratch:/musai/scratch:rw",
      "--tmpfs",
      "/musai/private/home:exec,mode=1777",
      "--tmpfs",
      "/musai/private/tmp:exec,mode=1777",
      "--tmpfs",
      "/musai/private/xdg-config:exec,mode=1777",
      "--tmpfs",
      "/musai/private/xdg-cache:exec,mode=1777",
      "--tmpfs",
      "/musai/private/xdg-data:exec,mode=1777",
      "--tmpfs",
      "/musai/private/xdg-state:exec,mode=1777",
      "-w",
      CONTAINER_MOUNT_ROOT,
      "-e",
      "A=b",
      "--entrypoint",
      "find",
      `example/image@sha256:${DECLARED_DIGEST}`,
      ".",
    ]);
  });
});

describe("the station image the trust branch's configuration names", () => {
  test("is an image substrate pinned by the digest it names", () => {
    const named = stationImageFromConfig({
      values: { [STATION_IMAGE_CONFIG_KEY]: `registry.example/station@sha256:${STATION_DIGEST}` },
    });
    expect(named).toEqual(STATION_IMAGE);
  });

  test("is none where the configuration names none", () => {
    expect(stationImageFromConfig({ values: {} })).toBeUndefined();
  });

  test("named by a moving tag rather than a digest is refused, naming the key", () => {
    expect(() =>
      stationImageFromConfig({ values: { [STATION_IMAGE_CONFIG_KEY]: "registry.example/station:latest" } }),
    ).toThrow(expect.objectContaining({ reason: "workspace-incomplete", about: [STATION_IMAGE_CONFIG_KEY] }));
  });
});

describe("the recipe a station runs", () => {
  test("declaring no image, takes the station's into its recipe, so its id is never the host run's", () => {
    const host = hostRecipe({ substrates: [{ name: "tree", uri: "tree:" }] });
    const held = stationRecipe(host, station("/workspace/.musai"));

    expect(held.substrates).toEqual([...host.substrates, STATION_IMAGE]);
    expect(held.isolation).toBe("container");
    expect(recordId(held)).not.toBe(recordId(host));
  });

  test("declaring its own image keeps it, unchanged", () => {
    const declared = hostRecipe({
      substrates: [
        { uri: "example/image", digest: { sha256: DECLARED_DIGEST }, mediaType: CONTAINER_IMAGE_MEDIA_TYPE },
      ],
    });
    expect(stationRecipe(declared, station("/workspace/.musai"))).toBe(declared);
  });

  test("declaring no image is refused where the station names none, naming the clearance", () => {
    expect(() => stationRecipe(hostRecipe(), imagelessStation("/workspace/.musai"))).toThrow(
      expect.objectContaining({ reason: "invalid-input", about: [CLEARANCE] }),
    );
  });
});

describe("a run performed for a station", () => {
  test("is refused before anything spawns where no engine answers, whatever the cannot-hold policy", async () => {
    const dir = await scratchDir();
    const marker = join(dir, "spawned");

    await expect(
      performRecipe(markingRecipe(marker), {
        station: station(join(dir, ".musai")),
        containerEngine: NONEXISTENT_ENGINE,
        containerPolicy: "degrade",
      }),
    ).rejects.toThrow(StationRefusedError);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("is refused before anything spawns where the recipe declares no image and the station names none", async () => {
    const dir = await scratchDir();
    const marker = join(dir, "spawned");

    await expect(
      performRecipe(markingRecipe(marker), {
        station: imagelessStation(join(dir, ".musai")),
        containerEngine: ANSWERING_ENGINE,
      }),
    ).rejects.toMatchObject({ reason: "invalid-input", about: [CLEARANCE] });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("standing inside the workspace's own directory is refused, since its mount would show it", async () => {
    const dir = await scratchDir();
    const local = join(dir, ".musai", "local");
    await mkdir(local, { recursive: true });

    await expect(
      performRecipe(hostRecipe({ workingDirectory: local }), {
        station: station(join(dir, ".musai")),
        containerEngine: ANSWERING_ENGINE,
      }),
    ).rejects.toMatchObject({ reason: "invalid-input", about: [CLEARANCE] });
  });

  test("standing outside the project is refused, since its mount would show the host", async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, ".musai"));

    await expect(
      performRecipe(hostRecipe({ workingDirectory: "/" }), {
        station: station(join(dir, ".musai")),
        containerEngine: ANSWERING_ENGINE,
      }),
    ).rejects.toMatchObject({ reason: "invalid-input", about: [CLEARANCE] });
  });

  test("a directory whose name begins with two dots, inside the workspace's own, is inside it", async () => {
    const dir = await scratchDir();
    const dotted = join(dir, ".musai", "..x");
    await mkdir(dotted, { recursive: true });

    await expect(
      performRecipe(hostRecipe({ workingDirectory: dotted }), {
        station: station(join(dir, ".musai")),
        containerEngine: ANSWERING_ENGINE,
      }),
    ).rejects.toMatchObject({ reason: "invalid-input", about: [CLEARANCE] });
  });

  test("records the container it was held to, with the station's image in its recipe", async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, ".musai"));

    const { recipe, observation } = await performRecipe(hostRecipe({ workingDirectory: dir }), {
      station: station(join(dir, ".musai")),
      containerEngine: ANSWERING_ENGINE,
    });

    expect(recipe.substrates).toEqual([STATION_IMAGE]);
    expect([recipe.isolation, observation.isolationHeld]).toEqual(["container", "container"]);
  });

  test("names no host binary, and names the station's image it ran in by its digest", async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, ".musai"));

    const { observation } = await performRecipe(hostRecipe({ workingDirectory: dir }), {
      station: station(join(dir, ".musai")),
      containerEngine: ANSWERING_ENGINE,
    });

    expect(observation.binaries).toEqual([]);
    expect(observation.resolved).toContainEqual(expect.objectContaining({ digest: { sha256: STATION_DIGEST } }));
  });
});

describe("a station's preflight of a recipe", () => {
  const TREE = { name: "tree", uri: TREE_SUBSTRATE_URI };

  // A station's recipe always names an image, and a rootless relative directory is never mounted.
  test.each([
    ["a working directory leaving its checkout", hostRecipe({ substrates: [TREE], workingDirectory: "../outside" })],
    ["an engine client name declared", hostRecipe({ declared: [{ name: "DOCKER_HOST", secret: false }] })],
  ])("leaves %s to the spawn's own refusal, which comes first", async (_, recipe) => {
    const dir = await scratchDir();
    await mkdir(join(dir, ".musai"));
    const options = { station: station(join(dir, ".musai")), containerEngine: ANSWERING_ENGINE };

    await expect(refuseStationRun(recipe, { ...options, workingRoot: dir })).resolves.toBeUndefined();
    await expect(performRecipe(recipe, { ...options, workingRoot: dir })).rejects.toThrow(RunRefusedError);
  });

  test("refuses a working directory outside the project when nothing in the recipe is refused earlier", async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, ".musai"));

    await expect(
      refuseStationRun(hostRecipe({ workingDirectory: "/" }), {
        station: station(join(dir, ".musai")),
        containerEngine: ANSWERING_ENGINE,
      }),
    ).rejects.toThrow(StationRefusedError);
  });
});

describe("whether one path lies within another", () => {
  test("a name beginning with two dots is inside, and a parent's sibling is outside", async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, "tree", "..data"), { recursive: true });

    expect(await pathWithin(join(dir, "tree"), join(dir, "tree", "..data"))).toBe("..data");
    expect(await pathWithin(join(dir, "tree"), join(dir, "other"))).toBeNull();
    expect(await pathWithin(join(dir, "tree", "..data"), join(dir, "tree"))).toBeNull();
    expect(await pathWithin(join(dir, "tree"), join(dir, "tree"))).toBe("");
  });

  test.skipIf(process.platform === "win32")("a symlink inside that points outside is outside", async () => {
    const dir = await scratchDir();
    await mkdir(join(dir, "tree"), { recursive: true });
    await mkdir(join(dir, "outside"));
    await symlink(join(dir, "outside"), join(dir, "tree", "escape"));

    expect(await pathWithin(join(dir, "tree"), join(dir, "tree", "escape"))).toBeNull();
  });

  test("under Windows' rules another drive is outside, and a path inside reads with forward slashes", () => {
    expect(relativeWithin("C:\\project", "D:\\project", win32)).toBeNull();
    expect(relativeWithin("C:\\project\\src", "C:\\project", win32)).toBeNull();
    expect(relativeWithin("C:\\project", "C:\\project\\src\\lib", win32)).toBe("src/lib");
    expect(relativeWithin("C:\\project", "C:\\project\\..data", win32)).toBe("..data");
  });
});
