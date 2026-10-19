import { buildRegistry, type OperationDescriptor } from "@musai/api-core";
import {
  CODE_CLASSES,
  codeForReason,
  REASON_CODES,
  REASONS,
  type Reason,
  STATUS_REASONS,
  versionString,
} from "@musai/records";
import { describe, expect, test } from "vitest";
import { REGISTRY } from "../src/index.js";

function fakeOperation(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    id: "fake.operation",
    version: versionString("1"),
    input: true,
    output: true,
    effect: "read",
    authority: null,
    plans: true,
    reasons: [],
    documentation: "a fake operation for reason-vocabulary tests",
    cli: { verb: "fake", positional: [], flags: [], describe: "a fake verb" },
    renderText: () => "",
    exitCode: () => 0,
    handler: async () => undefined,
    ...overrides,
  };
}

describe("stale has exactly one definition site", () => {
  test("the claim-status reason vocabulary and the closed reason vocabulary agree on the one string", () => {
    expect(STATUS_REASONS as readonly string[]).toContain("stale");
    expect(REASONS).toContain("stale");
  });

  test("every claim-status reason is a member of the one closed vocabulary, never a second array of its own", () => {
    for (const reason of STATUS_REASONS) {
      expect(REASONS as readonly string[]).toContain(reason);
    }
  });
});

describe("REASON_CODES is total over REASONS", () => {
  test("every declared reason maps to one of the six code classes", () => {
    for (const reason of REASONS) {
      expect(CODE_CLASSES as readonly string[]).toContain(codeForReason(reason));
      expect(REASON_CODES[reason]).toBe(codeForReason(reason));
    }
  });

  test("stale maps to refold, the class DESIGN.md's table fixes for a moved head", () => {
    expect(codeForReason("stale")).toBe("refold");
  });

  test("contested-authority maps to authority, the class for asking someone with the role", () => {
    expect(codeForReason("contested-authority")).toBe("authority");
  });
});

describe("a deprecated reason still resolves and cannot be newly declared", () => {
  test("buildRegistry refuses an operation declaring a deprecated reason", () => {
    const deprecated: ReadonlySet<Reason> = new Set(["recipe-changed"]);
    const operation = fakeOperation({ reasons: ["recipe-changed"] });
    expect(() => buildRegistry([operation], deprecated)).toThrow(/deprecated/);
  });
});

describe("the registry refuses a reason no operation declares outside the closed vocabulary", () => {
  test("a reason the vocabulary does not hold fails the registry build, naming the operation and the reason", () => {
    const operation = fakeOperation({ reasons: ["carrier-pigeon-lost" as Reason] });
    expect(() => buildRegistry([operation], new Set())).toThrow(/fake\.operation@1/);
    expect(() => buildRegistry([operation], new Set())).toThrow(/carrier-pigeon-lost/);
  });
});

describe("every reason in REASONS is either carried by a claim status or declared by some operation", () => {
  /** Declared by no operation: `recipe-changed` awaits one, and `invalid-output` is raised by the
   * gates an answer passes, never a verb. Any other orphan fails. */
  const RESERVED_FOR_A_LATER_OPERATION: readonly Reason[] = ["invalid-output", "recipe-changed"];

  /** Raised by a transport's dispatch before any descriptor is reached. */
  const DISPATCH_LEVEL_REASONS: readonly Reason[] = ["unknown-operation"];

  /** Raised beneath every operation by a store, runner or fold, and passed through as raised. */
  const KERNEL_LEVEL_REASONS: readonly Reason[] = [
    "workspace-incomplete",
    "tool-unavailable",
    "undeclared-binary",
    "record-corrupted",
    "declaration-conflict",
  ];

  test("no reason is an orphan beyond those reserved for an operation not yet built, or raised by the kernel and a transport's own dispatch layer", () => {
    const declaredByOperations = new Set<Reason>();
    for (const descriptor of REGISTRY.values()) {
      for (const reason of descriptor.reasons) {
        declaredByOperations.add(reason);
      }
    }
    const covered = new Set<Reason>([
      ...STATUS_REASONS,
      ...declaredByOperations,
      ...DISPATCH_LEVEL_REASONS,
      ...KERNEL_LEVEL_REASONS,
    ]);
    const orphans = REASONS.filter((reason) => !covered.has(reason));

    expect(orphans.sort()).toEqual([...RESERVED_FOR_A_LATER_OPERATION].sort());
  });

  test("claim.status@2, claim.why@3 and case.soundcheck@1 each declare no-such-record, the reason their own lookup can refuse with", () => {
    for (const key of ["claim.status@2", "claim.why@3", "case.soundcheck@1"]) {
      const descriptor = REGISTRY.get(key);
      expect(descriptor, `registry entry ${key}`).toBeDefined();
      expect(descriptor!.reasons).toContain("no-such-record");
    }
  });
});

describe("the verbs a cleared surface refuses as the author's", () => {
  test("the verbs working for the author alone are these", () => {
    const refusable = [...REGISTRY].filter(([, descriptor]) => descriptor.authorOnly === true);
    expect(refusable.map(([key]) => key).sort()).toEqual([
      "case.open@1",
      "case.save@1",
      "config.get@1",
      "config.set@1",
      "config.unset@1",
      "scope.drop@1",
      "scope.fork@1",
      "scope.list@1",
      "scope.merge@1",
      "store.relayout@1",
    ]);
  });
});

describe("a verb declares the refusals its own reads can raise", () => {
  const LABELLING: readonly Reason[] = ["declaration-conflict", "invalid-input", "sibling-conflict"];

  const RAISED: Readonly<Record<string, readonly Reason[]>> = {
    "claim.status@2": LABELLING,
    "claim.why@3": LABELLING,
    "case.soundcheck@1": LABELLING,
    "case.status@2": LABELLING,
    "case.open@1": LABELLING,
    "view.run@1": LABELLING,
    "gate.pending@1": LABELLING,
    "gate.ask@1": ["declaration-conflict", "invalid-input"],
    "gate.answer@2": [...LABELLING, "inapplicable"],
    "ruling.make@2": [...LABELLING, "inapplicable", "no-such-record"],
    "challenge.file@2": ["unsupported-format"],
  };

  test("every verb reading whether a claim applies, who holds its group, or a cited run's output, declares what those reads refuse with", () => {
    for (const [key, reasons] of Object.entries(RAISED)) {
      const descriptor = REGISTRY.get(key);
      expect(descriptor, `registry entry ${key}`).toBeDefined();
      for (const reason of reasons) {
        expect(descriptor!.reasons, `${key} declares ${reason}`).toContain(reason);
      }
    }
  });
});
