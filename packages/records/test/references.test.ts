import { describe, expect, it } from "vitest";
import { referencesOf } from "../src/index.js";

const id = (digit: string): string => `sha256:${digit.repeat(64)}`;

describe("the references a stored record makes", () => {
  it("cites a claim's evidence runs and its predecessors, never its slot or a selected item", () => {
    const refs = referencesOf({
      kind: "claim",
      slot: id("1"),
      evidence: [{ run: id("2"), item: id("3"), selector: { key: id("4") } }],
      supersedes: [id("5")],
    });
    expect(refs.citations.map((target) => target.id)).toEqual([id("2"), id("5")]);
    expect(refs.pins).toEqual([]);
    expect(refs.blobs).toEqual([]);
  });

  it("cites an artifact's case and every record its receipts section defines an anchor as", () => {
    const content = [
      "The crash reproduces.[^946cb831732c]",
      "",
      "## Receipts",
      "",
      `[^946cb831732c]: ${id("6")}`,
      "[^aaaaaaaaaaaa]: not an id",
    ].join("\n");
    const refs = referencesOf({ kind: "artifact", case: id("7"), content, supersedes: [] });
    expect(refs.citations.map((target) => [target.path, target.id])).toEqual([
      ["$.case", id("7")],
      ["$.content", id("6")],
    ]);
  });

  it("names a run's read-set as pins by their bare digests", () => {
    const refs = referencesOf({
      kind: "run",
      recipe: { command: ["brief", id("8")] },
      observation: { reads: [{ digest: { sha256: "9".repeat(64) } }], resolved: [], output: "" },
      supersedes: [],
    });
    expect(refs.citations).toEqual([]);
    expect(refs.pins.map((target) => target.id)).toEqual([id("9")]);
  });

  it("names a run's output as a blob only where a resolved descriptor stores it as one", () => {
    const stored = (storage: string) =>
      referencesOf({
        kind: "run",
        observation: { reads: [], resolved: [{ annotations: { storage } }], output: id("a") },
        supersedes: [],
      }).blobs;
    expect(stored("blob")).toEqual([id("a")]);
    expect(stored("inline")).toEqual([]);
  });

  it("reads a ruling's claim at the path either schema version stores it at", () => {
    expect(referencesOf({ kind: "ruling", claim: id("b"), supersedes: [] }).citations.map((t) => t.id)).toEqual([
      id("b"),
    ]);
    expect(
      referencesOf({ kind: "ruling", over: { claim: id("c") }, brief: id("d"), supersedes: [] }).citations.map(
        (t) => t.id,
      ),
    ).toEqual([id("c"), id("d")]);
  });

  it("keeps a case's module pin apart from the claims it cites", () => {
    const refs = referencesOf({ kind: "case", claims: [id("e")], preset: { moduleRecord: id("f") }, supersedes: [] });
    expect(refs.citations.map((target) => target.id)).toEqual([id("e")]);
    expect(refs.pins).toEqual([{ path: "$.preset.moduleRecord", id: id("f"), kinds: ["module"] }]);
  });

  it("names a module's bundle as a blob and its build run as a citation", () => {
    const refs = referencesOf({ kind: "module", build: id("1"), bundle: id("2"), manifest: {}, supersedes: [] });
    expect(refs.citations.map((target) => target.id)).toEqual([id("1")]);
    expect(refs.blobs).toEqual([id("2")]);
  });

  it("passes over a value at a listed path that is not an id", () => {
    const refs = referencesOf({ kind: "attestation", subject: "not an id", supersedes: [42] });
    expect(refs.citations).toEqual([]);
  });
});
