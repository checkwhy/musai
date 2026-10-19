import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { timestamp } from "@musai/records";
import { describe, expect, test, vi } from "vitest";
import { type EvidenceHop, weakestLink } from "../src/evaluator/evidence.js";
import type { Labelling } from "../src/evaluator/fixpoint.js";
import * as ordering from "../src/evaluator/ordering.js";
import type { SetAside } from "../src/evaluator/rulings.js";
import {
  type DerivationJson,
  type DerivationNode,
  formatBriefDecision,
  formatRulingDecision,
  formatRulingVerdict,
  formatSetAsideDecision,
  renderJson,
  renderText,
} from "../src/why/render.js";
import { type DerivationNodeSource, type DerivationSource, walkWitnesses } from "../src/why/walk.js";

const DEEP_MIXED_CHAIN_FIXTURE = fileURLToPath(
  new URL("./fixtures/07-deep-mixed-chain-weakest-link.fixture.json", import.meta.url),
);

function emptyLabelling(): Labelling {
  return { labels: new Map(), witnesses: new Map() };
}

function sourceFrom(nodes: Readonly<Record<string, DerivationNodeSource>>): DerivationSource {
  return {
    nodeOf: (id: string) => {
      const node = nodes[id];
      if (!node) {
        throw new Error(`no derivation node registered for id: ${id}`);
      }
      return node;
    },
  };
}

function depthOfNode(node: DerivationNode): number {
  return node.children.length === 0 ? 0 : 1 + Math.max(...node.children.map(depthOfNode));
}

function depthOfJson(node: DerivationJson): number {
  return node.children.length === 0 ? 0 : 1 + Math.max(...node.children.map(depthOfJson));
}

function nodeIdsOfNode(node: DerivationNode): string[] {
  return [node.hop.id, ...node.children.flatMap(nodeIdsOfNode)];
}

function nodeIdsOfJson(node: DerivationJson): string[] {
  return [node.id, ...node.children.flatMap(nodeIdsOfJson)];
}

describe("walkWitnesses reaches receipts and citations at its leaves", () => {
  test("a four-hop chain names each intermediate hop's kind down to a receipt at the leaf", () => {
    const source = sourceFrom({
      "claim-x": { kind: "claim", decidedBy: "receipt", beat: "rival-argument", childIds: ["evidence-1"] },
      "evidence-1": { kind: "evidence", decidedBy: "citation", childIds: ["evidence-2"] },
      "evidence-2": { kind: "evidence", decidedBy: "agent-judgment", childIds: ["evidence-3"] },
      "evidence-3": { kind: "evidence", decidedBy: "receipt", childIds: ["run-final"] },
      "run-final": { kind: "run", decidedBy: "run", childIds: [] },
    });

    const derivation = walkWitnesses(emptyLabelling(), source, "claim-x");
    const kinds = [];
    let node: DerivationNode | undefined = derivation;
    while (node) {
      kinds.push(node.hop.label);
      node = node.children[0];
    }
    expect(kinds).toEqual(["claim", "evidence", "evidence", "evidence", "run"]);
    expect(derivation.children[0]!.children[0]!.children[0]!.children[0]!.hop.id).toBe("run-final");
  });
});

describe("a set-aside hop names the overruled run, the ruler and the reason", () => {
  test("the run stays in the graph, rendered as the set-aside's own child rather than omitted", () => {
    const setAside: SetAside = {
      ruling: "sha256:ruling1",
      run: "sha256:overruled-run",
      reason: "the receipt predates a since-fixed regression",
      ruledAt: timestamp("2026-01-01T00:00:00.000Z"),
      principal: "alice@example.com",
    };

    const source = sourceFrom({
      "claim-x": { kind: "claim", decidedBy: "ruling", childIds: [setAside.ruling] },
      [setAside.ruling]: {
        kind: "set-aside",
        decidedBy: formatSetAsideDecision(setAside.principal, setAside.reason),
        childIds: [setAside.run],
      },
      [setAside.run]: { kind: "run", decidedBy: "run", childIds: [] },
    });

    const derivation = walkWitnesses(emptyLabelling(), source, "claim-x");
    const setAsideHop = derivation.children[0]!;
    expect(setAsideHop.hop.label).toBe("set-aside");
    expect(setAsideHop.hop.decidedBy).toContain(setAside.principal);
    expect(setAsideHop.hop.decidedBy).toContain(setAside.reason);
    expect(setAsideHop.children[0]!.hop.id).toBe(setAside.run);
  });

  test("several set-asides against one run render in the order they were given, each naming the run in place", () => {
    const ordered: SetAside[] = [
      {
        ruling: "sha256:a",
        run: "sha256:run",
        reason: "first",
        ruledAt: timestamp("2026-01-01T00:00:00.000Z"),
        principal: "alice",
      },
      {
        ruling: "sha256:b",
        run: "sha256:run",
        reason: "second",
        ruledAt: timestamp("2026-01-02T00:00:00.000Z"),
        principal: "bob",
      },
      {
        ruling: "sha256:c",
        run: "sha256:run",
        reason: "third",
        ruledAt: timestamp("2026-01-03T00:00:00.000Z"),
        principal: "carol",
      },
    ];

    const nodes: Record<string, DerivationNodeSource> = {
      "claim-x": { kind: "claim", decidedBy: "ruling", childIds: ordered.map((aside) => aside.ruling) },
      "sha256:run": { kind: "run", decidedBy: "run", childIds: [] },
    };
    for (const aside of ordered) {
      nodes[aside.ruling] = {
        kind: "set-aside",
        decidedBy: formatSetAsideDecision(aside.principal, aside.reason),
        childIds: [aside.run],
      };
    }

    const derivation = walkWitnesses(emptyLabelling(), sourceFrom(nodes), "claim-x");
    const reasonsInOrder = derivation.children.map((child) => child.hop.decidedBy);
    expect(reasonsInOrder).toEqual([
      formatSetAsideDecision("alice", "first"),
      formatSetAsideDecision("bob", "second"),
      formatSetAsideDecision("carol", "third"),
    ]);
  });
});

