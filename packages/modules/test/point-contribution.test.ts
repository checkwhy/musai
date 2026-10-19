import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContributionEntry, ModuleRecord } from "@musai/records";
import { CURRENT_SCHEMA_VERSIONS, rawId, recordId, versionString } from "@musai/records";
import { Store } from "@musai/store";
import {
  blobStoreOf,
  type FixtureRepo,
  foldedIndex,
  gatewaySource,
  makeFixtureRepo,
  manifestWithContributions,
} from "@musai/test-support";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { installModule, UnknownContributionPointError } from "../src/module/install.js";
import { PointRefusedError, pointFor, readPointDeclarations } from "../src/module/point-registry.js";
import { SubprocessHost } from "../src/module/subprocess-host.js";
import {
  type ContributionPoint,
  ENVELOPE_PROTOCOL,
  type EnvelopeRequest,
  type InvokedContribution,
  kernelPoint,
} from "../src/rule/envelope.js";
import { InProcessHost } from "../src/rule/host.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function trackedRepo(): Promise<FixtureRepo> {
  const repo = await makeFixtureRepo();
  cleanups.push(repo.cleanup);
  return repo;
}

const GREETING_SCHEMA = { type: "object", required: ["greeting"], properties: { greeting: { type: "string" } } };

function pointEntry(id: string, input: unknown, version = "1"): ContributionEntry {
  return { kind: "point", id, version: versionString(version), input, output: true, documentation: `the ${id} point` };
}

/** Writes a module record straight through the store: these tests pin the fold's read. */
async function writeModule(repo: FixtureRepo, name: string, contributions: readonly ContributionEntry[]) {
  const record: ModuleRecord = {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name,
    version: versionString("1.0.0"),
    manifest: manifestWithContributions(contributions),
    bundle: recordId({ marker: `bundle-for-${name}` }),
    build: recordId({ marker: `build-for-${name}` }),
  };
  await new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }).put("module", record);
}

function bundleFor(name: string, version: string): Uint8Array {
  return new TextEncoder().encode(`bundle for ${name}@${version}`);
}

/** Installs one module against a fold of the workspace as it stands before the install. */
async function install(repo: FixtureRepo, name: string, version: string, contributions: readonly ContributionEntry[]) {
  return installModule(
    name,
    versionString(version),
    manifestWithContributions(contributions),
    bundleFor(name, version),
    recordId({ marker: `build-for-${name}-${version}` }),
    new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }),
    blobStoreOf(repo.workspace),
    await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now })),
  );
}

const GREETS: ContributionEntry = pointEntry("greeter/greets", {
  input: GREETING_SCHEMA,
  output: { type: "string" },
  role: "invoke",
});

/** A contribution of this test's own, answering at `point`. */
function answeringAt(point: string, id: string): ContributionEntry {
  return { kind: point, id, version: versionString("1"), input: true, output: true, documentation: "d" };
}

describe("a point a module contributes", () => {
  it("resolves through the fold with the entry's id as its name and its declared operands and role", async () => {
    const repo = await trackedRepo();
    await writeModule(repo, "greeter", [
      pointEntry("greeter/greets", { input: GREETING_SCHEMA, output: { type: "string" }, role: "invoke" }),
    ]);
    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(pointFor("greeter/greets", index)).toEqual({
      name: "greeter/greets",
      input: GREETING_SCHEMA,
      output: { type: "string" },
      role: "invoke",
    });
  });

  it("resolves on every read of one index when its operands carry an $id", async () => {
    const repo = await trackedRepo();
    const input = { $id: "https://example.test/greeting-input", ...GREETING_SCHEMA };
    const output = { $id: "https://example.test/greeting-output", type: "string" };
    await writeModule(repo, "greeter", [pointEntry("greeter/greets", { input, output, role: "invoke" })]);
    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    const expected = { name: "greeter/greets", input, output, role: "invoke" };

    expect(pointFor("greeter/greets", index)).toEqual(expected);
    expect(pointFor("greeter/greets", index)).toEqual(expected);
  });

  it("resolves to nothing when neither the kernel table nor the fold holds its name", async () => {
    const repo = await trackedRepo();
    await writeModule(repo, "greeter", [pointEntry("greeter/greets", { input: true, output: true, role: "invoke" })]);
    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(pointFor("greeter/waves", index)).toBeUndefined();
  });
});

