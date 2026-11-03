import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCheckout } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vitest";

/** What `npm publish` sends: the package as the build stages it, never its workspace manifest. */
const STAGED_DIR = fileURLToPath(new URL("../pack", import.meta.url));

const DEVKIT_MANIFEST = new URL("../../devkit/package.json", import.meta.url);

/** A Node below the floor, named by the environment where one is installed beside this one. */
const OLD_NODE = process.env["OLD_NODE"];

/** esbuild heads each input's code in an unminified bundle with a comment naming its path. */
const BUNDLED_INPUT = /^\s*\/\/ \S*node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gm;

const NOTICE_HEADING = /^==== (\S+) \S+ \(.+\) ====$/gm;

/** Exit code 6 is the requirement class, `install something`. */
const REQUIREMENT_EXIT = 6;

describe("one npm package, packed and installed where no workspace package is", () => {
  let scratch: string;
  let tarball: string;
  let files: string[];
  let manifest: Record<string, unknown>;
  let bin: string;
  let installed: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "musai-pack-"));
    const { stdout } = await execa("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: STAGED_DIR });
    const [packed] = JSON.parse(stdout) as { filename: string; files: { path: string }[] }[];
    tarball = join(scratch, packed!.filename);
    files = packed!.files.map((file) => file.path);
    manifest = JSON.parse((await execa("tar", ["-xzOf", tarball, "package/package.json"])).stdout);
    const install = join(scratch, "install");
    await execa("npm", ["install", "--prefix", install, "--no-audit", "--no-fund", tarball]);
    installed = join(install, "node_modules", "checkwhy");
    bin = join(install, "node_modules", ".bin", "musai");
  }, 300_000);

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("the tarball holds the README, the licence, the third-party notices, the bundle and the files it reads at run time, and no source, map or test", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "package.json",
        "README.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES",
        "dist/bin/cli.js",
        "dist/bin/mcp.js",
        "dist/artefacts/bundle.js",
        "dist/artefacts/manifest.json",
        "dist/module/host-child.js",
        "dist/rule/sandbox-worker.js",
      ]),
    );
    expect(files.some((file) => file.startsWith("dist/templates/default/"))).toBe(true);
    expect(
      files.filter(
        (file) =>
          !file.startsWith("dist/") && !["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES"].includes(file),
      ),
    ).toEqual([]);
    expect(files.filter((file) => file.endsWith(".map") || file.includes("node_modules"))).toEqual([]);
    expect(files.filter((file) => file.includes("metafile"))).toEqual([]);
  });

  test("the notices name every third-party package whose code the bundle carries", async () => {
    const bundles = (await readdir(join(installed, "dist"), { recursive: true })).filter((file) =>
      file.endsWith(".js"),
    );
    const bundled = new Set<string>();
    for (const file of bundles) {
      for (const [, name] of (await readFile(join(installed, "dist", file), "utf8")).matchAll(BUNDLED_INPUT)) {
        bundled.add(name!);
      }
    }
    const notices = await readFile(join(installed, "THIRD_PARTY_NOTICES"), "utf8");
    const named = new Set([...notices.matchAll(NOTICE_HEADING)].map(([, name]) => name));

    expect(bundled.size).toBeGreaterThan(0);
    expect([...bundled].filter((name) => !named.has(name))).toEqual([]);
  });

  test("the packed manifest names the binary, the licence and devkit's esbuild as its one dependency, and no script", async () => {
    const devkit = JSON.parse(await readFile(DEVKIT_MANIFEST, "utf8"));

    expect(manifest).toMatchObject({ name: "checkwhy", license: "Apache-2.0", bin: { musai: "dist/bin/cli.js" } });
    expect(manifest["dependencies"]).toEqual({ esbuild: devkit.dependencies.esbuild });
    expect(Object.keys(manifest).filter((key) => /dependencies$|^scripts$/i.test(key))).toEqual(["dependencies"]);
  });

  test("installed, it prints the version its manifest names", async () => {
    expect((await execa(bin, ["--version"])).stdout).toBe(manifest["version"]);
  });

  test("installed alone, init and a check that holds exit 0 under Node 24", async () => {
    const checkout = await makeCheckout("hello");
    onTestFinished(() => checkout.cleanup());

    await execa(bin, ["init"], { cwd: checkout.dir });
    const checked = await execa(bin, ["check", "true holds", "--", "true"], { cwd: checkout.dir, reject: false });

    expect(checked.stderr).toBe("");
    expect(checked.exitCode).toBe(0);
    expect(checked.stdout).toMatch(/holds/);
  }, 300_000);

  test("installed alone, a module verb loads the devkit when it runs and scaffolds the module's source", async () => {
    const checkout = await makeCheckout("hello");
    onTestFinished(() => checkout.cleanup());

    await execa(bin, ["init"], { cwd: checkout.dir });
    const scaffolded = await execa(bin, ["lab", "module", "new", "demo-module"], { cwd: checkout.dir, reject: false });

    expect(scaffolded.stderr).not.toMatch(/Cannot find module/);
    expect(existsSync(join(checkout.dir, "demo-module", "package.json"))).toBe(true);
  }, 300_000);

  test.skipIf(OLD_NODE === undefined)(
    "under an older Node it names the version it found and exits as a requirement",
    async () => {
      const ran = await execa(OLD_NODE!, [bin, "--help"], { reject: false });

      expect(ran.exitCode).toBe(REQUIREMENT_EXIT);
      expect(ran.stderr).toMatch(/musai needs Node 24 or later, and this is Node \d+\./);
    },
  );
});