describe("the brief hop stands between a ruling and the records it read", () => {
  test("a derivation walking down from a ruling reaches its cited brief, and from the brief reaches every record the brief's own observation read", () => {
    const source = sourceFrom({
      "claim-x": { kind: "claim", decidedBy: "person ruling by alice@example.com", childIds: ["ruling-1"] },
      "ruling-1": {
        kind: "ruling",
        decidedBy: formatRulingDecision("person", ["alice@example.com"]),
        childIds: ["brief-1"],
      },
      "brief-1": { kind: "brief", decidedBy: formatBriefDecision(), childIds: ["run-1", "run-2"] },
      "run-1": { kind: "run", decidedBy: "run", childIds: [] },
      "run-2": { kind: "run", decidedBy: "citation", childIds: [] },
    });

    const derivation = walkWitnesses(emptyLabelling(), source, "claim-x");
    const rulingHop = derivation.children[0]!;
    const briefHop = rulingHop.children[0]!;

    expect(rulingHop.hop.label).toBe("ruling");
    expect(briefHop.hop.label).toBe("brief");
    expect(briefHop.hop.decidedBy).toBe(formatBriefDecision());
    expect(briefHop.children.map((child) => child.hop.id)).toEqual(["run-1", "run-2"]);
    expect(briefHop.children.map((child) => child.hop.label)).toEqual(["run", "run"]);
  });

  test("renderText names the brief hop distinctly from the ruling, floor, set-aside, evidence and run hops", () => {
    const source = sourceFrom({
      "claim-x": { kind: "claim", decidedBy: "person ruling by alice@example.com", childIds: ["ruling-1"] },
      "ruling-1": {
        kind: "ruling",
        decidedBy: formatRulingDecision("person", ["alice@example.com"]),
        childIds: ["brief-1"],
      },
      "brief-1": { kind: "brief", decidedBy: formatBriefDecision(), childIds: ["run-1"] },
      "run-1": { kind: "run", decidedBy: "run", childIds: [] },
    });

    const derivation = walkWitnesses(emptyLabelling(), source, "claim-x");
    const labels = renderText(derivation)
      .split("\n")
      .map((line) => line.trim().split(" ")[0]);

    expect(labels).toEqual(["claim", "ruling", "brief", "run"]);
    expect(new Set(labels).size).toBe(4);
  });
});

describe("the hop that capped a chain's evidence kind", () => {
  test("is found by weakestLink against the corpus's own deep-mixed-chain fixture", async () => {
    const raw = await readFile(DEEP_MIXED_CHAIN_FIXTURE, "utf8");
    const fixture = JSON.parse(raw) as {
      readonly chain: readonly EvidenceHop[];
      readonly expected: { readonly cappedKind: string; readonly cappedHopIndex: number };
    };

    const link = weakestLink(fixture.chain);
    expect(link.kind).toBe(fixture.expected.cappedKind);
    expect(link.settledBy.id).toBe(fixture.chain[fixture.expected.cappedHopIndex]!.id);
  });
});

describe("walkWitnesses recomputes no comparison", () => {
  test("still produces the full derivation with compareArguments stubbed to throw", () => {
    const spy = vi.spyOn(ordering, "compareArguments").mockImplementation(() => {
      throw new Error("walkWitnesses must never call compareArguments");
    });

    try {
      const source = sourceFrom({
        "claim-x": { kind: "claim", decidedBy: "receipt", beat: "rival", childIds: ["run-1"] },
        "run-1": { kind: "run", decidedBy: "run", childIds: [] },
      });
      const derivation = walkWitnesses(emptyLabelling(), source, "claim-x");
      expect(derivation.hop.id).toBe("claim-x");
      expect(derivation.children[0]!.hop.id).toBe("run-1");
    } finally {
      spy.mockRestore();
    }
  });

  test("a defeated node's beat is read from the fixpoint's own witness, not supplied by the source", () => {
    const labelling: Labelling = {
      labels: new Map([
        ["winner", "in"],
        ["loser", "out"],
      ]),
      witnesses: new Map([["loser", { defeatedBy: "winner" }]]),
    };
    const source = sourceFrom({
      "claim-x": { kind: "claim", decidedBy: "receipt", childIds: ["loser"] },
      loser: { kind: "argument", decidedBy: "agent-judgment", childIds: [] },
    });
    const derivation = walkWitnesses(labelling, source, "claim-x");
    expect(derivation.children[0]!.hop.beat).toBe("winner");
  });
});

