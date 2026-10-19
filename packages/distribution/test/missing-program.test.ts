import type { RunRecipe } from "@musai/records";
import { describe, expect, test } from "vitest";
import { missingProgramHint, programHolderOf } from "../src/missing-program.js";

const TAIL =
  "Add it with --tool or to the workspace toolset, or to .musai/local/tools.json where only this machine needs it.";

const IMAGE = "registry.example/station";

const IMAGE_TAIL =
  "A run in a container keeps its image's own PATH, which --tool and tools.json do not reach: use an image that holds it.";

function declared(...names: string[]) {
  return { declared: new Set(names) };
}

describe("a failed check's hint names the program its PATH seems to have missed", () => {
  test("names the program env could not find", () => {
    const hint = missingProgramHint(127, "/usr/bin/env: 'musai-nope': No such file or directory\n", declared("env"));
    expect(hint).toBe(`exit and output suggest a program missing from the declared PATH: musai-nope? ${TAIL}`);
  });

  test("names the program a shell or a spawn could not find", () => {
    expect(missingProgramHint(127, "sh: 1: make: not found\n", declared("sh"))).toContain(": make?");
    expect(missingProgramHint(127, "bash: line 1: make: command not found\n", declared())).toContain(": make?");
    expect(missingProgramHint(1, "Error: spawn git ENOENT\n", declared())).toContain(": git?");
  });

  test("names sh for a package script that failed with no word of why, unless sh was declared", () => {
    const output = "$ vitest run\n[ELIFECYCLE] Test failed. See above for more details.\n";
    expect(missingProgramHint(254, output, declared("pnpm"))).toContain(": sh?");
    expect(missingProgramHint(254, output, declared("pnpm", "sh"))).toBeNull();
  });

  test("exit 127 with no name parsed still hints, naming nothing", () => {
    expect(missingProgramHint(127, "", declared())).toBe(
      `exit and output suggest a program missing from the declared PATH. ${TAIL}`,
    );
  });

  test("a failure that names no missing program, or one the recipe declared, carries no hint", () => {
    expect(missingProgramHint(1, "expected 2, got 3\n", declared())).toBeNull();
    expect(missingProgramHint(1, "Error: spawn git ENOENT\n", declared("git"))).toBeNull();
  });
});

describe("a failed run held in a container names its image as what lacks the program", () => {
  test("names the program the engine could not execute, and the image, never --tool as the way out", () => {
    const output = 'docker: Error response from daemon: exec: "make": executable file not found in $PATH: unknown.\n';
    expect(missingProgramHint(127, output, { image: IMAGE })).toBe(
      `exit and output suggest a program missing from the image ${IMAGE}: make? ${IMAGE_TAIL}`,
    );
  });

  test("hints for a program the recipe declared too, since the image's PATH is not the recipe's", () => {
    expect(missingProgramHint(1, "Error: spawn git ENOENT\n", { image: IMAGE })).toContain(`image ${IMAGE}: git?`);
  });

  test("exit 127 with no name parsed still names the image", () => {
    expect(missingProgramHint(127, "", { image: IMAGE })).toBe(
      `exit and output suggest a program missing from the image ${IMAGE}. ${IMAGE_TAIL}`,
    );
  });

  test("a failure that names no missing program carries no hint", () => {
    expect(missingProgramHint(1, "expected 2, got 3\n", { image: IMAGE })).toBeNull();
  });

  test("a failing package script carries no hint, since the image holds the sh it ran in", () => {
    const output = "$ vitest run\n[ELIFECYCLE] Test failed. See above for more details.\n";
    expect(missingProgramHint(254, output, { image: IMAGE })).toBeNull();
  });

  test("names the program podman could not execute", () => {
    const output = "Error: crun: executable file `make` not found in $PATH: No such file or directory\n";
    expect(missingProgramHint(127, output, { image: IMAGE })).toContain(`image ${IMAGE}: make?`);
  });
});

describe("who holds a failed run's programs", () => {
  const recipe: RunRecipe = {
    command: ["make"],
    workingDirectory: ".",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  };
  const declaringAnImage: RunRecipe = {
    ...recipe,
    substrates: [
      {
        uri: IMAGE,
        digest: { sha256: "a".repeat(64) },
        mediaType: "application/vnd.oci.image.manifest.v1+json",
      },
    ],
    isolation: "container",
  };
  const ranIn = (held: "container" | "hygiene", of: RunRecipe) => ({
    recipe: of,
    observation: { isolationHeld: held },
  });

  test("is the image for a run held in a container, whatever names its recipe declared", () => {
    expect(programHolderOf(ranIn("container", declaringAnImage), new Set(["make"]))).toEqual({ image: IMAGE });
    expect(programHolderOf(ranIn("container", declaringAnImage), null)).toEqual({ image: IMAGE });
  });

  test("is the declared names for a run that declared an image and ran on the host", () => {
    expect(programHolderOf(ranIn("hygiene", declaringAnImage), new Set(["make"]))).toEqual({
      declared: new Set(["make"]),
    });
  });

  test("is the declared names for a run on the host, and nobody for a rule's", () => {
    expect(programHolderOf(ranIn("hygiene", recipe), new Set(["make"]))).toEqual({ declared: new Set(["make"]) });
    expect(programHolderOf(ranIn("hygiene", recipe), null)).toBeNull();
  });
});
