import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { RunRecord } from "@musai/records";
import { CURRENT_SCHEMA_VERSIONS, timestamp, validateRecord } from "@musai/records";
import {
  bindCheckouts,
  type Checkout,
  COMMIT_ENV,
  commitContent,
  headCommit,
  headTree,
  makeCheckout,
} from "@musai/test-support";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import { resolveBinaries } from "../src/binaries.js";
import { BindingError, readCheckoutBindings } from "../src/bindings.js";
import { RunRefusedError } from "../src/hygiene.js";
import { RUNNER_PERFORMER } from "../src/performer.js";
import { performRecipe } from "../src/spawn.js";
import { commitTree, fileSubstrate, resolveSubstrates, substrateReadId, treeSubstrate } from "../src/substrate.js";

describe("treeSubstrate: the working tree as it actually is, named by its digest alone", () => {
  test("two captures of one dirty tree agree", async () => {
    // Two checkouts at two paths on two commits, dirtied alike: only the tree can make them agree.
    const checkoutA = await makeCheckout("checkout A's own history");
    const checkoutB = await makeCheckout("checkout B's own history");
    try {
      await writeFile(join(checkoutA.dir, "tracked.txt"), "the same dirty content");
      await writeFile(join(checkoutB.dir, "tracked.txt"), "the same dirty content");
      const capturedA = await treeSubstrate(checkoutA.ctx, checkoutA.dir);
      const capturedB = await treeSubstrate(checkoutB.ctx, checkoutB.dir);
      expect(capturedB).toEqual(capturedA);
    } finally {
      await checkoutA.cleanup();
      await checkoutB.cleanup();
    }
  });

  test("a capture names its tree and nothing about the machine holding it", async () => {
    const checkout = await makeCheckout();
    try {
      const descriptor = await treeSubstrate(checkout.ctx, checkout.dir);
      const { stdout } = await execa("git", ["-C", checkout.dir, "rev-parse", "HEAD^{tree}"]);
      expect(descriptor).toStrictEqual({ name: "source", digest: { gitTree: stdout.trim() } });
    } finally {
      await checkout.cleanup();
    }
  });

  test.skipIf(process.platform === "win32")(
    "a checkout holding an executable file measures its own commit's tree",
    async () => {
      const checkout = await makeCheckout();
      try {
        await writeFile(join(checkout.dir, "tool"), "#!/usr/bin/env node\n");
        await chmod(join(checkout.dir, "tool"), 0o755);
        await execa("git", ["-C", checkout.dir, "add", "tool"]);
        await execa("git", ["-C", checkout.dir, "commit", "--quiet", "-m", "tool"], { env: COMMIT_ENV });
        const descriptor = await treeSubstrate(checkout.ctx, checkout.dir);
        expect(descriptor.digest).toStrictEqual({ gitTree: await headTree(checkout.dir) });
      } finally {
        await checkout.cleanup();
      }
    },
  );

  test("where the disk cannot hold an executable bit, a measurement seeded with the commit carries the commit's mode", async () => {
    const checkout = await makeCheckout();
    try {
      const tool = join(checkout.dir, "tool");
      await writeFile(tool, "#!/usr/bin/env node\n");
      await execa("git", ["-C", checkout.dir, "add", "tool"]);
      await execa("git", ["-C", checkout.dir, "update-index", "--chmod=+x", "tool"]);
      await execa("git", ["-C", checkout.dir, "commit", "--quiet", "-m", "tool"], { env: COMMIT_ENV });
      await execa("git", ["-C", checkout.dir, "config", "core.fileMode", "false"]);
      await chmod(tool, 0o644);
      const commit = (await execa("git", ["-C", checkout.dir, "rev-parse", "HEAD"])).stdout.trim();
      const seeded = await treeSubstrate(checkout.ctx, checkout.dir, commit);
      const unseeded = await treeSubstrate(checkout.ctx, checkout.dir);
      expect(seeded.digest).toStrictEqual({ gitTree: await headTree(checkout.dir) });
      expect(unseeded.digest).not.toStrictEqual(seeded.digest);
    } finally {
      await checkout.cleanup();
    }
  });

  test("a file git ignores does not move the tree, and an untracked file it does not ignore does", async () => {
    const checkout = await makeCheckout();
    try {
      await writeFile(join(checkout.dir, ".gitignore"), "ignored.txt\n");
      await execa("git", ["-C", checkout.dir, "add", ".gitignore"]);
      await execa("git", ["-C", checkout.dir, "commit", "--quiet", "-m", "ignore"], { env: COMMIT_ENV });
      const clean = await treeSubstrate(checkout.ctx, checkout.dir);
      expect(clean.digest).toStrictEqual({ gitTree: await headTree(checkout.dir) });
      await writeFile(join(checkout.dir, "ignored.txt"), "ignored");
      expect(await treeSubstrate(checkout.ctx, checkout.dir)).toStrictEqual(clean);
      await writeFile(join(checkout.dir, "untracked.txt"), "untracked");
      expect(await treeSubstrate(checkout.ctx, checkout.dir)).not.toStrictEqual(clean);
    } finally {
      await checkout.cleanup();
    }
  });
});