describe("a kernel point", () => {
  it("resolves from the table without the fold being read, even where the fold holds a malformed point", async () => {
    const repo = await trackedRepo();
    await writeModule(repo, "broken", [pointEntry("broken/p", { input: true, output: true })]);
    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(pointFor("rule", index)).toBe(kernelPoint("rule"));
    expect(() => pointFor("broken/p", index)).toThrow(PointRefusedError);
  });
});

describe("one point name declared twice", () => {
  it("is refused, naming the point and its one declaring module, when one manifest declares it at two versions", async () => {
    const repo = await trackedRepo();
    await writeModule(repo, "twice", [
      pointEntry("twice/p", { input: true, output: true, role: "invoke" }, "1"),
      pointEntry("twice/p", { input: true, output: true, role: "data" }, "2"),
    ]);
    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(() => readPointDeclarations(index)).toThrow(PointRefusedError);
    expect(() => readPointDeclarations(index)).toThrow(expect.objectContaining({ about: ["twice/p", "twice"] }));
  });

  it("is refused, naming the point and both declaring modules, when two modules whose names nest each declare it", async () => {
    const repo = await trackedRepo();
    await writeModule(repo, "a", [pointEntry("a/b/p", { input: true, output: true, role: "invoke" })]);
    await writeModule(repo, "a/b", [pointEntry("a/b/p", { input: true, output: true, role: "invoke" })]);
    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(() => readPointDeclarations(index)).toThrow(PointRefusedError);
    expect(() => readPointDeclarations(index)).toThrow(expect.objectContaining({ about: ["a/b/p", "a", "a/b"] }));
  });
});

describe("a malformed point declaration", () => {
  it("is refused by name when its input lacks the role", async () => {
    const repo = await trackedRepo();
    await writeModule(repo, "broken", [pointEntry("broken/p", { input: true, output: true })]);
    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(() => readPointDeclarations(index)).toThrow(PointRefusedError);
    expect(() => readPointDeclarations(index)).toThrow(/broken\/p/);
  });

  it("is refused by name when it declares a role outside the two the kernel closes", async () => {
    const repo = await trackedRepo();
    await writeModule(repo, "broken", [pointEntry("broken/p", { input: true, output: true, role: "stream" })]);
    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(() => readPointDeclarations(index)).toThrow(PointRefusedError);
    expect(() => readPointDeclarations(index)).toThrow(/broken\/p/);
  });

  it("is refused by name when an operand it declares is not a schema that compiles", async () => {
    const repo = await trackedRepo();
    await writeModule(repo, "broken", [pointEntry("broken/p", { input: 5, output: true, role: "invoke" })]);
    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(() => readPointDeclarations(index)).toThrow(PointRefusedError);
    expect(() => readPointDeclarations(index)).toThrow(/broken\/p/);
  });

  it("is refused by name when its own id carries whitespace", async () => {
    const repo = await trackedRepo();
    await writeModule(repo, "broken", [pointEntry("broken/p q", { input: true, output: true, role: "invoke" })]);
    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(() => readPointDeclarations(index)).toThrow(PointRefusedError);
    expect(() => readPointDeclarations(index)).toThrow(/broken\/p q.*must carry no whitespace/);
  });
});

