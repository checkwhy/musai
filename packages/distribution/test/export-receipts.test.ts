import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationContext, runHandler } from "@musai/api-core";
import { type Checkout, fixedClock, generateTestKey, makeCheckout, type TestKey } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { untarGz } from "../src/export/untar.js";
import { checkRun } from "../src/ops/check.js";
import { bundleExport } from "../src/ops/export.js";
import { claimWhy } from "../src/ops/why.js";
import { workspaceInit } from "../src/ops/workspace.js";

const scope = "default";
const now = fixedClock("2026-10-05T00:00:00.000Z");
const STATEMENT = "the tracked file says hello";
const TRACKED_IS_HELLO = ["node", "-e", "process.exit(require('fs').readFileSync('tracked.txt','utf8')==='hello'?0:1)"];

interface Bundle {
  readonly runs: readonly string[];
  readonly releasedRecords: readonly string[];
}

function bundleOf(bytes: Uint8Array): Bundle {
  const files = untarGz(bytes);
  const decoded = (path: string) => JSON.parse(new TextDecoder().decode(files.get(path)));
  const paths = [...files.keys()].filter((path) => path.endsWith(".json") && path.startsWith("records/"));
  const idOf = (path: string) => `sha256:${path.slice(-69, -5)}`;
  return {
    runs: paths.filter((path) => path.startsWith("records/run/")).map(idOf),
    releasedRecords: paths
      .filter((path) => path.startsWith("records/attestation/"))
      .map(decoded)
      .filter((record) => record.purpose === "released" && record.extent === "record")
      .map((record) => record.subject),
  };
}

describe("an export of a check claim carries the receipts it rests on", () => {
  let key: TestKey;
  let scratch: string;
  let checkout: Checkout;
  let context: OperationContext;

  beforeAll(async () => {
    key = await generateTestKey("operator");
    scratch = await mkdtemp(join(tmpdir(), "musai-export-receipts-"));
    checkout = await makeCheckout("hello");
    context = { workspace: checkout.dir, scope, now, principalName: key.name, via: "signature" };
    await runHandler(workspaceInit, { workspace: checkout.dir, key: key.keyPath }, context);
  }, 60_000);

  afterAll(async () => {
    await rm(key.dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
    await checkout.cleanup();
  });

  test("carries the run that decides the claim, under a record release of its own, and no run of another tree", async () => {
    await runHandler(checkRun, { statement: STATEMENT, command: TRACKED_IS_HELLO }, context);
    await writeFile(join(checkout.dir, "tracked.txt"), "goodbye");
    const failing = await runHandler(claimWhy, { claim: STATEMENT }, context);
    await writeFile(join(checkout.dir, "tracked.txt"), "hello");
    const holding = await runHandler(checkRun, { statement: STATEMENT, command: TRACKED_IS_HELLO }, context);
    const decisive = (await runHandler(claimWhy, { claim: STATEMENT }, { ...context, mode: "plan" })).runs[0]!.id;

    const out = join(scratch, "receipts.tar.gz");
    await runHandler(bundleExport, { id: holding.claim, to: "public", out, key: key.keyPath }, context);
    const bundle = bundleOf(new Uint8Array(await readFile(out)));

    expect(failing.label).toBe("fails");
    expect(bundle.runs).toContain(decisive);
    expect(bundle.runs).not.toContain(failing.runs[0]!.id);
    expect(bundle.releasedRecords).toContain(decisive);
  }, 300_000);

  test("carries no path of the sender's machine in any member", async () => {
    const checked = await runHandler(checkRun, { statement: STATEMENT, command: TRACKED_IS_HELLO }, context);
    const out = join(scratch, "paths.tar.gz");
    await runHandler(bundleExport, { id: checked.claim, to: "public", out, key: key.keyPath }, context);
    const members = [...untarGz(new Uint8Array(await readFile(out))).entries()];

    for (const [path, bytes] of members) {
      const text = new TextDecoder().decode(bytes);
      expect(text, path).not.toContain(checkout.dir);
      expect(text, path).not.toContain(homedir());
    }
  }, 300_000);
});
