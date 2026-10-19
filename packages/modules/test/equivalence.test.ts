import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalBytes, versionString } from "@musai/records";
import { gatewaySource } from "@musai/test-support";
import { beforeAll, describe, expect, test } from "vitest";
import { HOSTS, type HostDescriptor, type ModuleHost } from "../src/module/hosts.js";
import {
  ENVELOPE_PROTOCOL,
  type EnvelopeRequest,
  type EnvelopeResponse,
  type InvokedContribution,
  kernelPoint,
} from "../src/rule/envelope.js";
import { InProcessHost } from "../src/rule/host.js";
import { type ReadLog, recordRead } from "../src/rule/read-log.js";

/** A gateway answering each shape a rule's output may take, never an envelope failure, which is
 * another corpus. Built, since every host answers only through the one export. */
const CORPUS_GATEWAY = gatewaySource(
  "evaluatesCorpusFixture",
  [
    "      const mode = input.conditions.mode;",
    '      if (mode === "request") {',
    '        return { kind: "request", needs: [{ kind: "record", id: "sha256:" + "0".repeat(64) }] };',
    "      }",
    '      if (mode === "error") {',
    '        return { kind: "error", error: { code: "contribution-threw", data: null, message: "the fixture rule concludes with its own error" } };',
    "      }",
    "      if (input.evidence.length === 0) {",
    '        return { kind: "verdict", label: "open", reason: "no evidence yet" };',
    "      }",
    "      const everyExitClean = input.evidence.every((item) => item.exitCode === 0);",
    "      return {",
    '        kind: "verdict",',
    '        label: everyExitClean ? "holds" : "fails",',
    '        reason: everyExitClean ? "every run exited cleanly" : "a run exited with a non-zero code",',
    "      };",
  ].join("\n"),
);

interface CorpusCase {
  readonly label: string;
  readonly modulePath: string;
  readonly exportName: string;
  readonly request: EnvelopeRequest;
}

interface HostInvocationRecord {
  readonly name: string;
  readonly response: EnvelopeResponse;
  readonly readLog: ReadLog;
}

interface DivergenceReport {
  readonly kind: "response" | "read-log";
  readonly caseLabel: string;
  readonly hostA: string;
  readonly hostB: string;
  readonly message: string;
}

/** A registered host this run skipped, and why, so a skip is visible rather than silent. */
interface SkippedHost {
  readonly name: string;
  readonly reason: string;
}

type EquivalenceOutcome =
  | { readonly ok: true; readonly skipped: readonly SkippedHost[] }
  | { readonly ok: false; readonly reason: "empty-corpus"; readonly message: string }
  | {
      readonly ok: false;
      readonly reason: "insufficient-hosts";
      readonly message: string;
      readonly skipped: readonly SkippedHost[];
    }
  | {
      readonly ok: false;
      readonly reason: "divergence";
      readonly divergence: DivergenceReport;
      readonly skipped: readonly SkippedHost[];
    };

/** The first offset two byte strings disagree at, `undefined` when they are identical. */
function firstDifferingByte(
  a: Uint8Array,
  b: Uint8Array,
): { readonly offset: number; readonly a: number | undefined; readonly b: number | undefined } | undefined {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) {
      return { offset: i, a: a[i], b: b[i] };
    }
  }
  return undefined;
}

