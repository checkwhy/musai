import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationContext, runHandler } from "@musai/api-core";
import { gitRevParse, initWorkspace, MUSAI_DIR, readTrustBranch, writeMainFiles } from "@musai/store";
import { fixedClock } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configGet, configSet, configUnset } from "../src/ops/config.js";

const now = fixedClock("2026-10-12T00:00:00.000Z");
const DIGEST = `registry.example/station@sha256:${"a".repeat(64)}`;

describe("config.get@1, config.set@1 and config.unset@1 on the trust branch's configuration", () => {
  let workspace: string;
  let context: OperationContext;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-config-"));
    await initWorkspace(workspace, { now });
    context = { workspace, scope: "default", now, principalName: "operator", via: "tty" };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const gitDir = () => ({ gitDir: join(workspace, MUSAI_DIR) });
  const values = async () => (await readTrustBranch(gitDir())).config.values;
  const tip = () => gitRevParse(gitDir(), "refs/heads/main");

  test("a value set is the value got, in a new commit on the trust branch", async () => {
    const before = await tip();

    await runHandler(configSet, { key: "station.image", value: DIGEST }, context);

    expect(await runHandler(configGet, { key: "station.image" }, context)).toEqual({
      key: "station.image",
      value: DIGEST,
    });
    expect(await tip()).not.toBe(before);
  });

  test("a structured value is read as JSON and a bare word as text", async () => {
    await runHandler(configSet, { key: "tools", value: '["sh","node"]' }, context);
    await runHandler(configSet, { key: "signing", value: "person" }, context);

    expect(await values()).toMatchObject({ tools: ["sh", "node"], signing: "person" });
  });

  test("a key never set reads as null", async () => {
    expect(await runHandler(configGet, { key: "station.image" }, context)).toEqual({
      key: "station.image",
      value: null,
    });
  });

  test("a station image that is not a digest reference is refused, and nothing is written", async () => {
    const before = await tip();

    const refusal = await runHandler(
      configSet,
      { key: "station.image", value: "registry.example/station:latest" },
      context,
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "invalid-input", about: ["station.image"] });
    expect(await tip()).toBe(before);
  });

  test("a tools list naming a path is refused, and nothing is written", async () => {
    const before = await tip();

    const refusal = await runHandler(configSet, { key: "tools", value: '["/bin/sh"]' }, context).catch(
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ reason: "invalid-input", about: ["tools"] });
    expect(await tip()).toBe(before);
  });

  test("an unknown key is refused, naming the keys that are known", async () => {
    const before = await tip();

    const refusal = await runHandler(configSet, { key: "station.imag", value: DIGEST }, context).catch(
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ reason: "invalid-input", about: ["station.imag"] });
    expect((refusal as Error).message).toContain("station.image");
    expect((refusal as Error).message).toContain("tools");
    expect(await tip()).toBe(before);
  });

  test("a model's relay cannot set a value, and nothing is written", async () => {
    const before = await tip();

    const refusal = await runHandler(configSet, { key: "tools", value: '["sh"]' }, { ...context, via: "model" }).catch(
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ reason: "not-authorised", about: ["config.set@1", "model"] });
    expect(await tip()).toBe(before);
  });

  test("a script's shell cannot set a value, the refusal naming the channel and sending the caller to a terminal", async () => {
    const before = await tip();

    const refusal = await runHandler(
      configSet,
      { key: "floor", value: '{"verdict":"holds"}' },
      {
        ...context,
        via: "process",
      },
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "not-authorised", about: ["config.set@1", "process"] });
    expect((refusal as Error).message).toContain("through process");
    expect((refusal as Error).message).toContain("run it from a terminal");
    expect(await tip()).toBe(before);
  });

  test("a context naming no channel cannot set a value, and nothing is written", async () => {
    const before = await tip();
    const { via: _via, ...unestablished } = context;

    const refusal = await runHandler(configSet, { key: "signing", value: "off" }, unestablished).catch(
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ reason: "not-authorised", about: ["config.set@1", "no channel"] });
    expect(await tip()).toBe(before);
  });

  test("a malformed floor is repaired by setting it, though the workspace will not open", async () => {
    await writeMainFiles(gitDir(), { "config.json": `${JSON.stringify({ floor: { verdict: "hold" } })}\n` }, now);

    await runHandler(configSet, { key: "floor", value: '{"verdict":"holds"}' }, context);

    expect((await values())["floor"]).toEqual({ verdict: "holds" });
  });

  test("a threshold no double holds exactly is refused, and nothing is written", async () => {
    const before = await tip();

    const refusal = await runHandler(configSet, { key: "blob.threshold", value: "1e300" }, context).catch(
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ reason: "invalid-input", about: ["blob.threshold"] });
    expect(await tip()).toBe(before);
  });

  test("a principal without configure-floor cannot set a value, and nothing is written", async () => {
    await writeMainFiles(gitDir(), { roles: "someone-else owner any\n" }, now);
    const before = await tip();

    const refusal = await runHandler(configSet, { key: "tools", value: '["sh"]' }, context).catch(
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ reason: "not-authorised" });
    expect(await tip()).toBe(before);
  });

  test("a call in plan mode validates and writes nothing", async () => {
    const before = await tip();

    const planned = await runHandler(configSet, { key: "tools", value: '["sh"]' }, { ...context, mode: "plan" });

    expect(planned).toEqual({ key: "tools", value: ["sh"] });
    expect(await tip()).toBe(before);
  });

  test("a value set keeps every other key of the file", async () => {
    await writeMainFiles(gitDir(), { "config.json": `${JSON.stringify({ signing: "all", other: 1 })}\n` }, now);

    await runHandler(configSet, { key: "tools", value: '["sh"]' }, context);

    expect(await values()).toEqual({ signing: "all", other: 1, tools: ["sh"] });
  });

  test("two values set at once both land", async () => {
    await Promise.all([
      runHandler(configSet, { key: "tools", value: '["sh"]' }, context),
      runHandler(configSet, { key: "signing", value: "person" }, context),
      runHandler(configSet, { key: "station.image", value: DIGEST }, context),
    ]);

    expect(await values()).toEqual({ tools: ["sh"], signing: "person", "station.image": DIGEST });
  });

  test("a key unset reads as null, in a new commit that keeps every other key", async () => {
    await runHandler(configSet, { key: "signing", value: "person" }, context);
    await runHandler(configSet, { key: "floor", value: '{"verdict":"holds"}' }, context);
    const before = await tip();

    const unset = await runHandler(configUnset, { key: "floor" }, context);

    expect(unset).toEqual({ key: "floor", value: null });
    expect(await runHandler(configGet, { key: "floor" }, context)).toEqual({ key: "floor", value: null });
    expect((await values())["signing"]).toBe("person");
    expect(await tip()).not.toBe(before);
  });

  test("unsetting a key that is not set writes nothing", async () => {
    const before = await tip();

    const unset = await runHandler(configUnset, { key: "station.image" }, context);

    expect(unset).toEqual({ key: "station.image", value: null });
    expect(await tip()).toBe(before);
  });

  test("a relayed or unestablished channel cannot unset a key, and nothing is written", async () => {
    await runHandler(configSet, { key: "signing", value: "person" }, context);
    const before = await tip();
    const { via: _via, ...unestablished } = context;

    const relayed = await runHandler(configUnset, { key: "signing" }, { ...context, via: "model" }).catch(
      (error: unknown) => error,
    );
    const bare = await runHandler(configUnset, { key: "signing" }, unestablished).catch((error: unknown) => error);

    expect(relayed).toMatchObject({ reason: "not-authorised", about: ["config.unset@1", "model"] });
    expect((relayed as Error).message).toContain("run it from a terminal");
    expect(bare).toMatchObject({ reason: "not-authorised", about: ["config.unset@1", "no channel"] });
    expect(await tip()).toBe(before);
  });

  test("an unknown key cannot be unset, the refusal naming the keys that are known", async () => {
    const refusal = await runHandler(configUnset, { key: "station.imag" }, context).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "invalid-input", about: ["station.imag"] });
    expect((refusal as Error).message).toContain("station.image");
  });

  test("a principal without configure-floor cannot unset a key, and nothing is written", async () => {
    await runHandler(configSet, { key: "signing", value: "person" }, context);
    await writeMainFiles(gitDir(), { roles: "someone-else owner any\n" }, now);
    const before = await tip();

    const refusal = await runHandler(configUnset, { key: "signing" }, context).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "not-authorised" });
    expect(await tip()).toBe(before);
  });

  test("a call in plan mode removes nothing", async () => {
    await runHandler(configSet, { key: "signing", value: "person" }, context);
    const before = await tip();

    await runHandler(configUnset, { key: "signing" }, { ...context, mode: "plan" });

    expect(await tip()).toBe(before);
    expect((await values())["signing"]).toBe("person");
  });

  test("a malformed floor is removed by unsetting it, though the workspace will not open", async () => {
    await writeMainFiles(gitDir(), { "config.json": `${JSON.stringify({ floor: { verdict: "hold" } })}\n` }, now);

    await runHandler(configUnset, { key: "floor" }, context);

    expect(await values()).toEqual({});
  });
});
