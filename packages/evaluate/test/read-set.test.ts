import type { IndexedRecord } from "@musai/fold";
import type { RuleInput } from "@musai/modules";
import { CURRENT_SCHEMA_VERSIONS, hexOfRecordId, type RecordId, recordId } from "@musai/records";
import { describe, expect, it } from "vitest";
import { handedReads } from "../src/evaluator/read-set.js";

const RUN = recordId({ marker: "an evidence run" });
const MODULE = recordId({ marker: "an invoked contribution's module" });
const PLAIN = recordId({ marker: "a record a rule asked for" });
const CLAIM = recordId({ marker: "a claim a rule asked for" });
const SLOT = "musai.read-set-test/claim@1:asked";

const HELD = new Map<RecordId, IndexedRecord>([
  [PLAIN, { id: PLAIN, record: { kind: "case" } as IndexedRecord["record"] }],
  [
    CLAIM,
    {
      id: CLAIM,
      record: { kind: "claim", slot: SLOT, schemaVersion: CURRENT_SCHEMA_VERSIONS.claim } as IndexedRecord["record"],
    },
  ],
]);
const INDEX = {
  recordById: (id: RecordId) => HELD.get(id),
  claimAtSlot: (slot: string) => (slot === SLOT ? { ...HELD.get(CLAIM)!, slot, type: "", rendering: "" } : undefined),
};
const NO_RECIPES = new Map<RecordId, RecordId>();

const INPUT: RuleInput = {
  claimId: "musai.read-set-test/claim@1:evaluated",
  conditions: {},
  evidence: [{ runId: RUN, exitCode: 0, output: "" }],
  invocations: [{ need: { kind: "invoke", contribution: "other/rule", input: {} }, moduleRecord: MODULE, output: {} }],
};

describe("what the kernel handed a rule reads as a read-set", () => {
  it("names each evidence run, each invoked module and each record asked for, by id", () => {
    expect(handedReads(INPUT, [PLAIN], NO_RECIPES, INDEX)).toEqual(
      [RUN, MODULE, PLAIN].sort().map((id) => ({ key: id, consumed: { sha256: hexOfRecordId(id) } })),
    );
  });

  it("reads a run answering a run or fetch need under its recipe, since the need asked for the latest", () => {
    const recipe = recordId({ marker: "the recipe the need named" });

    expect(handedReads({ ...INPUT, invocations: [] }, [], new Map([[RUN, recipe]]), INDEX)).toEqual([
      { key: `recipe:${recipe}`, consumed: { sha256: hexOfRecordId(RUN) } },
    ]);
  });

  it("reads a record need answered by a claim under the claim's slot, consuming its digest", () => {
    expect(handedReads({ ...INPUT, evidence: [], invocations: [] }, [CLAIM], NO_RECIPES, INDEX)).toEqual([
      { key: `slot:${SLOT}`, consumed: { sha256: hexOfRecordId(CLAIM) } },
    ]);
  });

  it("reads the claim named as evaluated under the slot its input names", () => {
    const evaluated = recordId({ marker: "the evaluated claim" });

    expect(handedReads({ ...INPUT, evidence: [], invocations: [] }, [], NO_RECIPES, INDEX, evaluated)).toEqual([
      { key: `slot:${INPUT.claimId}`, consumed: { sha256: hexOfRecordId(evaluated) } },
    ]);
  });

  it("names each key once, in key order, however often it was handed", () => {
    const twice = { ...INPUT, evidence: [...INPUT.evidence, ...INPUT.evidence] };
    const keys = handedReads(twice, [PLAIN, PLAIN], NO_RECIPES, INDEX).map((entry) => entry.key);

    expect(keys).toEqual([...new Set(keys)].sort());
  });
});