describe("resolveSubstrates: a declared reference beside what the kernel resolved it to", () => {
  test("a descriptor with neither a locator nor a digest is refused, naming the entry", async () => {
    await expect(resolveSubstrates([{}], {})).rejects.toThrow(RunRefusedError);
  });

  test("a declared reference that is already a digest is unchanged by re-resolution", async () => {
    const descriptor = { digest: { sha256: "a".repeat(64) } };
    const [resolved] = await resolveSubstrates([descriptor], {});
    expect(resolved!.digest).toEqual(descriptor.digest);
  });

  test("a bare file locator re-resolves to its current digest, moving when the file's content moves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "musai-substrate-file-"));
    try {
      const filePath = join(dir, "value.txt");
      await writeFile(filePath, "first");
      const [first] = await resolveSubstrates([{ uri: `file://${filePath}` }], {});
      await writeFile(filePath, "second");
      const [second] = await resolveSubstrates([{ uri: `file://${filePath}` }], {});
      expect(first!.digest?.sha256).not.toBe(second!.digest?.sha256);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the declared and resolved substrate lists line up positionally", async () => {
    const descriptor = { digest: { sha256: "b".repeat(64) } };
    const { recipe, observation } = await performRecipe({
      command: ["true"],
      workingDirectory: "/",
      environment: {},
      declared: [],
      substrates: [descriptor],
      isolation: "hygiene",
    });
    expect(recipe.substrates.length).toBe(observation.resolved.length);
  });
});

