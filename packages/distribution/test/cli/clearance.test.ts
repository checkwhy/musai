import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationContext, type OperationDescriptor, runHandler } from "@musai/api-core";
import { renderProjection, renderRefusalProjection } from "@musai/cli";
import { exitCodeForClass, isKernelError } from "@musai/records";
import { MUSAI_DIR } from "@musai/store";
import { generateTestKey, type TestKey } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { claimStatus } from "../../src/ops/claim.js";
import { claimWhy } from "../../src/ops/why.js";
import {
  CANARY,
  emptyWorld,
  now,
  opensshAvailable,
  PUBLISHER,
  restingWorld,
  SCOPE,
  sealAndEvaluate,
  sealedClaim,
  slotOf,
  WRITER,
} from "../sealed-world.js";
import { type Answer, CLI_PATH } from "./signed-workspace.js";

/** Runs `musai --json` in `workspace` as the publisher at the world's instant, with `env` set. */
async function musai(workspace: string, args: readonly string[], env: Record<string, string> = {}): Promise<Answer> {
  const answered = await execa("node", [CLI_PATH, "--workspace", workspace, ...args, "--json"], {
    env: { MUSAI_PRINCIPAL: PUBLISHER, MUSAI_NOW: now(), ...env },
    stdin: "ignore",
    reject: false,
  });
  return { exitCode: answered.exitCode ?? -1, stdout: answered.stdout, stderr: answered.stderr };
}

/** What the CLI would print for `descriptor` run in-process under `context`, refusals included. */
async function inProcess(
  descriptor: OperationDescriptor,
  input: Record<string, unknown>,
  context: OperationContext,
): Promise<Answer> {
  try {
    const output = await runHandler(descriptor, input, context);
    return { exitCode: descriptor.exitCode(output), stdout: renderProjection(descriptor, output, true), stderr: "" };
  } catch (error) {
    if (!isKernelError(error)) {
      throw error;
    }
    return { exitCode: exitCodeForClass(error.code), stdout: "", stderr: renderRefusalProjection(error, true) };
  }
}

describe.skipIf(!opensshAvailable)("the CLI launched under MUSAI_CLEARANCE", () => {
  let key: TestKey;
  const scratch: string[] = [];

  beforeAll(async () => {
    key = await generateTestKey(PUBLISHER);
  }, 60_000);

  afterAll(async () => {
    await rm(key.dir, { recursive: true, force: true });
    for (const dir of scratch) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("answers status and why as a workspace opened under that clearance does", async () => {
    const world = await restingWorld(key, scratch);
    await sealAndEvaluate(world);
    await sealedClaim(world);
    const station: OperationContext = { ...world.station, mode: "plan" };
    const asked = [slotOf("rests-on"), slotOf("hidden")].flatMap((claim) => [
      { args: ["status", claim, "--plan"], descriptor: claimStatus, input: { claim } },
      { args: ["why", claim, "--full"], descriptor: claimWhy, input: { claim, full: true } },
    ]);

    for (const { args, descriptor, input } of asked) {
      const answered = await musai(world.workspace, args, { MUSAI_CLEARANCE: WRITER });

      expect(answered, args.join(" ")).toEqual(await inProcess(descriptor as OperationDescriptor, input, station));
      expect(answered.stdout + answered.stderr).not.toContain(CANARY);
    }
    const authors = await musai(world.workspace, ["why", slotOf("hidden"), "--full"]);
    expect(authors.stdout).toContain(CANARY);
  }, 240_000);

  test("refuses to render a file it is handed by path, though the author renders it", async () => {
    const world = await restingWorld(key, scratch);
    await sealAndEvaluate(world);
    await sealedClaim(world);
    const fold = join(world.workspace, MUSAI_DIR, "local", "scopes", SCOPE, "index.sqlite");

    const refused = await musai(world.workspace, ["render", "--file", fold], { MUSAI_CLEARANCE: WRITER });

    expect(refused.exitCode).toBe(2);
    expect(refused.stdout).toBe("");
    expect(JSON.parse(refused.stderr)).toMatchObject({ reason: "invalid-input" });
    expect(refused.stderr).toContain(WRITER);
    expect(refused.stderr).not.toContain(CANARY);
    const rendered = await musai(world.workspace, ["render", "--file", fold]);
    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).toContain(CANARY);
  }, 240_000);

  test("refuses an --input file before opening it, so a missing file and a readable one are refused alike", async () => {
    const world = await emptyWorld(key, scratch);
    const files = await mkdtemp(join(tmpdir(), "musai-cli-clearance-input-"));
    scratch.push(files);
    const notJson = join(files, "not-json");
    const json = join(files, "payload.json");
    await writeFile(notJson, "not json");
    await writeFile(json, JSON.stringify({ transcript_path: notJson }));

    const answers = [];
    for (const file of [join(files, "missing"), notJson, json]) {
      answers.push(await musai(world.workspace, ["lab", "hook", "stop", "--input", file], { MUSAI_CLEARANCE: WRITER }));
    }

    for (const answered of answers) {
      expect(answered.exitCode).toBe(2);
      expect(answered.stdout).toBe("");
      expect(JSON.parse(answered.stderr)).toMatchObject({ reason: "invalid-input" });
      expect(answered.stderr).toContain(WRITER);
    }
    expect(new Set(answers.map((answered) => answered.stderr)).size).toBe(1);
  }, 120_000);

  test.each([
    ["one its workspace does not declare", "readers"],
    ["one that is no audience", "Not An Audience"],
    ["an empty one", ""],
  ])(
    "refuses a clearance naming %s, exiting 2 before the verb does anything",
    async (_, clearance) => {
      const world = await emptyWorld(key, scratch);
      const files = await mkdtemp(join(tmpdir(), "musai-cli-clearance-"));
      scratch.push(files);
      const module = join(files, "module");

      const answered = await musai(world.workspace, ["--events", "lab", "module", "new", module], {
        MUSAI_CLEARANCE: clearance,
      });

      expect(answered.exitCode).toBe(2);
      expect(answered.stdout).toBe("");
      expect(JSON.parse(answered.stderr)).toMatchObject({ reason: "invalid-input" });
      expect(answered.stderr).toContain(clearance === "" ? "MUSAI_CLEARANCE" : clearance);
      await expect(access(module)).rejects.toThrow();
    },
    120_000,
  );
});
