import { describe, expect, it } from "vitest";
import { RECORD_KINDS } from "../src/record/kinds.js";
import { CURRENT_SCHEMA_VERSIONS, KIND_CONTRACTS, PACK_MINTABLE_KINDS } from "../src/record/schema.js";

describe("a kind ships a normaliser only for a version below the one it writes", () => {
  it("keys every normaliser by a whole version under the one its kind writes", () => {
    for (const kind of RECORD_KINDS) {
      const contract = KIND_CONTRACTS[kind];
      for (const key of Object.keys(contract.normalizers)) {
        const from = Number(key);
        expect(Number.isInteger(from)).toBe(true);
        expect(from).toBeLessThan(contract.version);
      }
    }
  });
});

describe("every kind reads its schema version as a measured number", () => {
  it("declares schemaVersion measured, since the version is a small integer a double holds exactly", () => {
    for (const kind of RECORD_KINDS) {
      expect(KIND_CONTRACTS[kind].numberPolicy).toMatchObject({ schemaVersion: "measured" });
    }
  });
});

describe("every sealed path is rooted at the record", () => {
  it("names each position a sealed value may take from the record down", () => {
    for (const kind of RECORD_KINDS) {
      for (const path of KIND_CONTRACTS[kind].sealedPaths) {
        expect(path.startsWith("$.")).toBe(true);
      }
    }
  });
});

describe("the current versions are the ones the contracts write", () => {
  it("answers for every kind with the version its own contract declares", () => {
    for (const kind of RECORD_KINDS) {
      expect(CURRENT_SCHEMA_VERSIONS[kind]).toBe(KIND_CONTRACTS[kind].version);
    }
  });
});

describe("a pack's plan may put exactly the kinds whose contract lets a pack draft one", () => {
  it("lists a claim, an argument, a case and an artifact, in the order the store's kinds run, and no kind a pack may not draft", () => {
    expect(PACK_MINTABLE_KINDS).toEqual(["claim", "argument", "case", "artifact"]);
  });
});