/** A local directory of its own, removed once `fn` settles. */
async function withLocalDir<T>(fn: (localDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "musai-substrate-local-"));
  const localDir = join(root, "local");
  await mkdir(localDir, { recursive: true });
  try {
    return await fn(localDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The refusal a promise settles with, for a test that reads its message. */
async function refusalOf(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(outcome).toBeInstanceOf(Error);
  return outcome as Error;
}

describe("resolveSubstrates: a named commit is a checkout, measured against the commit's tree", () => {
  test("a clean bound checkout resolves to its name, its commit and the tree measured, and nothing else", async () => {
    const checkout = await makeCheckout();
    try {
      const commit = await headCommit(checkout.dir);
      const [resolved] = await resolveSubstrates([{ name: "repo", digest: { gitCommit: commit } }], {
        repo: { directory: checkout.dir },
      });
      expect(resolved).toStrictEqual({
        name: "repo",
        digest: { gitCommit: commit, gitTree: await headTree(checkout.dir) },
      });
    } finally {
      await checkout.cleanup();
    }
  });

  test("a checkout whose tree is not its commit's is refused naming the substrate, the commit and both trees, and not the directory", async () => {
    const checkout = await makeCheckout();
    try {
      const commit = await headCommit(checkout.dir);
      const committedTree = await headTree(checkout.dir);
      await writeFile(join(checkout.dir, "tracked.txt"), "dirtied");
      const measured = await treeSubstrate(checkout.ctx, checkout.dir);
      const error = await refusalOf(
        resolveSubstrates([{ name: "repo", digest: { gitCommit: commit } }], { repo: { directory: checkout.dir } }),
      );
      expect(error).toBeInstanceOf(RunRefusedError);
      expect(error.message).toContain("repo");
      expect(error.message).toContain(commit);
      expect(error.message).toContain(committedTree);
      expect(error.message).toContain(measured.digest!.gitTree!);
      expect(error.message).not.toContain(basename(checkout.dir));
    } finally {
      await checkout.cleanup();
    }
  });

  test("a named commit the checkout table does not bind is refused naming the substrate and checkouts.json", async () => {
    const error = await refusalOf(resolveSubstrates([{ name: "repo", digest: { gitCommit: "a".repeat(40) } }], {}));
    expect(error).toBeInstanceOf(RunRefusedError);
    expect(error.message).toContain("repo");
    expect(error.message).toContain("checkouts.json");
  });

  test("a bound checkout that does not hold the commit is refused naming the substrate and the commit, and not the directory", async () => {
    const holding = await makeCheckout("the commit's own content");
    const other = await makeCheckout("another history");
    try {
      const commit = await headCommit(holding.dir);
      const error = await refusalOf(
        resolveSubstrates([{ name: "repo", digest: { gitCommit: commit } }], { repo: { directory: other.dir } }),
      );
      expect(error).toBeInstanceOf(RunRefusedError);
      expect(error.message).toContain("repo");
      expect(error.message).toContain(`does not hold commit ${commit}`);
      expect(error.message).not.toContain(basename(other.dir));
    } finally {
      await holding.cleanup();
      await other.cleanup();
    }
  });

  test("a commit named by no substrate name is refused, since it names no checkout to measure", async () => {
    const error = await refusalOf(resolveSubstrates([{ digest: { gitCommit: "a".repeat(40) } }], {}));
    expect(error).toBeInstanceOf(RunRefusedError);
    expect(error.message).toContain("has no name");
  });

  // Root reads a file whatever its mode, so the measurement would not fail.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a git failure inside the measurement is refused naming the substrate alone, holding no directory",
    async () => {
      const checkout = await makeCheckout();
      const unreadable = join(checkout.dir, "unreadable.txt");
      try {
        const commit = await headCommit(checkout.dir);
        await writeFile(unreadable, "untracked and unreadable");
        await chmod(unreadable, 0o000);
        const error = await refusalOf(
          resolveSubstrates([{ name: "repo", digest: { gitCommit: commit } }], { repo: { directory: checkout.dir } }),
        );
        expect(error).toBeInstanceOf(RunRefusedError);
        expect(error.message).toContain("substrate repo could not be measured");
        expect(error.message).not.toContain(basename(checkout.dir));
      } finally {
        await chmod(unreadable, 0o644);
        await checkout.cleanup();
      }
    },
  );
});

/** Runs `fn` with the global git configuration pointed at a scratch file holding `config`. */
async function underGlobalConfig<T>(config: (configDir: string) => string, fn: () => Promise<T>): Promise<T> {
  const configDir = await mkdtemp(join(tmpdir(), "musai-global-config-"));
  const saved = process.env["GIT_CONFIG_GLOBAL"];
  const configPath = join(configDir, "gitconfig");
  await writeFile(configPath, config(configDir));
  process.env["GIT_CONFIG_GLOBAL"] = configPath;
  try {
    return await fn();
  } finally {
    if (saved === undefined) {
      delete process.env["GIT_CONFIG_GLOBAL"];
    } else {
      process.env["GIT_CONFIG_GLOBAL"] = saved;
    }
    await rm(configDir, { recursive: true, force: true });
  }
}

/** Committed with `files`, then `untracked` written beside them: clean by `git status`. */
async function cleanCheckout(
  files: Readonly<Record<string, string>>,
  untracked: Readonly<Record<string, string>> = {},
): Promise<Checkout> {
  const checkout = await makeCheckout();
  // Dated long before its index entry, so git trusts that entry's stat on every run.
  await utimes(join(checkout.dir, "tracked.txt"), 0, 0);
  await execa("git", ["-C", checkout.dir, "update-index", "--refresh"]);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(checkout.dir, name), content);
  }
  await execa("git", ["-C", checkout.dir, "add", "-A"]);
  // Re-clean, so the commit holds every file as the operator's filters produce it.
  await execa("git", ["-C", checkout.dir, "add", "--renormalize", "."]);
  await execa("git", ["-C", checkout.dir, "commit", "--quiet", "--allow-empty", "-m", "files"], { env: COMMIT_ENV });
  for (const [name, content] of Object.entries(untracked)) {
    await writeFile(join(checkout.dir, name), content);
  }
  expect((await execa("git", ["-C", checkout.dir, "status", "--porcelain"])).stdout).toBe("");
  return checkout;
}

