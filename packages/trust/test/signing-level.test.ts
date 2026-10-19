import { readWorkspaceConfig } from "@musai/store";
import { type FixtureRepo, makeFixtureRepo, writeTrustFile } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { requireSignature, SIGNING_LEVEL_CONFIG_KEY, signingLevelOf } from "../src/level.js";

describe("the signing level is a slot on the trust branch", () => {
  let repo: FixtureRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  test("a fresh workspace's configuration declares no level, which reads as off", async () => {
    repo = await makeFixtureRepo("signing-level-default");
    const config = await readWorkspaceConfig(repo.ctx);
    expect(signingLevelOf(config)).toBe("off");
    expect(requireSignature(signingLevelOf(config), "person")).toBe(false);
  });

  test("person and all are read from the configuration at its pinned commit", async () => {
    repo = await makeFixtureRepo("signing-level-set");
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ [SIGNING_LEVEL_CONFIG_KEY]: "person" }));
    expect(signingLevelOf(await readWorkspaceConfig(repo.ctx))).toBe("person");
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ [SIGNING_LEVEL_CONFIG_KEY]: "all" }));
    expect(signingLevelOf(await readWorkspaceConfig(repo.ctx))).toBe("all");
  });

  test("a level outside the three is refused, naming the value and the commit it was read at", async () => {
    repo = await makeFixtureRepo("signing-level-unknown");
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ [SIGNING_LEVEL_CONFIG_KEY]: "sometimes" }));
    const config = await readWorkspaceConfig(repo.ctx);
    expect(() => signingLevelOf(config)).toThrow(`"sometimes"`);
    expect(() => signingLevelOf(config)).toThrow(config.commit);
  });
});
