import { access, constants as fsConstants, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENVELOPE_PROTOCOL } from "@musai/modules";
import { CURRENT_SCHEMA_VERSIONS, type ModuleRecord, recordId, versionString } from "@musai/records";
import { CANARY_CHANNELS } from "@musai/run";
import { initWorkspace, MUSAI_DIR, Store } from "@musai/store";
import { blobStoreOf, fixedClock, SCENARIO_INSTANT } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));
const now = fixedClock(SCENARIO_INSTANT);

const MODULE_NAME = "cli-list-fixture";
const LISTING_CONTRIBUTION_ID = `${MODULE_NAME}/marker`;
/** The preset a booking naming none is booked under, so every case here lists as its kind. */
const BARE_PRESET = "musai.core/bare";

/** A minimal listing contribution: `list` hands it the typed flags and adds no logic of its own. */
const LISTING_ENTRY = {
  kind: "query",
  id: LISTING_CONTRIBUTION_ID,
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: { kind: { type: ["string", "null"] } },
    statement: [
      "SELECT cases.id AS id, cases.slug AS slug,",
      "  json_extract(cases.record_json, '$.preset.contribution') AS kind",
      "FROM cases",
      "WHERE :kind IS NULL OR json_extract(cases.record_json, '$.preset.contribution') = :kind",
      "ORDER BY cases.id",
    ].join("\n"),
    tables: ["cases"],
  },
  output: {
    type: "object",
    required: ["rows"],
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "slug", "kind"],
          properties: { id: { type: "string" }, slug: { type: "string" }, kind: { type: "string" } },
        },
      },
    },
  },
  documentation: "a fixture listing proving the CLI's list verb reaches an installed contribution by name",
};

/** A bundle for the module record to name; a query is read from the fold, never invoked. */
function listingBundleSource(): string {
  return [
    "export function invoke(requestBytes) {",
    "  return (async () => {",
    "    const request = JSON.parse(new TextDecoder().decode(requestBytes));",
    "    if (request.contribution === 'describe') {",
    `      const entries = ${JSON.stringify([LISTING_ENTRY])};`,
    "      return new TextEncoder().encode(JSON.stringify({ ok: true, output: entries, diagnostics: [] }));",
    "    }",
    "    return new TextEncoder().encode(JSON.stringify({ ok: false, error: { code: 'unknown-contribution', data: {}, message: 'unknown' } }));",
    "  })();",
    "}",
  ].join("\n");
}

/** A directory holding only a `git` symlink: as a child's whole `PATH` it reaches no interpreter,
 * the one condition under which the canary refuses. */
async function gitOnlyPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "musai-cli-git-only-"));
  for (const entry of (process.env["PATH"] ?? "").split(delimiter).filter((part) => part.length > 0)) {
    const candidate = join(entry, "git");
    try {
      await access(candidate, fsConstants.X_OK);
      await symlink(candidate, join(directory, "git"));
      return directory;
    } catch {
      // this directory holds no executable git, so the search moves on
    }
  }
  throw new Error("no executable git anywhere on this machine's PATH");
}