describe("a bound checkout is measured under the operator's own git configuration, as their git status reads it", () => {
  const probes: readonly {
    readonly setting: string;
    readonly config: (configDir: string) => string;
    readonly files: Readonly<Record<string, string>>;
    readonly untracked?: Readonly<Record<string, string>>;
    readonly prepare?: (configDir: string) => Promise<void>;
  }[] = [
    { setting: "core.autocrlf", config: () => "[core]\n\tautocrlf = true\n", files: { "lines.txt": "one\r\ntwo\r\n" } },
    {
      setting: "a clean filter",
      config: () => '[filter "upper"]\n\tclean = tr a-z A-Z\n',
      files: { ".gitattributes": "*.txt filter=upper\n", "lower.txt": "lower\n" },
    },
    {
      setting: "core.excludesFile",
      config: (configDir) => `[core]\n\texcludesFile = ${join(configDir, "ignore").replaceAll("\\", "/")}\n`,
      files: {},
      untracked: { "junk.tmp": "ignored by the operator's own exclude file\n" },
    },
  ];

  for (const probe of probes) {
    test(`under ${probe.setting}, a clean checkout measures as its commit's tree`, async () => {
      await underGlobalConfig(probe.config, async () => {
        const configDir = dirname(process.env["GIT_CONFIG_GLOBAL"]!);
        await writeFile(join(configDir, "ignore"), "junk.tmp\n");
        const checkout = await cleanCheckout(probe.files, probe.untracked);
        try {
          const commit = await headCommit(checkout.dir);
          const [resolved] = await resolveSubstrates([{ name: "repo", digest: { gitCommit: commit } }], {
            repo: { directory: checkout.dir },
          });
          expect(resolved!.digest!.gitTree).toBe(await headTree(checkout.dir));
        } finally {
          await checkout.cleanup();
        }
      });
    });

    test(`under ${probe.setting}, an unbound source tree is still measured under the pinned configuration`, async () => {
      await underGlobalConfig(probe.config, async () => {
        const configDir = dirname(process.env["GIT_CONFIG_GLOBAL"]!);
        await writeFile(join(configDir, "ignore"), "junk.tmp\n");
        const checkout = await cleanCheckout(probe.files, probe.untracked);
        try {
          const measured = await treeSubstrate(checkout.ctx, checkout.dir);
          expect(measured.digest!.gitTree).not.toBe(await headTree(checkout.dir));
        } finally {
          await checkout.cleanup();
        }
      });
    });
  }

  test("a GIT_DIR or GIT_OBJECT_DIRECTORY inherited from the operator's shell names no repository a bound checkout is read from", async () => {
    const checkout = await makeCheckout("the bound checkout");
    const elsewhere = await makeCheckout("another repository");
    const commit = await headCommit(checkout.dir);
    const tree = await headTree(checkout.dir);
    const saved = { GIT_DIR: process.env["GIT_DIR"], GIT_OBJECT_DIRECTORY: process.env["GIT_OBJECT_DIRECTORY"] };
    process.env["GIT_DIR"] = elsewhere.ctx.gitDir;
    process.env["GIT_OBJECT_DIRECTORY"] = join(elsewhere.ctx.gitDir, "objects");
    try {
      const [resolved] = await resolveSubstrates([{ name: "repo", digest: { gitCommit: commit } }], {
        repo: { directory: checkout.dir },
      });
      expect(resolved!.digest!.gitCommit).toBe(commit);
      expect(
        await commitTree({ repo: { directory: checkout.dir } }, { name: "repo", digest: { gitCommit: commit } }),
      ).toBe(tree);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await checkout.cleanup();
      await elsewhere.cleanup();
    }
  });
});

describe("commitTree: a named commit's tree, read from the bound repository's objects", () => {
  test("answers the commit's tree after the checkout has moved on and been dirtied", async () => {
    const checkout = await makeCheckout("first");
    try {
      const first = await headCommit(checkout.dir);
      const firstTree = await headTree(checkout.dir);
      await commitContent(checkout.dir, "second");
      await writeFile(join(checkout.dir, "tracked.txt"), "dirtied");
      expect(
        await commitTree({ repo: { directory: checkout.dir } }, { name: "repo", digest: { gitCommit: first } }),
      ).toBe(firstTree);
    } finally {
      await checkout.cleanup();
    }
  });

  test("answers null for an unbound name and for a repository that does not hold the commit", async () => {
    const holding = await makeCheckout("the commit's own content");
    const other = await makeCheckout("another history");
    try {
      const descriptor = { name: "repo", digest: { gitCommit: await headCommit(holding.dir) } };
      expect(await commitTree({}, descriptor)).toBeNull();
      expect(await commitTree({ repo: { directory: other.dir } }, descriptor)).toBeNull();
    } finally {
      await holding.cleanup();
      await other.cleanup();
    }
  });
});

