import { rm } from "node:fs/promises";
import { CURRENT_SCHEMA_VERSIONS, recordId, sidecarPath, timestamp } from "@musai/records";
import { gitLsTree, gitRevParse, Store, scopeRefName } from "@musai/store";
import { type FixtureRepo, generateTestKey, makeFixtureRepo, type TestKey } from "@musai/test-support";
import { mintAttestation, signAttestation } from "@musai/trust";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RUNNER_PERFORMER } from "../src/performer.js";

describe("an attestation and its signature land in one commit", () => {
  let repo: FixtureRepo;
  let key: TestKey;

  beforeAll(async () => {
    repo = await makeFixtureRepo("sidecar");
    key = await generateTestKey("alice@example.com");
  });

  afterAll(async () => {
    await repo.cleanup();
    await rm(key.dir, { recursive: true, force: true });
  });

  test("a signed attestation is written with its sidecar beside it in the same commit, and the sidecar reads back verbatim", async () => {
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const attestation = mintAttestation({
      subject: recordId({ example: "a record someone stands behind" }),
      principal: key.principal,
      principalClass: "person",
      via: "signature",
      purpose: "asserted",
      at: timestamp("2026-01-01T00:00:00.000Z"),
    });
    const signature = await signAttestation({ attestation, keyPath: key.keyPath });

    const before = await gitRevParse(repo.ctx, scopeRefName(repo.scope));
    const [id] = await store.putMany([{ kind: "attestation", value: attestation.record, signature }]);
    const after = await gitRevParse(repo.ctx, scopeRefName(repo.scope));

    expect(id).toBe(attestation.id);
    expect(after).not.toBe(before);
    const paths = (await gitLsTree(repo.ctx, after!)).map((entry) => entry.path);
    expect(paths).toContain(sidecarPath(attestation.id));
    expect(await store.readSidecar(attestation.id)).toBe(signature);
  });

  test("an attestation written without a signature has no sidecar, and reading one answers null rather than failing", async () => {
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const attestation = mintAttestation({
      subject: recordId({ example: "an unsigned attestation's subject" }),
      principal: `key:SHA256:${"n".repeat(43)}`,
      principalClass: "agent",
      via: "model",
      purpose: "asserted",
      at: timestamp("2026-01-01T00:00:00.000Z"),
    });
    await store.putMany([{ kind: "attestation", value: attestation.record }]);
    expect(await store.readSidecar(attestation.id)).toBeNull();
  });

  test("a signature beside any record but an attestation is refused before anything is written", async () => {
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const before = await gitRevParse(repo.ctx, scopeRefName(repo.scope));
    const run = {
      kind: "run",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
      runKind: "run",
      performer: RUNNER_PERFORMER,
      determinism: "nondeterministic",
      recipe: {
        command: ["true"],
        workingDirectory: "/",
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
        output: "",
        outputLossy: false,
        exitCode: 0,
        scrubbed: [],
        startedAt: timestamp("2026-01-01T00:00:00.000Z"),
        finishedAt: timestamp("2026-01-01T00:00:00.000Z"),
        reads: [],
        cost: {},
      },
    };
    await expect(store.putMany([{ kind: "run", value: run, signature: "not a signature" }])).rejects.toThrow(
      "refusing to write a signature beside a run record: only an attestation is signed",
    );
    expect(await gitRevParse(repo.ctx, scopeRefName(repo.scope))).toBe(before);
  });
});
