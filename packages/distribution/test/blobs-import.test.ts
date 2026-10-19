import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationContext, runHandler } from "@musai/api-core";
import { hexOfRecordId, rawId } from "@musai/records";
import { initWorkspace } from "@musai/store";
import { blobStoreOf, fixedClock } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { blobImport } from "../src/ops/blobs.js";

const now = fixedClock("2026-10-02T00:00:00.000Z");

async function writeBlobFile(dir: string, bytes: Uint8Array, hex = hexOfRecordId(rawId(bytes))): Promise<void> {
  await mkdir(join(dir, hex.slice(0, 2)), { recursive: true });
  await writeFile(join(dir, hex.slice(0, 2), hex), bytes);
}

describe("blobs import: a directory store moved onto the store's blobs branch", () => {
  let workspace: string;
  let context: OperationContext;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-blobs-import-"));
    await initWorkspace(workspace, { now });
    context = { workspace, scope: "default", now, principalName: "operator" };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("importing a blob directory puts each blob on the branch, and counts the ones already there", async () => {
    const first = new TextEncoder().encode("a bundle the ledger committed");
    const second = new TextEncoder().encode("another bundle");
    await writeBlobFile(join(workspace, "blobs"), first);
    await writeBlobFile(join(workspace, "blobs"), second);
    await blobStoreOf(workspace).put(second);

    const output = await runHandler(blobImport, { dir: "blobs" }, context);

    expect(output).toEqual({ put: 1, held: 1 });
    expect(Buffer.from(await blobStoreOf(workspace).read(rawId(first)))).toEqual(Buffer.from(first));
  });

  test("a planned import counts what it would put and puts nothing", async () => {
    const bytes = new TextEncoder().encode("a bundle an import only plans");
    await writeBlobFile(join(workspace, "blobs"), bytes);

    const output = await runHandler(blobImport, { dir: "blobs" }, { ...context, mode: "plan" });

    expect(output).toEqual({ put: 1, held: 0 });
    await expect(blobStoreOf(workspace).read(rawId(bytes))).rejects.toMatchObject({ reason: "no-such-record" });
  });

  test("an import refuses a file whose bytes do not digest to its name and puts none", async () => {
    const sound = new TextEncoder().encode("a sound bundle");
    await writeBlobFile(join(workspace, "blobs"), sound);
    await writeBlobFile(join(workspace, "blobs"), new TextEncoder().encode("swapped"), "cd".repeat(32));

    const refusal = await runHandler(blobImport, { dir: "blobs" }, context).then(
      () => expect.unreachable("an import with a swapped file was accepted"),
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ reason: "invalid-input" });
    expect((refusal as Error).message).toContain(join(workspace, "blobs", "cd", "cd".repeat(32)));
    await expect(blobStoreOf(workspace).read(rawId(sound))).rejects.toMatchObject({ reason: "no-such-record" });
  });
});
