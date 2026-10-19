import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { IndexDb } from "@musai/fold";
import type { ClaimRecord, RunRecord } from "@musai/records";
import {
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  idFromPath,
  recordId,
  recordPath,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { gitCatFile, gitRevParse, Store, scopeRefName } from "@musai/store";
import { type FixtureRepo, makeFixtureRepo, writeFixtureRecords } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type DerivationNode, renderJson, renderText } from "../src/why/render.js";

async function systemSha256(filePath: string): Promise<string> {
  try {
    const { stdout } = await execa("sha256sum", [filePath]);
    return stdout.trim().split(/\s+/)[0]!;
  } catch {
    const { stdout } = await execa("shasum", ["-a", "256", filePath]);
    return stdout.trim().split(/\s+/)[0]!;
  }
}

describe("canonical form and identity", () => {
  test("canonical bytes are independent of key order", () => {
    const original = { rendering: "a claim", about: ["urn:example:one"] };
    const permuted = { about: ["urn:example:one"], rendering: "a claim" };
    expect(canonicalBytes(permuted)).toEqual(canonicalBytes(original));
    expect(recordId(permuted)).toBe(recordId(original));
  });

  test("recordId is shaped sha256:<64 lowercase hex>, and idFromPath inverts recordPath", () => {
    const id = recordId({ some: "value" });
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    const path = recordPath("claim", id);
    expect(idFromPath(path)).toBe(id);
  });
});

describe("why renders the derivation as a text tree and as the same tree in json", () => {
  const tree: DerivationNode = {
    hop: { label: "claim", id: "tracer-claim", decidedBy: "receipt", beat: null },
    children: [
      {
        hop: { label: "evidence", id: "sha256:aa#result", decidedBy: "receipt", beat: null },
        children: [{ hop: { label: "run", id: "sha256:aa", decidedBy: "run", beat: null }, children: [] }],
      },
    ],
  };

  test("renderText prints one hop per line with strictly increasing indentation", () => {
    const lines = renderText(tree).split("\n");
    expect(lines).toHaveLength(3);
    const indentWidths = lines.map((line) => line.length - line.trimStart().length);
    expect(indentWidths[1]!).toBeGreaterThan(indentWidths[0]!);
    expect(indentWidths[2]!).toBeGreaterThan(indentWidths[1]!);
    expect(lines[2]).toContain("run");
    expect(lines[2]).toContain("sha256:aa");
  });

  test("renderJson prints the same tree as structured data", () => {
    const json = renderJson(tree);
    expect(json.label).toBe("claim");
    expect(json.children[0]!.label).toBe("evidence");
    expect(json.children[0]!.children[0]!.label).toBe("run");
    expect(json.children[0]!.children[0]!.children).toHaveLength(0);
  });
});

describe("one claim, end to end against a real fixture repository", () => {
  const CLAIM_TYPE = "musai.demo/claim@1";
  const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
  const CLAIM_CONDITIONS = { id: "tracer-claim" };

  let repo: FixtureRepo;
  let runId: string;
  let claimId: string;
  let tip: string;
  let slot: string;

  const runValue: RunRecord = {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    determinism: "nondeterministic",
    performer: RUNNER_PERFORMER,
    recipe: {
      command: ["true"],
      workingDirectory: "/work",
      environment: {},
      declared: [],
      substrates: [],
      isolation: "hygiene",
    },
    observation: {
      resolved: [],
      isolationHeld: "hygiene",
      binaries: [],
      bindings: [],
      output: "ok",
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: timestamp("2026-01-01T00:00:00.000Z"),
      finishedAt: timestamp("2026-01-01T00:00:00.000Z"),
      reads: [],
      cost: {},
    },
  };

  beforeAll(async () => {
    slot = slotFor(CLAIM_DECLARATION, CLAIM_CONDITIONS);

    repo = await makeFixtureRepo("tracer", [CLAIM_DECLARATION]);

    // The scope already holds one commit, the fixture's seeded claim-type module.
    const beforeTip = await gitRevParse(repo.ctx, scopeRefName(repo.scope));
    expect(beforeTip).not.toBeNull();

    const predictedRunId = recordId(runValue);
    const evidenceItemId = recordId({ run: predictedRunId, key: "exit-code" });
    const claimValue: ClaimRecord = {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: CLAIM_TYPE,
      about: ["urn:example:tracer"],
      slot,
      conditions: CLAIM_CONDITIONS,
      canonical: { statement: "the tracer path works end to end" },
      rendering: "The tracer path works end to end.",
      evidence: [
        {
          run: predictedRunId as `sha256:${string}`,
          selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key: "exit-code" },
          item: evidenceItemId,
        },
      ],
      exclusiveGroup: null,
    };

    const ids = await writeFixtureRecords(repo, [
      { kind: "run", value: runValue },
      { kind: "claim", value: claimValue },
    ]);
    runId = ids[0]!;
    claimId = ids[1]!;
    expect(runId).toBe(predictedRunId);

    const afterTip = await gitRevParse(repo.ctx, scopeRefName(repo.scope));
    expect(afterTip).not.toBeNull();
    tip = afterTip!;
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("the fixture repository is bare and no working tree was ever checked out", async () => {
    const { stdout } = await execa("git", ["--git-dir", repo.ctx.gitDir, "rev-parse", "--is-bare-repository"]);
    expect(stdout.trim()).toBe("true");
  });

  test("both records are readable at their sharded paths under the one commit that wrote them", async () => {
    const runPath = recordPath("run", runId as `sha256:${string}`);
    const claimPath = recordPath("claim", claimId as `sha256:${string}`);

    const runBytes = await gitCatFile(repo.ctx, `${tip}:${runPath}`);
    const claimBytes = await gitCatFile(repo.ctx, `${tip}:${claimPath}`);

    expect(runBytes).toEqual(Buffer.from(canonicalBytes(runValue)));
    expect(new TextDecoder().decode(claimBytes)).toContain(`"slot":"${slot}"`);
  });

  test("sha256sum on the extracted record file reproduces the id in its own path, with no Musai code in the check", async () => {
    const runPath = recordPath("run", runId as `sha256:${string}`);
    const bytes = await gitCatFile(repo.ctx, `${tip}:${runPath}`);

    const extractedPath = join(repo.workspace, runPath);
    await mkdir(dirname(extractedPath), { recursive: true });
    await writeFile(extractedPath, bytes);

    const digest = await systemSha256(extractedPath);
    const hexInPath = runId.slice("sha256:".length);
    expect(digest).toBe(hexInPath);
  });

  test("the index answers the claim at its slot and its evidence edges, with a watermark equal to the tip", async () => {
    const index = new IndexDb();
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    const indexed = index.claimAtSlot(slot);
    expect(indexed?.id).toBe(claimId);
    expect(indexed?.type).toBe(CLAIM_TYPE);

    const edges = index.evidenceEdgesOf(slot);
    expect(edges).toEqual([
      {
        run: runId,
        selector: { module: "musai.core", parser: "exit-code", version: "1", key: "exit-code" },
        item: recordId({ run: runId, key: "exit-code" }),
      },
    ]);

    expect(index.watermark()).toBe(tip);
  });
});
