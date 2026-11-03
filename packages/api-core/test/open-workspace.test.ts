import { recordId, timestamp } from "@musai/records";
import { makeFixtureRepo, mintedSortingBefore, pseudonymOf, writeFixtureRecords } from "@musai/test-support";
import { type Attestation, mintAttestation } from "@musai/trust";
import { afterEach, describe, expect, test, vi } from "vitest";
import { openWorkspace, verifiedAttestationFor } from "../src/open-workspace.js";
import { Workspace } from "../src/workspace.js";
import { FIXTURE_CLOCK } from "./fixture-distribution.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the workspace an operation's context opens", () => {
  test("is handed the context's own sink for a subscription's refused answer", async () => {
    const open = vi.spyOn(Workspace, "open").mockRejectedValue(new Error("not opened"));
    const reportSubscription = async (): Promise<void> => {};

    await openWorkspace({ workspace: "/nowhere", scope: "default", now: FIXTURE_CLOCK, reportSubscription }).catch(
      () => undefined,
    );

    expect(open.mock.calls[0]![0].onSubscriptionTrace).toBe(reportSubscription);
  });
});

describe("the attestation a subject's principal class is read from", () => {
  const subject = recordId({ example: "a testimony an agent made and a person asserted" });
  const made = mintAttestation({
    subject,
    principal: pseudonymOf("agent"),
    principalClass: "agent",
    via: "model",
    purpose: "made",
    at: timestamp("2026-01-01T00:00:00.000Z"),
  });
  const asserted = mintedSortingBefore(made, (at) =>
    mintAttestation({
      subject,
      principal: pseudonymOf("reviewer"),
      principalClass: "person",
      via: "signature",
      purpose: "asserted",
      at,
    }),
  );

  async function attestationReadFrom(attestations: readonly Attestation[]) {
    const repo = await makeFixtureRepo("maker-attestation");
    try {
      await writeFixtureRecords(
        repo,
        attestations.map((attestation) => ({ kind: "attestation", value: attestation.record })),
      );
      using opened = await openWorkspace({ workspace: repo.workspace, scope: repo.scope, now: repo.now });
      return await verifiedAttestationFor(opened, subject);
    } finally {
      await repo.cleanup();
    }
  }

  test("is its maker's, even where an asserter's comes first in hash order", async () => {
    expect(await attestationReadFrom([asserted, made])).toEqual(made.record);
  });

  test("is an asserter's where nobody attests making the subject", async () => {
    expect(await attestationReadFrom([asserted])).toEqual(asserted.record);
  });
});