describe("readCheckoutBindings: where each checkout a recipe names sits on this machine", () => {
  test("a workspace with no checkouts.json reads as binding nothing", async () => {
    await withLocalDir(async (localDir) => {
      expect(await readCheckoutBindings(localDir)).toStrictEqual({});
    });
  });

  test("reads each name to its absolute directory", async () => {
    await withLocalDir(async (localDir) => {
      const directory = join(localDir, "checkout");
      await bindCheckouts(localDir, { repo: directory });
      expect(await readCheckoutBindings(localDir)).toStrictEqual({ repo: { directory } });
    });
  });

  test("refuses a relative directory, naming the entry and the file by its basename alone", async () => {
    await withLocalDir(async (localDir) => {
      await bindCheckouts(localDir, { repo: "relative/checkout" });
      const error = await refusalOf(readCheckoutBindings(localDir));
      expect(error).toBeInstanceOf(BindingError);
      expect(error.message).toContain("repo");
      expect(error.message).toContain("checkouts.json");
      expect(error.message).not.toContain(basename(dirname(localDir)));
    });
  });

  test.each([
    ["carries a key beside the directory", { repo: { directory: "/checkout", branch: "main" } }],
    ["carries no directory", { repo: {} }],
    ["names a directory that is not a string", { repo: { directory: 7 } }],
    ["is not an object", { repo: "/checkout" }],
  ])("refuses an entry that %s", async (_label, table) => {
    await withLocalDir(async (localDir) => {
      await writeFile(join(localDir, "checkouts.json"), JSON.stringify(table));
      const error = await refusalOf(readCheckoutBindings(localDir));
      expect(error).toBeInstanceOf(BindingError);
      expect(error.message).toContain("repo");
      expect(error.message).not.toContain(basename(dirname(localDir)));
    });
  });

  test("refuses a file that is not a JSON object, naming the file by its basename alone", async () => {
    await withLocalDir(async (localDir) => {
      for (const content of ["not json", "[]"]) {
        await writeFile(join(localDir, "checkouts.json"), content);
        const error = await refusalOf(readCheckoutBindings(localDir));
        expect(error).toBeInstanceOf(BindingError);
        expect(error.message).toContain("checkouts.json");
        expect(error.message).not.toContain(basename(dirname(localDir)));
      }
    });
  });
});

describe("fileSubstrate", () => {
  test("hashes a plain file as sha256", async () => {
    const dir = await mkdtemp(join(tmpdir(), "musai-substrate-plain-"));
    try {
      const filePath = join(dir, "plain.txt");
      await writeFile(filePath, "content");
      const descriptor = await fileSubstrate(filePath);
      expect(descriptor.digest?.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the read-log carries substrate reads through the existing prefix convention", () => {
  test("a substrate's read id is the declared reference under the substrate: prefix", () => {
    expect(substrateReadId({ uri: "file:///tmp/x" })).toBe("substrate:file:///tmp/x");
  });
});

describe("a digest map's algorithm keys are the closed three", () => {
  test("a digest map keyed by an algorithm outside sha256, gitTree and gitCommit is refused by name", () => {
    const run: RunRecord = {
      kind: "run",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
      runKind: "run",
      determinism: "nondeterministic",
      performer: RUNNER_PERFORMER,
      recipe: {
        command: ["true"],
        workingDirectory: "/",
        environment: {},
        declared: [],
        substrates: [{ digest: { sha512: "a".repeat(128) } as unknown as Record<string, string> }],
        isolation: "hygiene",
      },
      observation: {
        resolved: [],
        isolationHeld: "hygiene",
        binaries: [],
        bindings: [],
        output: "",
        outputLossy: false,
        exitCode: 0,
        scrubbed: [],
        startedAt: timestamp("2026-01-01T00:00:00.000Z"),
        finishedAt: timestamp("2026-01-01T00:00:00.000Z"),
        reads: [],
        cost: {},
      },
    };
    const result = validateRecord(run);
    expect(result.ok).toBe(false);
  });
});

describe("resolveBinaries", () => {
  test("resolves a binary present on the invoking process's own PATH to a name and a digest", async () => {
    const [resolved] = await resolveBinaries(["true"]);
    expect(resolved!.name).toBe("true");
    expect(resolved!.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
