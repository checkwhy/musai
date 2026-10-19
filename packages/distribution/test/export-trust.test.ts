import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationContext, runHandler } from "@musai/api-core";
import { gitCatFile, MUSAI_DIR } from "@musai/store";
import {
  type Checkout,
  fixedClock,
  generateTestKey,
  makeCheckout,
  type TestKey,
  writeTrustFile,
} from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { untarGz } from "../src/export/untar.js";
import { checkRun } from "../src/ops/check.js";
import { bundleExport } from "../src/ops/export.js";
import { workspaceInit } from "../src/ops/workspace.js";

const STRANGER = "stranger@example.test";
const STRANGER_IDENTITY = "identity:https://idp.example.test#stranger";
const TRACKED_IS_HELLO = ["node", "-e", "process.exit(require('fs').readFileSync('tracked.txt','utf8')==='hello'?0:1)"];

describe("an export's trust files name only who signed what it carries", () => {
  let key: TestKey;
  let stranger: TestKey;
  let scratch: string;
  let checkout: Checkout;
  let context: OperationContext;

  beforeAll(async () => {
    key = await generateTestKey("operator");
    stranger = await generateTestKey(STRANGER);
    scratch = await mkdtemp(join(tmpdir(), "musai-export-trust-"));
    checkout = await makeCheckout("hello");
    const now = fixedClock("2026-10-06T00:00:00.000Z");
    context = { workspace: checkout.dir, scope: "default", now, principalName: key.name, via: "signature" };
    await runHandler(workspaceInit, { workspace: checkout.dir, key: key.keyPath }, context);
    const ctx = { gitDir: join(checkout.dir, MUSAI_DIR) };
    const read = async (name: string) => new TextDecoder().decode(await gitCatFile(ctx, `main:${name}`));
    await writeTrustFile(
      ctx,
      "allowed-signers",
      `${await read("allowed-signers")}${STRANGER} ${stranger.pubKeyLine}\n`,
    );
    await writeTrustFile(ctx, "roles", `${await read("roles")}${STRANGER} maintainer any\n`);
    await writeTrustFile(ctx, "audiences", `friends member ${STRANGER_IDENTITY}\n`);
  }, 60_000);

  afterAll(async () => {
    await rm(key.dir, { recursive: true, force: true });
    await rm(stranger.dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
    await checkout.cleanup();
  });

  test("leaves out a principal who signed nothing in the bundle, and keeps the signer", async () => {
    const checked = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );
    const out = join(scratch, "trust.tar.gz");
    await runHandler(bundleExport, { id: checked.claim, to: "public", out, key: key.keyPath }, context);
    const files = untarGz(new Uint8Array(await readFile(out)));
    const text = (name: string) => new TextDecoder().decode(files.get(name) ?? new Uint8Array());

    expect(text("allowed-signers")).toContain(key.principal);
    expect(text("roles")).toContain(key.principal);
    expect(text("allowed-signers")).not.toContain(STRANGER);
    expect(text("roles")).not.toContain(STRANGER);
    expect(text("audiences")).not.toContain(STRANGER_IDENTITY);
  }, 300_000);
});
