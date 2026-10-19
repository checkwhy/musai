import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHandler } from "@musai/api-core";
import { INDEX_SCHEMA_VERSION } from "@musai/fold";
import { ENVELOPE_PROTOCOL } from "@musai/modules";
import {
  CODE_CLASSES,
  type ContributionEntry,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  exitCodeForClass,
  type ModuleRecord,
  versionString,
} from "@musai/records";
import { initWorkspace, LOCAL_DIR, MUSAI_DIR, materialiseView, mintKeyFile, Store } from "@musai/store";
import { commitAroundTheStore, fixedClock, writeTrustFile } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { REGISTRY } from "../src/musai.js";
import { doctorRun } from "../src/ops/doctor.js";

const KNOWN_SECRET_VALUE = "definitely-not-supposed-to-leak-7f3c9a";
const FIXTURE_MODULE_NAME = "doctor-fixture-pack";

interface RequirementSpec {
  readonly binary: string;
  readonly versionPredicate: string | null;
  readonly neededBy: string;
  readonly install: string;
}

async function installRequirementsModule(
  store: Store,
  specs: readonly RequirementSpec[],
  moduleName: string = FIXTURE_MODULE_NAME,
): Promise<void> {
  const moduleRecord: ModuleRecord = {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name: moduleName,
    version: versionString("1"),
    manifest: {
      protocolVersion: ENVELOPE_PROTOCOL,
      contributions: specs.map((spec) => ({
        kind: "requirement",
        id: `${moduleName}/${spec.binary}`,
        version: versionString("1"),
        input: spec,
        output: true,
        documentation: `${spec.binary}, needed by ${spec.neededBy}`,
      })),
      sourceTree: { digest: { gitTree: "a".repeat(40) } },
      toolchain: [],
      packages: [],
    },
    bundle: null,
    build: null,
  };
  await store.putMany([{ kind: "module", value: moduleRecord }]);
}

const FOLD_MODULE_NAME = "doctor-fold-pack";

/** Writes a module with no bundle declaring a fold table of `columnType`, bypassing install, which
 * refuses a type no SQLite column binds. */
async function writeFoldModule(
  store: Store,
  options: { columnType?: string; withQuery?: boolean } = {},
): Promise<void> {
  const columnType = options.columnType ?? "array";
  const moduleRecord: ModuleRecord = {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name: FOLD_MODULE_NAME,
    version: versionString("1"),
    manifest: {
      protocolVersion: ENVELOPE_PROTOCOL,
      contributions: [
        ...(options.withQuery === true
          ? [
              {
                kind: "query",
                id: `${FOLD_MODULE_NAME}/kinds`,
                version: versionString("1"),
                input: {
                  type: "object",
                  additionalProperties: false,
                  required: [],
                  properties: {},
                  statement: "SELECT tag FROM doctor_fold_pack_rows ORDER BY tag",
                  tables: ["doctor_fold_pack_rows"],
                },
                output: {
                  type: "object",
                  additionalProperties: false,
                  required: ["rows"],
                  properties: {
                    rows: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["tag"],
                        properties: { tag: { type: "string" } },
                      },
                    },
                  },
                },
                documentation: "every tag the table holds",
              } satisfies ContributionEntry,
            ]
          : []),
        {
          kind: "fold",
          id: `${FOLD_MODULE_NAME}/rows`,
          version: versionString("1"),
          input: true,
          output: {
            type: "object",
            additionalProperties: false,
            required: ["rows"],
            properties: {
              rows: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["tag"],
                  properties: { tag: { type: columnType } },
                },
              },
            },
          },
          documentation: "one row per record, under a column type no engine binds",
        },
      ],
      sourceTree: { digest: { gitTree: "b".repeat(40) } },
      toolchain: [],
      packages: [],
    },
    bundle: null,
    build: null,
  };
  await store.putMany([{ kind: "module", value: moduleRecord }]);
}