describe("a contribution is installed after its point", () => {
  it("accepts a manifest declaring a point and a contribution answering at it in one install, whichever the manifest lists first", async () => {
    const repo = await trackedRepo();
    // A manifest lists its contributions sorted by id, so which comes first is decided by the ids.
    const contributionFirst = await install(repo, "greeter", "1.0.0", [
      answeringAt("greeter/greets", "greeter/answers"),
      GREETS,
    ]);
    const pointFirst = await install(repo, "waver", "1.0.0", [
      pointEntry("waver/greets", { input: true, output: true, role: "invoke" }),
      answeringAt("waver/greets", "waver/waves"),
    ]);

    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(index.installedModuleRecords().map((installed) => installed.id)).toEqual(
      expect.arrayContaining([contributionFirst.moduleRecordId, pointFirst.moduleRecordId]),
    );
    expect(pointFor("greeter/greets", index)?.role).toBe("invoke");
    expect(pointFor("waver/greets", index)?.role).toBe("invoke");
  });

  it("refuses a contribution whose point nothing declares, naming the module, the contribution and the point", async () => {
    const repo = await trackedRepo();
    const refusal = await install(repo, "greeter", "1.0.0", [answeringAt("greeter/greets", "greeter/answers")]).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(UnknownContributionPointError);
    expect((refusal as UnknownContributionPointError).about).toEqual(["greeter", "greeter/answers", "greeter/greets"]);
  });

  it("accepts a contribution answering at a point another installed module declares", async () => {
    const repo = await trackedRepo();
    await install(repo, "greeter", "1.0.0", [GREETS]);

    const result = await install(repo, "responder", "1.0.0", [answeringAt("greeter/greets", "responder/answers")]);

    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(index.installedModuleRecords().map((installed) => installed.id)).toContain(result.moduleRecordId);
  });

  it("refuses a manifest declaring one point id at two versions before anything is written", async () => {
    const repo = await trackedRepo();
    const refusal = await install(repo, "twice", "1.0.0", [
      pointEntry("twice/p", { input: true, output: true, role: "invoke" }, "1"),
      pointEntry("twice/p", { input: true, output: true, role: "data" }, "2"),
    ]).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(PointRefusedError);
    expect((refusal as PointRefusedError).about).toEqual(["twice/p", "twice"]);
    expect(
      (await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }))).installedModuleRecords(),
    ).toEqual([]);
    await expect(blobStoreOf(repo.workspace).read(rawId(bundleFor("twice", "1.0.0")))).rejects.toThrow(
      "blob not found",
    );
  });

  it("refuses a point another installed module whose name nests with the installing one's already declares, naming both modules", async () => {
    const repo = await trackedRepo();
    await install(repo, "a", "1.0.0", [pointEntry("a/b/p", { input: true, output: true, role: "invoke" })]);

    const refusal = await install(repo, "a/b", "1.0.0", [
      pointEntry("a/b/p", { input: true, output: true, role: "invoke" }),
    ]).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(PointRefusedError);
    expect((refusal as PointRefusedError).about).toEqual(["a/b/p", "a", "a/b"]);
  });

  it("refuses a manifest carrying a malformed point declaration before anything is written", async () => {
    const repo = await trackedRepo();
    const malformed = [
      { name: "roleless", operand: { input: true, output: true } },
      { name: "stray-role", operand: { input: true, output: true, role: "third" } },
    ];

    for (const { name, operand } of malformed) {
      const refusal = await install(repo, name, "1.0.0", [pointEntry(`${name}/p`, operand)]).catch(
        (error: unknown) => error,
      );

      expect({ name, refused: refusal instanceof PointRefusedError }).toEqual({ name, refused: true });
      await expect(blobStoreOf(repo.workspace).read(rawId(bundleFor(name, "1.0.0")))).rejects.toThrow("blob not found");
    }
    expect(
      (await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }))).installedModuleRecords(),
    ).toEqual([]);
  });

  it("refuses a manifest declaring a point whose own id carries whitespace before anything is written", async () => {
    const repo = await trackedRepo();
    const refusal = await install(repo, "broken", "1.0.0", [
      pointEntry("broken/p q", { input: true, output: true, role: "invoke" }),
    ]).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(PointRefusedError);
    await expect(blobStoreOf(repo.workspace).read(rawId(bundleFor("broken", "1.0.0")))).rejects.toThrow(
      "blob not found",
    );
    expect(
      (await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }))).installedModuleRecords(),
    ).toEqual([]);
  });

  it("accepts a re-pin of a module re-declaring its own point, which the re-pin replaces rather than duplicates", async () => {
    const repo = await trackedRepo();
    await install(repo, "greeter", "1.0.0", [GREETS]);

    const repinned = await install(repo, "greeter", "2.0.0", [GREETS]);

    const index = await foldedIndex(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(index.installedModuleRecords()).toEqual([
      { id: repinned.moduleRecordId, name: "greeter", version: "2.0.0" },
    ]);
    expect(pointFor("greeter/greets", index)?.name).toBe("greeter/greets");
  });
});