describe("list and doctor — against the built binary", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-cli-list-doctor-"));
    await execa("node", [CLI_PATH, "init", workspace]);
    await execa("node", [CLI_PATH, "lab", "book", "cli-list-doctor-case", "--workspace", workspace]);

    const store = new Store({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope: "default", now });
    const bundleId = await blobStoreOf(workspace).put(new TextEncoder().encode(listingBundleSource()));
    const moduleRecord: ModuleRecord = {
      kind: "module",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
      name: MODULE_NAME,
      version: versionString("1"),
      manifest: {
        protocolVersion: ENVELOPE_PROTOCOL,
        contributions: [LISTING_ENTRY],
        sourceTree: { digest: { gitTree: "a".repeat(40) } },
        toolchain: [{ name: "node", version: versionString("24.0.0") }],
        packages: [],
      },
      bundle: bundleId,
      build: recordId({ marker: "cli-list-fixture-build" }),
    };
    await store.putMany([{ kind: "module", value: moduleRecord }]);
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("list --view reaches the named contribution, with no filter logic under packages/cli/src", async () => {
    async function listedSlugs(kind: string): Promise<string[]> {
      const { stdout } = await execa("node", [
        CLI_PATH,
        "lab",

        "list",
        "--view",
        LISTING_CONTRIBUTION_ID,
        "--kind",
        kind,
        "--workspace",
        workspace,
        "--json",
      ]);
      const output = JSON.parse(stdout) as { rows: Array<{ slug: string }> };
      return output.rows.map((row) => row.slug);
    }

    // The typed flag reaches the contribution, which is all the CLI does with it.
    expect(await listedSlugs(BARE_PRESET)).toEqual(["cli-list-doctor-case"]);
    expect(await listedSlugs("some-kind")).toEqual([]);
  });

  test("list with no view installed exits 0 and says the list is empty for want of a view, not for want of cases", async () => {
    const bare = await mkdtemp(join(tmpdir(), "musai-cli-list-no-view-"));
    try {
      await initWorkspace(bare, { now });

      const result = await execa("node", [CLI_PATH, "lab", "list", "--workspace", bare, "--json"]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        rows: [],
        unlisted: expect.stringContaining("no view contribution"),
      });

      const text = await execa("node", [CLI_PATH, "lab", "list", "--workspace", bare]);
      expect(text.stdout).not.toBe("no cases");
      expect(text.stdout).toContain("no view contribution");
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("doctor prints a complete report and exits 0, byte-identical under --json across two runs at one head", async () => {
    const first = await execa("node", [CLI_PATH, "doctor", "--workspace", workspace, "--json"]);
    const second = await execa("node", [CLI_PATH, "doctor", "--workspace", workspace, "--json"]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout).toBe(second.stdout);

    const report = JSON.parse(first.stdout) as { exitCodes: Array<{ code: number }> };
    expect(report.exitCodes.map((row) => row.code)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("doctor reports one local check per ambient channel a run under hygiene is probed for", async () => {
    const { stdout } = await execa("node", [CLI_PATH, "doctor", "--workspace", workspace, "--json"]);
    const report = JSON.parse(stdout) as { local: Array<{ name: string; detail: string }> };
    const names = report.local.map((check) => check.name);
    for (const channel of CANARY_CHANNELS) {
      expect(names).toContain(`canary-${channel}`);
    }
  });

  test("a canary refusal is one failed check carrying the refusal's own detail, and doctor still exits 0", async () => {
    const pathDirectory = await gitOnlyPath();
    try {
      const { exitCode, stdout } = await execa(
        process.execPath,
        [CLI_PATH, "doctor", "--workspace", workspace, "--json"],
        { env: { PATH: pathDirectory } },
      );
      expect(exitCode).toBe(0);

      const report = JSON.parse(stdout) as { local: Array<{ name: string; ok: boolean; detail: string }> };
      const canary = report.local.filter((check) => check.name.startsWith("canary"));
      expect(canary).toEqual([
        { name: "canary", ok: false, detail: "no binary named node was found on the invoking process's own PATH" },
      ]);
    } finally {
      await rm(pathDirectory, { recursive: true, force: true });
    }
  });

  test("each canary check says, in plain words, what a check's run was probed for", async () => {
    const { stdout } = await execa("node", [CLI_PATH, "doctor", "--workspace", workspace, "--json"]);
    const report = JSON.parse(stdout) as { local: Array<{ name: string; detail: string }> };
    const home = report.local.find((check) => check.name === "canary-home");
    expect(home?.detail).toMatch(/^a check's run .*your home directory/);
  });

  test("a container engine whose binary resolves but does not answer is a failed check naming what it costs", async () => {
    const pathDirectory = await gitOnlyPath();
    try {
      await symlink(join(pathDirectory, "git"), join(pathDirectory, "docker"));
      const { exitCode, stdout } = await execa(
        process.execPath,
        [CLI_PATH, "doctor", "--workspace", workspace, "--json"],
        { env: { PATH: [pathDirectory, dirname(process.execPath)].join(delimiter) } },
      );
      expect(exitCode).toBe(0);

      const report = JSON.parse(stdout) as { local: Array<{ name: string; ok: boolean; detail: string }> };
      const engine = report.local.find((check) => check.name === "container-engine");
      expect(engine?.ok).toBe(false);
      expect(engine?.detail).toContain("a run declaring an image is refused");
    } finally {
      await rm(pathDirectory, { recursive: true, force: true });
    }
  });

  test("doctor's text form prints the exit-code table", async () => {
    const { stdout } = await execa("node", [CLI_PATH, "doctor", "--workspace", workspace]);
    expect(stdout).toContain("Exit codes");
    expect(stdout).toContain("install something");
  });

  test("key --help lists both key.list@1 and key.rotate@1", async () => {
    const { stdout } = await execa("node", [CLI_PATH, "lab", "key", "--help"]);
    expect(stdout).toContain("list");
    expect(stdout).toContain("rotate");
  });

  test("a command line this kernel cannot parse exits 2, the code that asks the caller to fix the invocation", async () => {
    const misuses = [["lab", "progress"], ["lab", "module", "build"], ["not-a-verb"], ["doctor", "--not-a-flag"]];
    for (const argv of misuses) {
      const result = await execa("node", [CLI_PATH, ...argv, "--workspace", workspace], { reject: false });
      expect({ argv, exitCode: result.exitCode }).toEqual({ argv, exitCode: 2 });
    }
  });

  test("the code a refusal exits with is the one doctor's own table names for its class", async () => {
    const { stdout } = await execa("node", [CLI_PATH, "doctor", "--workspace", workspace, "--json"]);
    const report = JSON.parse(stdout) as { exitCodes: Array<{ code: number; class: string | null }> };
    const invocation = report.exitCodes.find((row) => row.class === "invocation");
    expect(invocation).toBeDefined();

    const refused = await execa("node", [CLI_PATH, "why", "not-a-record-id", "--workspace", workspace], {
      reject: false,
    });
    expect(refused.exitCode).toBe(invocation!.code);
  });

  test("help is not a misuse and exits 0", async () => {
    const result = await execa("node", [CLI_PATH, "--help"], { reject: false });
    expect(result.exitCode).toBe(0);
  });
});