describe("doctor.run@2", () => {
  let workspace: string;
  // Apart from `workspace`, so a test pointing elsewhere still has this one removed.
  let ownWorkspace: string;
  const scope = "default";
  const now = fixedClock("2026-01-01T00:00:00.000Z");

  beforeEach(async () => {
    ownWorkspace = await mkdtemp(join(tmpdir(), "musai-doctor-"));
    workspace = ownWorkspace;
    await initWorkspace(workspace, { now });
  });

  afterEach(async () => {
    await rm(ownWorkspace, { recursive: true, force: true });
  });

  function ctx() {
    return { workspace, scope, now };
  }

  function storeAt(): Store {
    return new Store({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope, now });
  }

  function localDir(): string {
    return join(workspace, MUSAI_DIR, LOCAL_DIR);
  }

  test("is the one registered version of the verb, the first having been retired", () => {
    expect(REGISTRY.get("doctor.run@2")).toBe(doctorRun);
    expect(REGISTRY.has("doctor.run@1")).toBe(false);
  });

  test("names no tool of its own: a workspace with no installed module reports no requirement rows, and still completes", async () => {
    const output = await runHandler(doctorRun, {}, ctx());
    expect(output.requirements).toEqual([]);
    expect(output.local.length).toBeGreaterThan(0);
  });

  test("lists the workspace's tools beside the modules' requirements, each resolved on this machine", async () => {
    await writeTrustFile({ gitDir: join(workspace, MUSAI_DIR) }, "config.json", JSON.stringify({ tools: ["node"] }));

    const output = await runHandler(doctorRun, {}, ctx());

    expect(output.requirements).toHaveLength(1);
    expect(output.requirements[0]).toMatchObject({ binary: "node", resolved: true, declaredBy: "workspace tools" });
  });

  test("enumerates a real, resolvable requirement a fixture module declares, reporting it resolved with a digest, its declaring module and its install hint", async () => {
    await installRequirementsModule(storeAt(), [
      {
        binary: "node",
        versionPredicate: ">=1",
        neededBy: "this fixture's own test",
        install: "already on this machine",
      },
    ]);

    const output = await runHandler(doctorRun, {}, ctx());
    expect(output.requirements).toHaveLength(1);
    const row = output.requirements[0]!;
    expect(row.binary).toBe("node");
    expect(row.resolved).toBe(true);
    expect(row.digest).not.toBeNull();
    expect(row.declaredBy).toBe(FIXTURE_MODULE_NAME);
    expect(row.install).toBe("already on this machine");
  });

  test("a binary two modules declare under different predicates is one row naming both, saying a run naming it is refused", async () => {
    const spec = { binary: "node", neededBy: "the fixture's own test", install: "already on this machine" };
    await installRequirementsModule(storeAt(), [{ ...spec, versionPredicate: ">=1" }], "first-doctor-pack");
    await installRequirementsModule(storeAt(), [{ ...spec, versionPredicate: ">=2" }], "second-doctor-pack");

    const output = await runHandler(doctorRun, {}, ctx());

    expect(output.requirements).toHaveLength(1);
    expect(output.requirements[0]).toMatchObject({
      binary: "node",
      declaredBy: "first-doctor-pack, second-doctor-pack",
      refusal:
        "a run naming node is refused: its modules declare different version predicates: first-doctor-pack (>=1), second-doctor-pack (>=2)",
    });
    expect(doctorRun.renderText!(output)).toContain(
      "!!      node  (first-doctor-pack, second-doctor-pack) — a run naming node is refused",
    );
  });

  test("a requirement entry that is not the data its point declares is one failed workspace row naming the module and the entry, and the report completes", async () => {
    const stray = { binary: 7 as unknown as string, versionPredicate: null, neededBy: "x", install: "y" };
    await installRequirementsModule(storeAt(), [stray], "stray-doctor-pack");

    const output = await runHandler(doctorRun, {}, ctx());

    expect(output.requirements).toEqual([]);
    const row = output.local.find((check) => check.name === "requirement-entries");
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain("the requirement stray-doctor-pack/7 declared by stray-doctor-pack");
    expect(doctorRun.exitCode(output)).toBe(exitCodeForClass("workspace"));
  });

  test("a binary two modules declare under one predicate carries no refusal", async () => {
    const spec = { binary: "node", versionPredicate: ">=1", neededBy: "the fixture's own test", install: "no" };
    await installRequirementsModule(storeAt(), [spec], "first-doctor-pack");
    await installRequirementsModule(storeAt(), [spec], "second-doctor-pack");

    const output = await runHandler(doctorRun, {}, ctx());

    expect(output.requirements.map((row) => row.refusal)).toEqual([null, null]);
  });

  test("a version below what a module declared is reported unsatisfied, with the constraint and the install hint", async () => {
    await installRequirementsModule(storeAt(), [
      {
        binary: "node",
        versionPredicate: ">=9999",
        neededBy: "proving a constraint is checked",
        install: "upgrade node",
      },
    ]);

    const output = await runHandler(doctorRun, {}, ctx());
    const row = output.requirements[0]!;
    expect(row.resolved).toBe(true);
    expect(row.version).not.toBeNull();
    expect(row.versionPredicate).toBe(">=9999");
    expect(row.satisfiesVersion).toBe(false);
    expect(doctorRun.renderText!(output)).toContain("!!      node");
    expect(doctorRun.renderText!(output)).toContain(">=9999");
  });

  test("a version at or above what a module declared is reported satisfied", async () => {
    await installRequirementsModule(storeAt(), [
      {
        binary: "node",
        versionPredicate: ">=1",
        neededBy: "proving a met constraint reads ok",
        install: "already on this machine",
      },
    ]);

    const output = await runHandler(doctorRun, {}, ctx());
    const row = output.requirements[0]!;
    expect(row.satisfiesVersion).toBe(true);
    expect(doctorRun.renderText!(output)).toContain("ok      node");
  });

  test("a constraint this kernel cannot evaluate is reported unjudged rather than passed", async () => {
    await installRequirementsModule(storeAt(), [
      {
        binary: "node",
        versionPredicate: "^24",
        neededBy: "proving an unevaluable constraint is not a pass",
        install: "install node 24",
      },
    ]);

    const output = await runHandler(doctorRun, {}, ctx());
    const row = output.requirements[0]!;
    expect(row.satisfiesVersion).toBeNull();
    expect(row.versionPredicate).toBe("^24");
    expect(doctorRun.renderText!(output)).toContain("??      node");
  });

  test("a binary no installed module declares never appears at all, and one absent from PATH is reported absent, with its hint, and the report still completes — no code change under packages/distribution/src/doctor for either", async () => {
    await installRequirementsModule(storeAt(), [
      {
        binary: "definitely-not-a-real-binary-doctor-fixture",
        versionPredicate: null,
        neededBy: "proving absence is data, not a thrown error",
        install: "install it from nowhere; this binary does not exist",
      },
    ]);

    const output = await runHandler(doctorRun, {}, ctx());
    expect(output.requirements).toHaveLength(1);
    const row = output.requirements[0]!;
    expect(row.resolved).toBe(false);
    expect(row.digest).toBeNull();
    expect(row.install).toBe("install it from nowhere; this binary does not exist");
    // No installed module names git, so it never appears.
    expect(output.requirements.some((r) => r.binary === "git")).toBe(false);
  });

  test("plants a workspace key with known bytes and a binding with a known secret value; neither appears anywhere in the report's canonical bytes", async () => {
    await mintKeyFile(localDir(), { now });
    const bindingsPath = join(localDir(), "bindings.json");
    await writeFile(bindingsPath, JSON.stringify({ MY_SECRET: { secret: true, value: KNOWN_SECRET_VALUE } }), {
      mode: 0o600,
    });
    await chmod(bindingsPath, 0o600);

    const output = await runHandler(doctorRun, {}, ctx());
    const bytes = new TextDecoder().decode(canonicalBytes(output));
    expect(bytes).not.toContain(KNOWN_SECRET_VALUE);

    const keyFileCheck = output.local.find((check) => check.name === "key-file");
    expect(keyFileCheck?.ok).toBe(true);
    const bindingsCheck = output.local.find((check) => check.name === "bindings-file");
    expect(bindingsCheck?.ok).toBe(true);
  });

  test("reports the key file's mode as owner-only without ever having minted one", async () => {
    const output = await runHandler(doctorRun, {}, ctx());
    const keyFileCheck = output.local.find((check) => check.name === "key-file");
    expect(keyFileCheck?.ok).toBe(true);
    expect(keyFileCheck?.detail).toContain("no workspace key minted yet");
  });

  test("reports the store's loose objects against the count past which it packs itself", async () => {
    const output = await runHandler(doctorRun, {}, ctx());

    const check = output.local.find((c) => c.name === "loose-objects");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/^\d+ loose objects; the store packs itself past 6700$/);
  });

  test("names the programs this machine adds for its own launchers, each resolved here", async () => {
    await writeFile(join(localDir(), "tools.json"), JSON.stringify(["sed", "musai-no-such-program"]));

    const output = await runHandler(doctorRun, {}, ctx());

    const rows = output.local.filter((c) => c.name === "machine-tools");
    expect(rows.map((row) => [row.ok, row.detail.split(" ")[0]])).toEqual([
      [true, "sed"],
      [false, "musai-no-such-program"],
    ]);
  });

  test("refuses the scenario suite's key, whose private half is published, wherever a workspace trusts it", async () => {
    const published = await readFile(
      fileURLToPath(new URL("../../scenarios/releasing/keys/scenario-test-key.pub", import.meta.url)),
      "utf8",
    );
    const [keyType, key] = published.split(" ");
    const before = await runHandler(doctorRun, {}, ctx());
    await writeTrustFile(
      { gitDir: join(workspace, MUSAI_DIR) },
      "allowed-signers",
      `someone@example.test ${keyType} ${key}\n`,
    );

    const output = await runHandler(doctorRun, {}, ctx());

    expect(before.local.find((c) => c.name === "published-key")?.ok).toBe(true);
    expect(output.local.find((c) => c.name === "published-key")).toMatchObject({ ok: false });
    expect(doctorRun.exitCode(output)).toBe(3);
  });

  test("reports the index schema version and no stale view worktree in a fresh workspace", async () => {
    const output = await runHandler(doctorRun, {}, ctx());
    const schemaCheck = output.local.find((check) => check.name === "index-schema");
    expect(schemaCheck?.ok).toBe(true);
    expect(schemaCheck?.detail).toContain(String(INDEX_SCHEMA_VERSION));
    const worktreeCheck = output.local.find((check) => check.name === "view-worktrees");
    expect(worktreeCheck?.ok).toBe(true);
  });

  test("a fresh workspace, whose every declaration stands, reports no refused contributed table or query", async () => {
    const output = await runHandler(doctorRun, {}, ctx());
    expect(output.local.filter((check) => check.name === "contributed-declarations")).toEqual([]);
  });

  test("a fold declaration the workspace cannot stand up is one failed check naming the contribution and why", async () => {
    await writeFoldModule(storeAt());

    const output = await runHandler(doctorRun, {}, ctx());

    const refused = output.local.filter((check) => check.name === "contributed-declarations");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.ok).toBe(false);
    expect(refused[0]!.detail).toContain(`${FOLD_MODULE_NAME}/rows`);
    expect(refused[0]!.detail).toContain("tag");
    expect(refused[0]!.detail).toContain("re-pinning the pack");
  });

  test("a contributed table this workspace could not build is a failed check saying the next open tries it again", async () => {
    // The declaration stands but has no row function, and only the report says so.
    await writeFoldModule(storeAt(), { columnType: "string" });

    const output = await runHandler(doctorRun, {}, ctx());

    const refused = output.local.filter((check) => check.name === "contributed-declarations");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.ok).toBe(false);
    expect(refused[0]!.detail).toContain(`${FOLD_MODULE_NAME}/rows`);
    expect(refused[0]!.detail).toContain("tries it again");
    expect(refused[0]!.detail).not.toContain("re-pinning the pack");
  });

  test("a table this workspace could not build and the query over it are one cause, so the report gives one instruction", async () => {
    await writeFoldModule(storeAt(), { columnType: "string", withQuery: true });

    const output = await runHandler(doctorRun, {}, ctx());

    const refused = output.local.filter((check) => check.name === "contributed-declarations");
    expect(refused).toHaveLength(2);
    // The query is refused only for its missing table, so both rows give one answer.
    for (const check of refused) {
      expect(check.detail).toContain("tries it again");
      expect(check.detail).not.toContain("re-pinning the pack");
    }
  });

  test("prints every exit-code class and numbers, derived from the reason vocabulary's own code classes", async () => {
    const output = await runHandler(doctorRun, {}, ctx());
    expect(output.exitCodes).toHaveLength(CODE_CLASSES.length + 1);
    expect(output.exitCodes[0]).toEqual({ code: 0, class: null, description: "nothing — it worked" });
    CODE_CLASSES.forEach((codeClass, index) => {
      const row = output.exitCodes[index + 1]!;
      expect(row.code).toBe(index + 1);
      expect(row.class).toBe(codeClass);
      expect(row.description.length).toBeGreaterThan(0);
    });
  });

  test("doctor's table gives code 7 to a claim that does not hold", async () => {
    const output = await runHandler(doctorRun, {}, ctx());
    expect(output.exitCodes.find((row) => row.code === 7)).toMatchObject({ class: "unheld" });
  });

  test("doctor --json is byte-identical across two runs at one head", async () => {
    await installRequirementsModule(storeAt(), [
      { binary: "node", versionPredicate: ">=1", neededBy: "determinism", install: "already on this machine" },
    ]);
    const first = await runHandler(doctorRun, {}, ctx());
    const second = await runHandler(doctorRun, {}, ctx());
    expect(new TextDecoder().decode(canonicalBytes(first))).toBe(new TextDecoder().decode(canonicalBytes(second)));
  });

  test("a workspace inside no repository at all has nothing to be ignored by", async () => {
    const output = await runHandler(doctorRun, {}, ctx());
    const check = output.local.find((c) => c.name === "enclosing-repository");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toBe("no enclosing repository");
  });

  test("a blob store beside the workspace or inside its repository is reported, naming the import", async () => {
    for (const dir of [join(workspace, "blobs"), join(workspace, MUSAI_DIR, "blobs")]) {
      await mkdir(join(dir, "ab"), { recursive: true });
      await writeFile(join(dir, "ab", "ab".repeat(32)), "a bundle");
    }

    const output = await runHandler(doctorRun, {}, ctx());

    const check = output.local.find((c) => c.name === "blob-store");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(`musai lab blobs import ${join(workspace, "blobs")}`);
    expect(check?.detail).toContain(`musai lab blobs import ${join(workspace, MUSAI_DIR, "blobs")}`);
  });

  test("exits as a workspace to fix when a row about the workspace fails", async () => {
    await mkdir(join(workspace, "blobs", "ab"), { recursive: true });
    await writeFile(join(workspace, "blobs", "ab", "ab".repeat(32)), "a bundle");

    const output = await runHandler(doctorRun, {}, ctx());

    expect(doctorRun.exitCode(output)).toBe(3);
  });

  test("exits 0 when only a row about the machine fails", async () => {
    const output = await runHandler(doctorRun, {}, ctx());
    const machineDown = {
      ...output,
      local: [
        ...output.local,
        { name: "container-engine", ok: false, detail: "no engine answers" },
        { name: "canary", ok: false, detail: "the canary did not run" },
      ],
    };

    const failing = machineDown.local.filter((check) => !check.ok).map((check) => check.name);
    expect(failing.every((name) => name === "container-engine" || name.startsWith("canary"))).toBe(true);
    expect(doctorRun.exitCode(machineDown)).toBe(0);
  });

  test("a scope whose history holds records at one-level paths is reported, naming the rewrite", async () => {
    const hex = "ab".repeat(32);
    await commitAroundTheStore(
      { ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope, now },
      `records/claim/ab/${hex}.json`,
      new TextEncoder().encode("{}"),
    );

    const output = await runHandler(doctorRun, {}, { ...ctx(), reportRefusal: () => undefined });

    const check = output.local.find((c) => c.name === "record-layout");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("1 record");
    expect(check?.detail).toContain("musai lab store relayout");
  });

  test("a scope written two levels deep passes the layout check", async () => {
    const output = await runHandler(doctorRun, {}, ctx());

    expect(output.local.find((c) => c.name === "record-layout")?.ok).toBe(true);
  });

  test("a project's own blobs directory beside the workspace is no blob store", async () => {
    await mkdir(join(workspace, "blobs"), { recursive: true });
    await writeFile(join(workspace, "blobs", "fixture.bin"), "the project's own bytes");

    const output = await runHandler(doctorRun, {}, ctx());

    expect(output.local.find((c) => c.name === "blob-store")?.ok).toBe(true);
  });

  describe("inside a project that tracks files of its own", () => {
    let project: string | undefined;

    afterEach(async () => {
      if (project !== undefined) {
        await rm(project, { recursive: true, force: true });
        project = undefined;
      }
    });

    /** A real enclosing working tree with `ignoreLines`, holding a workspace at `workspace/`. */
    async function enclose(ignoreLines: string): Promise<string> {
      project = await mkdtemp(join(tmpdir(), "musai-doctor-enclosing-"));
      await execa("git", ["init", "--quiet", project]);
      await writeFile(join(project, ".gitignore"), ignoreLines);
      const inside = join(project, "workspace");
      await mkdir(inside);
      await initWorkspace(inside, { now });
      return inside;
    }

    test("a project that ignores the local directory passes, since committing records is an arrangement this kernel supports", async () => {
      workspace = await enclose(`workspace/${MUSAI_DIR}/${LOCAL_DIR}/\n`);
      const output = await runHandler(doctorRun, {}, ctx());
      const check = output.local.find((c) => c.name === "enclosing-repository");
      expect(check?.ok).toBe(true);
      await expect(mintKeyFile(localDir(), { now })).resolves.toBeDefined();
    });

    test("a project that ignores nothing, around a workspace without its own ignore file, is reported, and refuses to hold a workspace key", async () => {
      workspace = await enclose("build/\n");
      await rm(join(workspace, MUSAI_DIR, ".gitignore"));
      const output = await runHandler(doctorRun, {}, ctx());
      const check = output.local.find((c) => c.name === "enclosing-repository");
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain(LOCAL_DIR);
      await expect(mintKeyFile(localDir(), { now })).rejects.toThrow("does not ignore it");
    });
  });

  test("a stale view worktree is reported by path", async () => {
    // A registered worktree for a slug no case names: what listViewWorktrees reports stale.
    await materialiseView({ gitDir: join(workspace, MUSAI_DIR) }, "a-stray-case", [], new Set(), now);

    const output = await runHandler(doctorRun, {}, ctx());
    const worktreeChecks = output.local.filter((check) => check.name === "view-worktrees");
    expect(worktreeChecks.some((check) => !check.ok && check.detail.includes("a-stray-case"))).toBe(true);
  });
});
