interface EnvelopeRequest {
  readonly protocol: number;
  readonly contribution: string;
  readonly id: string;
  readonly version: string;
  readonly input: unknown;
}

interface ContributionEntry {
  readonly kind: string;
  readonly id: string;
  readonly version: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly documentation: string;
}

const KIND_ID = "fixture-checkout/change";
const BUILDS_TYPE = "fixture-checkout/builds@1";

/** The core module's interpreter for a check with no code of its own. */
const DECLARATIVE = "musai.core/declarative";

/** Silent and exiting 1 on any failure, so a failed run's output never differs between runs.
 * It succeeds only where the recipe put `git` on the child's `PATH`. */
const BUILD_SCRIPT =
  'try { require("node:child_process").execFileSync("git", ["rev-parse", "--verify", "HEAD^{tree}"], { stdio: "ignore" }) } catch { process.exit(1) }';

const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "kind",
    id: KIND_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "a change booked about the commit it stands on, with one check run in that commit's checkout",
  },
  {
    kind: "claim-type",
    id: BUILDS_TYPE,
    version: "1",
    input: { identityDimensions: ["case"] },
    output: true,
    documentation: "that the commit a change stands on builds, identified by the change it belongs to",
  },
];

interface KindInput {
  readonly slug: string;
  readonly about: readonly string[];
  readonly overrides: Readonly<Record<string, unknown>>;
}

/** Runs in the checkout bound to `checkout` at `commit`, with `git` on the child's `PATH`. */
function declarativeParameters(commit: string): string {
  return JSON.stringify({
    recipes: [
      {
        name: "build",
        kind: "run",
        recipe: {
          command: ["node", "-e", BUILD_SCRIPT],
          workingDirectory: ".",
          environment: {},
          declared: [],
          substrates: [{ name: "checkout", digest: { gitCommit: commit } }],
          isolation: "hygiene",
          tooling: ["git"],
        },
      },
    ],
    expectations: [{ kind: "exitCodeIs", recipe: "build", value: 0 }],
  });
}

/** A change's setlist: one claim, that the commit it is about builds. */
function openSetlist(input: KindInput, commit: string): unknown {
  return {
    claims: [
      {
        type: BUILDS_TYPE,
        conditions: { case: input.slug, [DECLARATIVE]: declarativeParameters(commit) },
        canonical: { case: input.slug, commit },
        rendering: ["the commit", commit, "builds"].join(" "),
        about: [...input.about],
        exclusiveGroup: null,
      },
    ],
  };
}

function respond(output: unknown): Uint8Array {
  const text = JSON.stringify({ ok: true, output, diagnostics: [] });
  return new TextEncoder().encode(text);
}

function respondError(code: string, data: unknown, message: string): Uint8Array {
  const text = JSON.stringify({ ok: false, error: { code, data, message } });
  return new TextEncoder().encode(text);
}

/** The one export the envelope defines: canonical-JSON bytes in, bytes out. */
export function invoke(requestBytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(requestBytes);
  const request = JSON.parse(text) as EnvelopeRequest;

  if (request.contribution === "describe") {
    return respond(CONTRIBUTIONS);
  }
  if (request.contribution === "kind" && request.id === KIND_ID) {
    const input = request.input as KindInput;
    const commit = input.about[0];
    if (commit === undefined) {
      return respondError("invalid-input", { id: request.id }, "a change is booked about the commit it stands on");
    }
    return respond(openSetlist(input, commit));
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    [request.id, "names a contribution this module does not answer"].join(" "),
  );
}