/** Reads one log holds and the other lacks, in either direction; membership only, never order. */
function readLogDifference(a: ReadLog, b: ReadLog): string | undefined {
  const onlyInA = [...a.reads].filter((read) => !b.reads.has(read));
  const onlyInB = [...b.reads].filter((read) => !a.reads.has(read));
  if (onlyInA.length === 0 && onlyInB.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (onlyInA.length > 0) {
    parts.push(`present only in the first log: ${onlyInA.join(", ")}`);
  }
  if (onlyInB.length > 0) {
    parts.push(`present only in the second log: ${onlyInB.join(", ")}`);
  }
  return parts.join("; ");
}

/** Runs a corpus through every available distinct host. Agreement is identical response bytes and
 * the same read-log members: a host under-reporting its reads would otherwise pass. */
async function runEquivalence(
  descriptors: readonly HostDescriptor[],
  corpus: readonly CorpusCase[],
): Promise<EquivalenceOutcome> {
  if (corpus.length === 0) {
    return { ok: false, reason: "empty-corpus", message: "the fixture corpus named to this run holds no cases" };
  }

  const resolved: { readonly descriptor: HostDescriptor; readonly host: ModuleHost }[] = [];
  const skipped: SkippedHost[] = [];
  for (const descriptor of descriptors) {
    if (await descriptor.available()) {
      resolved.push({ descriptor, host: descriptor.create() });
    } else {
      skipped.push({ name: descriptor.name, reason: "this machine does not provide what this host needs to run" });
    }
  }

  const distinctImplementations = new Set(resolved.map((entry) => entry.host.constructor));
  if (distinctImplementations.size < 2) {
    return {
      ok: false,
      reason: "insufficient-hosts",
      message: `only ${distinctImplementations.size} distinct host implementation(s) were available, from: ${resolved.map((entry) => entry.descriptor.name).join(", ") || "none"}`,
      skipped,
    };
  }

  for (const kase of corpus) {
    const invocations: HostInvocationRecord[] = [];
    for (const entry of resolved) {
      const loaded = await entry.host.load(kase.modulePath, kase.exportName);
      const { response, readLog } = await entry.host.invoke(loaded, kase.request, ruleEntry(kase.request.id));
      invocations.push({ name: entry.descriptor.name, response, readLog });
    }

    const [first, ...rest] = invocations;
    for (const other of rest) {
      const responseDivergence = firstDifferingByte(canonicalBytes(first!.response), canonicalBytes(other.response));
      if (responseDivergence !== undefined) {
        return {
          ok: false,
          reason: "divergence",
          divergence: {
            kind: "response",
            caseLabel: kase.label,
            hostA: first!.name,
            hostB: other.name,
            message: `case ${kase.label}: ${first!.name} and ${other.name} disagree at byte offset ${responseDivergence.offset} (${first!.name}: ${responseDivergence.a ?? "absent"}, ${other.name}: ${responseDivergence.b ?? "absent"})`,
          },
          skipped,
        };
      }
      const readLogMessage = readLogDifference(first!.readLog, other.readLog);
      if (readLogMessage !== undefined) {
        return {
          ok: false,
          reason: "divergence",
          divergence: {
            kind: "read-log",
            caseLabel: kase.label,
            hostA: first!.name,
            hostB: other.name,
            message: `case ${kase.label}: ${first!.name} and ${other.name} disagree on what was read — ${readLogMessage}`,
          },
          skipped,
        };
      }
    }
  }

  return { ok: true, skipped };
}

function requestFor(id: string, input: unknown): EnvelopeRequest {
  return { protocol: ENVELOPE_PROTOCOL, contribution: "rule", id, version: versionString("1"), input };
}

/** The kernel's `rule` point and an entry declaring nothing narrower: these tests pin the host. */
function ruleEntry(id: string): InvokedContribution {
  return {
    entry: { kind: "rule", id, version: versionString("1"), input: true, output: true, documentation: "" },
    point: kernelPoint("rule")!,
  };
}

const EMPTY_INPUT = { claimId: "corpus-claim", conditions: {}, evidence: [] };
const CLEAN_EVIDENCE_INPUT = {
  claimId: "corpus-claim",
  conditions: {},
  evidence: [{ runId: "run-1", exitCode: 0, output: "" }],
};
const REQUEST_MODE_INPUT = { claimId: "corpus-claim", conditions: { mode: "request" }, evidence: [] };
const ERROR_MODE_INPUT = { claimId: "corpus-claim", conditions: { mode: "error" }, evidence: [] };
const INVOKED_INPUT = {
  claimId: "corpus-claim",
  conditions: {},
  evidence: [],
  invocations: [
    {
      need: { kind: "invoke", contribution: "corpus/invoked", input: {} },
      moduleRecord: `sha256:${"3".repeat(64)}`,
      output: null,
    },
  ],
};

/** A third host wrapping a real one, proving a new registry row needs no edit to this harness. */
class DelegatingThirdHost implements ModuleHost {
  readonly #inner = new InProcessHost();
  load(modulePath: string, exportName: string) {
    return this.#inner.load(modulePath, exportName);
  }
  invoke(
    loaded: Awaited<ReturnType<InProcessHost["load"]>>,
    request: EnvelopeRequest,
    contribution: InvokedContribution,
  ) {
    return this.#inner.invoke(loaded, request, contribution);
  }
}

/** A host whose response differs by one appended character, like a host not yet agreeing. */
class DivergentResponseStubHost implements ModuleHost {
  readonly #inner = new InProcessHost();
  load(modulePath: string, exportName: string) {
    return this.#inner.load(modulePath, exportName);
  }
  async invoke(
    loaded: Awaited<ReturnType<InProcessHost["load"]>>,
    request: EnvelopeRequest,
    contribution: InvokedContribution,
  ) {
    const { response, readLog } = await this.#inner.invoke(loaded, request, contribution);
    if (!response.ok) {
      return { response, readLog };
    }
    const output = response.output as Record<string, unknown>;
    const corrupted = { ...output, reason: `${String(output["reason"])}!` };
    return { response: { ok: true as const, output: corrupted, diagnostics: response.diagnostics }, readLog };
  }
}

/** A host whose read-log carries one entry a real host's never would. */
class DivergentReadLogStubHost implements ModuleHost {
  readonly #inner = new InProcessHost();
  load(modulePath: string, exportName: string) {
    return this.#inner.load(modulePath, exportName);
  }
  async invoke(
    loaded: Awaited<ReturnType<InProcessHost["load"]>>,
    request: EnvelopeRequest,
    contribution: InvokedContribution,
  ) {
    const { response, readLog } = await this.#inner.invoke(loaded, request, contribution);
    return { response, readLog: recordRead(readLog.claimId, [...readLog.reads, "read:never-actually-touched"]) };
  }
}

/** A host logging the same reads in reverse order: the comparison is by membership. */
class ReorderedReadLogStubHost implements ModuleHost {
  readonly #inner = new InProcessHost();
  load(modulePath: string, exportName: string) {
    return this.#inner.load(modulePath, exportName);
  }
  async invoke(
    loaded: Awaited<ReturnType<InProcessHost["load"]>>,
    request: EnvelopeRequest,
    contribution: InvokedContribution,
  ) {
    const { response, readLog } = await this.#inner.invoke(loaded, request, contribution);
    return { response, readLog: recordRead(readLog.claimId, [...readLog.reads].reverse()) };
  }
}

function alwaysAvailable(create: () => ModuleHost, name: string): HostDescriptor {
  return { name, available: () => true, create };
}

describe("the equivalence harness runs a fixture corpus through every registered host", () => {
  let modulePath: string;
  let corpus: CorpusCase[];

  beforeAll(async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "musai-equivalence-"));
    modulePath = join(scratchDir, "corpus-fixture.rule.ts");
    await writeFile(modulePath, CORPUS_GATEWAY);
    corpus = [
      {
        label: "open verdict, no evidence",
        modulePath,
        exportName: "evaluatesCorpusFixture",
        request: requestFor("corpus/open", EMPTY_INPUT),
      },
      {
        label: "holds verdict, clean evidence",
        modulePath,
        exportName: "evaluatesCorpusFixture",
        request: requestFor("corpus/holds", CLEAN_EVIDENCE_INPUT),
      },
      {
        label: "a request naming a need",
        modulePath,
        exportName: "evaluatesCorpusFixture",
        request: requestFor("corpus/request", REQUEST_MODE_INPUT),
      },
      {
        label: "a conclusive error",
        modulePath,
        exportName: "evaluatesCorpusFixture",
        request: requestFor("corpus/error", ERROR_MODE_INPUT),
      },
      {
        label: "an open verdict, input carrying an invoke's answer",
        modulePath,
        exportName: "evaluatesCorpusFixture",
        request: requestFor("corpus/invoked", INVOKED_INPUT),
      },
    ];
  });

  test("every registered host agrees on the whole corpus, in responses and in what was read", async () => {
    const outcome = await runEquivalence(HOSTS, corpus);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      for (const skip of outcome.skipped) {
        process.stdout.write(`equivalence: skipped ${skip.name} — ${skip.reason}\n`);
      }
    }
  });

  test("a host whose availability predicate reports unavailable is skipped and named in the report", async () => {
    const descriptors = [
      alwaysAvailable(() => new InProcessHost(), "in-process"),
      alwaysAvailable(() => new DelegatingThirdHost(), "delegating-third"),
      { name: "forced-unavailable", available: () => false, create: () => new InProcessHost() },
    ];
    const outcome = await runEquivalence(descriptors, corpus);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.skipped.map((skip) => skip.name)).toContain("forced-unavailable");
    }
  });

  test("the corpus itself covers a verdict, a request and an error response", async () => {
    const host = new InProcessHost();
    const kinds = new Set<string>();
    for (const kase of corpus) {
      const loaded = await host.load(kase.modulePath, kase.exportName);
      const { response } = await host.invoke(loaded, kase.request, ruleEntry(kase.request.id));
      expect(response.ok).toBe(true);
      if (response.ok) {
        kinds.add((response.output as { readonly kind: string }).kind);
      }
    }
    expect(kinds).toEqual(new Set(["verdict", "request", "error"]));
  });

  test("adding a third stub entry to the registry makes the harness run three-way with no edit to its own source", async () => {
    const withThirdRow = [...HOSTS, alwaysAvailable(() => new DelegatingThirdHost(), "delegating-third")];
    const outcome = await runEquivalence(withThirdRow, corpus);
    expect(outcome.ok).toBe(true);
  });

  test("a response differing by one byte is reported divergent, naming the offset and both byte values", async () => {
    const descriptors = [
      alwaysAvailable(() => new InProcessHost(), "in-process"),
      alwaysAvailable(() => new DivergentResponseStubHost(), "divergent-response-stub"),
    ];
    const outcome = await runEquivalence(descriptors, [corpus[1]!]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === "divergence") {
      expect(outcome.divergence.kind).toBe("response");
      expect(outcome.divergence.message).toMatch(/byte offset \d+/);
      expect(outcome.divergence.caseLabel).toBe(corpus[1]!.label);
    } else {
      expect.fail("expected a response divergence");
    }
  });

  test("a read-log differing by one entry with byte-identical responses is reported divergent", async () => {
    const descriptors = [
      alwaysAvailable(() => new InProcessHost(), "in-process"),
      alwaysAvailable(() => new DivergentReadLogStubHost(), "divergent-read-log-stub"),
    ];
    const outcome = await runEquivalence(descriptors, [corpus[0]!]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === "divergence") {
      expect(outcome.divergence.kind).toBe("read-log");
      expect(outcome.divergence.message).toContain("read:never-actually-touched");
    } else {
      expect.fail("expected a read-log divergence");
    }
  });

  test("read-logs recording the same members in a different order agree", async () => {
    const descriptors = [
      alwaysAvailable(() => new InProcessHost(), "in-process"),
      alwaysAvailable(() => new ReorderedReadLogStubHost(), "reordered-read-log-stub"),
    ];
    const outcome = await runEquivalence(descriptors, corpus);
    expect(outcome.ok).toBe(true);
  });

  test("an empty corpus fails the harness with a message naming the corpus", async () => {
    const outcome = await runEquivalence(HOSTS, []);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === "empty-corpus") {
      expect(outcome.message).toContain("corpus");
    } else {
      expect.fail("expected the empty-corpus refusal");
    }
  });

  test("a run against a single available host fails naming the count", async () => {
    const outcome = await runEquivalence([alwaysAvailable(() => new InProcessHost(), "in-process")], corpus);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === "insufficient-hosts") {
      expect(outcome.message).toContain("1");
    } else {
      expect.fail("expected the insufficient-hosts refusal");
    }
  });

  test("a run against the same implementation registered twice fails the same way a single host does", async () => {
    const descriptors = [
      alwaysAvailable(() => new InProcessHost(), "in-process-a"),
      alwaysAvailable(() => new InProcessHost(), "in-process-b"),
    ];
    const outcome = await runEquivalence(descriptors, corpus);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("insufficient-hosts");
    }
  });
});
