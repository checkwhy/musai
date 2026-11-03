import { runHandler } from "@musai/api-core";
import type { RecordId } from "@musai/records";
import { fixedClock, makeCheckout, splitByShell } from "@musai/test-support";
import { describe, expect, onTestFinished, test } from "vitest";
import { type ClaimLookup, checkSpelling, claimSlotNamed } from "../src/claim-ref.js";
import { checkRun } from "../src/ops/check.js";
import { claimStatus } from "../src/ops/claim.js";
import { claimWhy } from "../src/ops/why.js";
import { workspaceInit } from "../src/ops/workspace.js";

const SLOT_A = `sha256:aaaaaaaa1${"0".repeat(55)}`;
const SLOT_B = `sha256:aaaaaaaa2${"0".repeat(55)}`;
const CLAIM_A = `sha256:${"c".repeat(64)}` as RecordId;
const CLAIM_B = `sha256:${"d".repeat(64)}` as RecordId;
/** A claim CLAIM_A superseded at SLOT_A. */
const REPLACED = `sha256:${"e".repeat(64)}` as RecordId;

/** Two claims whose slots share their first eight hex digits. */
const twoSlots: ClaimLookup = {
  claimAtSlot: (slot) =>
    slot === SLOT_A ? ({ id: CLAIM_A } as never) : slot === SLOT_B ? ({ id: CLAIM_B } as never) : undefined,
  contributorsAtSlot: (slot) =>
    slot === SLOT_A ? [{ id: CLAIM_A } as never] : slot === SLOT_B ? [{ id: CLAIM_B } as never] : [],
  recordById: () => undefined,
  claimsWithHexPrefix: (hex) =>
    [
      { slot: SLOT_A, id: CLAIM_A },
      { slot: SLOT_A, id: REPLACED },
      { slot: SLOT_B, id: CLAIM_B },
    ].filter((row) => row.slot.startsWith(`sha256:${hex}`) || row.id.startsWith(`sha256:${hex}`)),
  claimSlotsRendering: () => [],
};

describe("naming a claim by less than its slot", () => {
  test("an ambiguous prefix names every match", () => {
    expect(() => claimSlotNamed(twoSlots, "aaaaaaaa")).toThrow(
      expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining(`${SLOT_A}, ${SLOT_B}`) }),
    );
  });

  test("a prefix of one claim's record id names that claim's slot", () => {
    expect(claimSlotNamed(twoSlots, "cccccccc")).toBe(SLOT_A);
    expect(claimSlotNamed(twoSlots, "aaaaaaaa1")).toBe(SLOT_A);
  });

  test("a prefix of a superseded claim's id names nothing, as its full id does", () => {
    expect(claimSlotNamed(twoSlots, "eeeeeeee")).toBe("eeeeeeee");
  });

  test("a prefix shorter than eight hex digits is refused, naming the floor", () => {
    expect(() => claimSlotNamed(twoSlots, "aaaa")).toThrow(
      expect.objectContaining({ reason: "invalid-input", message: expect.stringContaining("eight") }),
    );
  });

  test("status takes the short id check printed, and why takes the sentence", async () => {
    const checkout = await makeCheckout("hello");
    onTestFinished(() => checkout.cleanup());
    const context = { workspace: checkout.dir, scope: "default", now: fixedClock("2026-10-01T00:00:00.000Z") };
    await runHandler(workspaceInit, { workspace: checkout.dir }, context);
    const checked = await runHandler(
      checkRun,
      { statement: "node exits cleanly", command: ["node", "-e", "process.exit(0)"] },
      context,
    );

    const status = await runHandler(claimStatus, { claim: checked.short }, context);
    const why = await runHandler(claimWhy, { claim: "node exits cleanly", full: true }, context);

    expect(status.label).toBe("holds");
    expect(JSON.stringify(why)).toContain(checked.claim);
  }, 120_000);
});

describe("how a claim is checked by a rule", () => {
  test("pastes back naming a rule whose id holds a space and shell metacharacters as one word", async () => {
    const rule = "a-module/a rule $HOME;x";

    expect(await splitByShell(checkSpelling(rule))).toEqual(["check", "<sentence>", "--rule", rule]);
  });
});
