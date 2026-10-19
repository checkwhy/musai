import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandler } from "@musai/api-core";
import { canonicalBytes } from "@musai/records";
import { secretObservation } from "@musai/run";
import { initWorkspace, LOCAL_DIR, MUSAI_DIR, readKeyFile, type WorkspaceKey } from "@musai/store";
import { fixedClock } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { keyList, keyRotate } from "../src/ops/key.js";

const KNOWN_SECRET_VALUE = "definitely-not-supposed-to-leak-9e21b0";
const INSTANT = "2026-01-01T00:00:00.000Z";
const now = fixedClock(INSTANT);

describe("key.list@1 and key.rotate@1", () => {
  let workspace: string;
  const scope = "default";

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-key-"));
    await initWorkspace(workspace, { now });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function ctx() {
    return { workspace, scope, now };
  }

  function localDir(): string {
    return join(workspace, MUSAI_DIR, LOCAL_DIR);
  }

  function keyFilePath(): string {
    return join(localDir(), "keys.json");
  }

  test("key.list@1 on a workspace with no key yet reports none, rather than refusing", async () => {
    const output = await runHandler(keyList, {}, ctx());
    expect(output.keys).toEqual([]);
  });

  test("key.rotate@1 on a keyless workspace mints the first key rather than failing", async () => {
    const output = await runHandler(keyRotate, {}, ctx());
    expect(output.id).toBeTruthy();
    const listed = await runHandler(keyList, {}, ctx());
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]).toEqual({ id: output.id, createdAt: listed.keys[0]!.createdAt, current: true });
  });

  test("two rotations produce two distinct ids and leave both prior keys retained, never deleted", async () => {
    const first = await runHandler(keyRotate, {}, ctx());
    const second = await runHandler(keyRotate, {}, ctx());
    const third = await runHandler(keyRotate, {}, ctx());
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);

    const listed = await runHandler(keyList, {}, ctx());
    expect(listed.keys).toHaveLength(3);
    const byId = new Map(listed.keys.map((key) => [key.id, key]));
    expect(byId.get(first.id)?.current).toBe(false);
    expect(byId.get(second.id)?.current).toBe(false);
    expect(byId.get(third.id)?.current).toBe(true);
  });

  test("a rotation retiring a key stamps its successor's createdAt from the clock its context hands it", async () => {
    // The first rotation mints the key file; only the second has a current key to retire.
    await runHandler(keyRotate, {}, ctx());
    const rotated = await runHandler(keyRotate, {}, ctx());
    const listed = await runHandler(keyList, {}, ctx());
    expect(listed.keys.find((key) => key.id === rotated.id)?.createdAt).toBe(INSTANT);
  });

  test("a secret hashed before a rotation still verifies by its recorded key id afterwards, and a secret hashed after carries the new key's id", async () => {
    const minted = await runHandler(keyRotate, {}, ctx());
    const beforeFile = await readKeyFile(localDir());
    const originalKey = beforeFile.keys.find((key) => key.id === minted.id)!;
    const observationBefore = secretObservation(originalKey, "MY_SECRET", KNOWN_SECRET_VALUE);
    expect(observationBefore.keyId).toBe(minted.id);

    await runHandler(keyRotate, {}, ctx());

    const afterFile = await readKeyFile(localDir());
    const retainedKey = afterFile.keys.find((key) => key.id === minted.id) as WorkspaceKey;
    expect(retainedKey).toBeDefined();
    expect(retainedKey.status).toBe("retired");
    const observationAfterRetirement = secretObservation(retainedKey, "MY_SECRET", KNOWN_SECRET_VALUE);
    expect(observationAfterRetirement.keyedHash).toBe(observationBefore.keyedHash);

    const currentKeyNow = afterFile.keys.find((key) => key.status === "current") as WorkspaceKey;
    const observationNow = secretObservation(currentKeyNow, "MY_SECRET", KNOWN_SECRET_VALUE);
    expect(observationNow.keyId).not.toBe(observationBefore.keyId);
    expect(observationNow.keyedHash).not.toBe(observationBefore.keyedHash);
  });

  test("the key file's mode is owner-only after key.rotate@1 and stays so after key.list@1", async () => {
    await runHandler(keyRotate, {}, ctx());
    const afterRotate = await stat(keyFilePath());
    expect(afterRotate.mode & 0o777).toBe(0o600);

    await runHandler(keyList, {}, ctx());
    const afterList = await stat(keyFilePath());
    expect(afterList.mode & 0o777).toBe(0o600);
  });

  test("neither operation's output, in text or under the JSON flag, contains key material", async () => {
    await runHandler(keyRotate, {}, ctx());
    await runHandler(keyRotate, {}, ctx());
    const file = await readKeyFile(localDir());
    const materials = file.keys.map((key) => key.material);
    expect(materials.length).toBeGreaterThan(0);

    const listOutput = await runHandler(keyList, {}, ctx());
    const listBytes = new TextDecoder().decode(canonicalBytes(listOutput));
    const listText = keyList.renderText(listOutput);

    const rotateOutput = await runHandler(keyRotate, {}, ctx());
    const rotateBytes = new TextDecoder().decode(canonicalBytes(rotateOutput));
    const rotateText = keyRotate.renderText(rotateOutput);

    for (const material of materials) {
      expect(listBytes).not.toContain(material);
      expect(listText).not.toContain(material);
      expect(rotateBytes).not.toContain(material);
      expect(rotateText).not.toContain(material);
    }
  });
});