describe("text and json forms agree on node count, node ids and depth", () => {
  const corpus: readonly { readonly name: string; readonly source: DerivationSource; readonly rootId: string }[] = [
    {
      name: "single-hop receipt",
      source: sourceFrom({
        "claim-1": { kind: "claim", decidedBy: "receipt", childIds: ["run-1"] },
        "run-1": { kind: "run", decidedBy: "run", childIds: [] },
      }),
      rootId: "claim-1",
    },
    {
      name: "deep mixed chain",
      source: sourceFrom({
        "claim-2": { kind: "claim", decidedBy: "agent-judgment", childIds: ["hop-0"] },
        "hop-0": { kind: "evidence", decidedBy: "receipt", childIds: ["hop-1"] },
        "hop-1": { kind: "evidence", decidedBy: "citation", childIds: ["hop-2"] },
        "hop-2": { kind: "evidence", decidedBy: "agent-judgment", childIds: ["hop-3"] },
        "hop-3": { kind: "evidence", decidedBy: "receipt", childIds: [] },
      }),
      rootId: "claim-2",
    },
    {
      name: "set-aside over a run",
      source: sourceFrom({
        "claim-3": { kind: "claim", decidedBy: "ruling", childIds: ["set-aside-1"] },
        "set-aside-1": { kind: "set-aside", decidedBy: formatSetAsideDecision("alice", "reason"), childIds: ["run-3"] },
        "run-3": { kind: "run", decidedBy: "run", childIds: [] },
      }),
      rootId: "claim-3",
    },
    {
      name: "branching evidence with two supporting receipts",
      source: sourceFrom({
        "claim-4": { kind: "claim", decidedBy: "receipt", childIds: ["run-4a", "run-4b"] },
        "run-4a": { kind: "run", decidedBy: "run", childIds: [] },
        "run-4b": { kind: "run", decidedBy: "run", childIds: [] },
      }),
      rootId: "claim-4",
    },
  ];

  for (const { name, source, rootId } of corpus) {
    test(`${name}: same node count, node ids and depth in both forms`, () => {
      const derivation = walkWitnesses(emptyLabelling(), source, rootId);
      const text = renderText(derivation);
      const json = renderJson(derivation);

      const textNodeCount = text.split("\n").length;
      const jsonNodeCount = nodeIdsOfJson(json).length;
      expect(jsonNodeCount).toBe(textNodeCount);
      expect(nodeIdsOfJson(json)).toEqual(nodeIdsOfNode(derivation));
      expect(depthOfJson(json)).toBe(depthOfNode(derivation));

      const lines = text.split("\n");
      const indentWidths = lines.map((line) => line.length - line.trimStart().length);
      expect(indentWidths[0]).toBe(0);
      for (let i = 1; i < indentWidths.length; i++) {
        // A line sits at most one level (two spaces) deeper than the line before it.
        expect(indentWidths[i]!).toBeLessThanOrEqual(indentWidths[i - 1]! + 2);
      }
    });
  }

  test("a single linear chain's indentation increases by exactly one level per hop", () => {
    const derivation = walkWitnesses(emptyLabelling(), corpus[1]!.source, corpus[1]!.rootId);
    const lines = renderText(derivation).split("\n");
    const indentWidths = lines.map((line) => line.length - line.trimStart().length);
    for (let i = 1; i < indentWidths.length; i++) {
      expect(indentWidths[i]!).toBe(indentWidths[i - 1]! + 2);
    }
  });
});

describe("formatRulingDecision names every attesting principal, not one standing in for the pair", () => {
  test("two principals agreeing over one ruling both appear in the rendered decision", () => {
    expect(formatRulingDecision("person", ["alice@example.com", "bob@example.com"])).toBe(
      "person ruling by alice@example.com and bob@example.com",
    );
  });

  test("a ruling with exactly one attesting principal renders exactly as before", () => {
    expect(formatRulingDecision("person", ["alice@example.com"])).toBe("person ruling by alice@example.com");
  });

  test("a ruling no principal attested says so rather than naming an empty list", () => {
    expect(formatRulingDecision("contested-authority", [])).toBe("contested-authority ruling attested by nobody");
  });
});

describe("formatRulingVerdict leads with the verdict and words the rest as a live ruling hop does", () => {
  test("the verdict, the authority and every attesting principal appear in the rendered decision", () => {
    expect(formatRulingVerdict("holds", "person", ["alice@example.com", "bob@example.com"])).toBe(
      "holds, person ruling by alice@example.com and bob@example.com",
    );
  });
});
