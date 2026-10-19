import { createHash } from "node:crypto";
import { type ClaimRecord, type ClaimTypeDeclaration, CURRENT_SCHEMA_VERSIONS, slotFor } from "@musai/records";
import { makeFixtureRepo } from "@musai/test-support";
import { expect, it } from "vitest";
import { Store } from "../src/store.js";

const TYPE = "musai.demo/place@1";
const DECLARATION: ClaimTypeDeclaration = { type: TYPE, identityDimensions: ["subject", "place"] };

it("mints a claim whose stored bytes are its RFC 8785 canonical JSON and whose id is their sha256", async () => {
  const repo = await makeFixtureRepo("record-id", [DECLARATION]);
  try {
    const conditions = { subject: "mara", place: "the keep" };
    const claim: ClaimRecord = {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: TYPE,
      about: [],
      slot: slotFor(DECLARATION, conditions),
      conditions,
      canonical: { statement: "mara holds the keep", certainty: "stated" },
      rendering: "Mara holds the keep.",
      evidence: [],
      exclusiveGroup: null,
    };
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });

    const id = await store.put("claim", claim);
    const bytes = new TextDecoder().decode(await store.readBytes(id, "claim"));

    const canonical =
      '{"about":[],"canonical":{"certainty":"stated","statement":"mara holds the keep"},' +
      '"conditions":{"place":"the keep","subject":"mara"},"evidence":[],"exclusiveGroup":null,' +
      `"kind":"claim","rendering":"Mara holds the keep.","schemaVersion":${claim.schemaVersion},` +
      `"slot":"${claim.slot}","supersedes":[],"type":"musai.demo/place@1"}`;

    expect(bytes).toBe(canonical);
    expect(id).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  } finally {
    await repo.cleanup();
  }
});