describe("both hosts check an exchange against the point they are handed, byte-identically", () => {
  let scratchDir: string;
  let modulePath: string;

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "musai-point-contribution-"));
    modulePath = join(scratchDir, "answers.rule.ts");
    await writeFile(
      modulePath,
      gatewaySource("invoke", '      return { kind: "verdict", label: "holds", reason: "ran" };'),
    );
  });

  afterAll(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  function contributionAt(kind: string, point: ContributionPoint): InvokedContribution {
    return {
      entry: { kind, id: "fixture/p", version: versionString("1"), input: true, output: true, documentation: "" },
      point,
    };
  }

  /** A request at `kind` with a rule's input shape: a rule's read-log is built before any check. */
  function requestAt(kind: string): EnvelopeRequest {
    return {
      protocol: ENVELOPE_PROTOCOL,
      contribution: kind,
      id: "fixture/p",
      version: versionString("1"),
      input: { claimId: "claim-a", conditions: {}, evidence: [] },
    };
  }

  async function bothResponses(request: EnvelopeRequest, contribution: InvokedContribution) {
    const inProcess = new InProcessHost();
    const subprocess = new SubprocessHost();
    try {
      const inProcessLoaded = await inProcess.load(modulePath, "invoke");
      const subprocessLoaded = await subprocess.load(modulePath, "invoke");
      const { response: inProcessResponse } = await inProcess.invoke(inProcessLoaded, request, contribution);
      const { response: subprocessResponse } = await subprocess.invoke(subprocessLoaded, request, contribution);
      return { inProcessResponse, subprocessResponse };
    } finally {
      await inProcess.close();
    }
  }

  it("refuses a data-role point with the unknown-contribution code, never running the module", async () => {
    const { inProcessResponse, subprocessResponse } = await bothResponses(
      requestAt("slot"),
      contributionAt("slot", kernelPoint("slot")!),
    );

    expect(subprocessResponse).toEqual(inProcessResponse);
    expect(inProcessResponse.ok).toBe(false);
    if (!inProcessResponse.ok) {
      expect(inProcessResponse.error.code).toBe("unknown-contribution");
      expect(inProcessResponse.error.data).toEqual({ id: "fixture/p", point: "slot", role: "data" });
    }
  });

  it("refuses a contributed data-role point exactly as it refuses a kernel one", async () => {
    const contributed: ContributionPoint = { name: "fixture/listing", input: true, output: true, role: "data" };
    const { inProcessResponse, subprocessResponse } = await bothResponses(
      requestAt("fixture/listing"),
      contributionAt("fixture/listing", contributed),
    );

    expect(subprocessResponse).toEqual(inProcessResponse);
    expect(inProcessResponse.ok).toBe(false);
    if (!inProcessResponse.ok) {
      expect(inProcessResponse.error.code).toBe("unknown-contribution");
    }
  });

  it("refuses a handed point that does not answer for the entry's own kind", async () => {
    const { inProcessResponse, subprocessResponse } = await bothResponses(
      requestAt("rule"),
      contributionAt("rule", kernelPoint("parser")!),
    );

    expect(subprocessResponse).toEqual(inProcessResponse);
    expect(inProcessResponse.ok).toBe(false);
    if (!inProcessResponse.ok) {
      expect(inProcessResponse.error.code).toBe("unknown-contribution");
      expect(inProcessResponse.error.data).toEqual({ id: "fixture/p", kind: "rule", point: "parser" });
    }
  });

  it("invokes a point whose operands and whose entry's schemas carry an $id more than once, answering every time", async () => {
    /** Fresh objects on every call, as the fold hands them back: equal schemas under one `$id`. */
    function declaredWithIds(): InvokedContribution {
      return {
        entry: {
          kind: "fixture/decides",
          id: "fixture/p",
          version: versionString("1"),
          input: { $id: "https://example.test/decides-entry-input", type: "object" },
          output: { $id: "https://example.test/decides-entry-output", type: "object" },
          documentation: "",
        },
        point: {
          name: "fixture/decides",
          input: { $id: "https://example.test/decides-input", type: "object" },
          output: { $id: "https://example.test/decides-output", type: "object", required: ["label"] },
          role: "invoke",
        },
      };
    }
    const answered = { ok: true, output: { kind: "verdict", label: "holds", reason: "ran" }, diagnostics: [] };

    for (let round = 0; round < 2; round++) {
      const { inProcessResponse, subprocessResponse } = await bothResponses(
        requestAt("fixture/decides"),
        declaredWithIds(),
      );
      expect({ round, inProcessResponse, subprocessResponse }).toEqual({
        round,
        inProcessResponse: answered,
        subprocessResponse: answered,
      });
    }
  });

  it("invokes a contributed invoke-role point through its declared operand", async () => {
    const contributed: ContributionPoint = {
      name: "fixture/decides",
      input: { type: "object" },
      output: { type: "object", required: ["label"] },
      role: "invoke",
    };
    const { inProcessResponse, subprocessResponse } = await bothResponses(
      requestAt("fixture/decides"),
      contributionAt("fixture/decides", contributed),
    );

    expect(subprocessResponse).toEqual(inProcessResponse);
    expect(inProcessResponse).toEqual({
      ok: true,
      output: { kind: "verdict", label: "holds", reason: "ran" },
      diagnostics: [],
    });
  });
});
