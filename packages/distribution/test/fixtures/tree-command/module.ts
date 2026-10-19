interface EnvelopeRequest {
  readonly contribution: string;
  readonly id: string;
  readonly input: unknown;
}

interface RuleInput {
  readonly conditions: Readonly<Record<string, string>>;
  readonly evidence: readonly { readonly exitCode: number }[];
  readonly refusals?: readonly { readonly error: { readonly message: string } }[];
}

interface SaysHelloInput {
  readonly expectation: { readonly recipe: string };
  readonly evidence: Readonly<Record<string, { readonly output: unknown }>>;
}

const RULE_ID = "tree-command/exits-cleanly";
const KIND_ID = "tree-command/watch";
const PAIR_KIND_ID = "tree-command/pair";
const PRINTS_KIND_ID = "tree-command/prints";
const DECIDED_HERE_KIND_ID = "tree-command/decided-here";
const SAYS_HELLO_ID = "tree-command/says-hello";
const KIND_IDS = [KIND_ID, PAIR_KIND_ID, PRINTS_KIND_ID, DECIDED_HERE_KIND_ID];
const CLAIM_TYPE = "tree-command/tracked@1";
const DECLARATIVE = "musai.core/declarative";
const TRACKED_IS_HELLO = ["node", "-e", "process.exit(require('fs').readFileSync('tracked.txt','utf8')==='hello'?0:1)"];
const TRACKED_IS_FILLED = ["node", "-e", "process.exit(require('fs').readFileSync('tracked.txt','utf8').length>0?0:1)"];
const PRINTS_TRACKED = ["node", "-e", "process.stdout.write(require('fs').readFileSync('tracked.txt','utf8'))"];

const CONTRIBUTIONS = [
  {
    kind: "kind",
    id: KIND_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "a watch over the tracked file: one claim this module's rule settles, one the interpreter",
  },
  {
    kind: "kind",
    id: PAIR_KIND_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "one claim the interpreter settles over two runs reading the tracked file",
  },
  {
    kind: "kind",
    id: PRINTS_KIND_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "one claim the interpreter settles over one run, by what that run prints",
  },
  {
    kind: "kind",
    id: DECIDED_HERE_KIND_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "one claim the interpreter settles over one run, by an expectation this module decides",
  },
  {
    kind: "expectation",
    id: SAYS_HELLO_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "met when the named recipe's run printed hello",
  },
  {
    kind: "claim-type",
    id: CLAIM_TYPE,
    version: "1",
    input: { identityDimensions: ["case", "says"] },
    output: true,
    documentation: "what the tracked file says, identified by the booking and the saying",
  },
  {
    kind: "rule",
    id: RULE_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "holds when the command its condition names exits cleanly in the project's working tree",
  },
];

interface KindInput {
  readonly slug: string;
  readonly about: readonly string[];
}

function inTree(command: readonly string[]): unknown {
  return {
    command,
    workingDirectory: ".",
    environment: {},
    declared: [],
    substrates: [{ name: "tree", uri: "musai:tree" }],
    isolation: "hygiene",
  };
}

/** Each named command a recipe the interpreter runs, each expected to exit cleanly. */
function interpreted(commands: Readonly<Record<string, readonly string[]>>): string {
  const names = Object.keys(commands);
  return JSON.stringify({
    recipes: names.map((name) => ({ name, kind: "run", recipe: inTree(commands[name]!) })),
    expectations: names.map((name) => ({ kind: "exitCodeIs", recipe: name, value: 0 })),
  });
}

function printsTracked(expectation: unknown): string {
  return JSON.stringify({
    recipes: [{ name: "prints", kind: "run", recipe: inTree(PRINTS_TRACKED) }],
    expectations: [expectation],
  });
}

function setlist(input: KindInput, claims: readonly (readonly [string, string, string])[]): unknown {
  return {
    claims: claims.map(([says, rule, parameters]) => ({
      type: CLAIM_TYPE,
      conditions: { case: input.slug, says, [rule]: parameters },
      canonical: { case: input.slug, says },
      rendering: "the tracked file says " + says + " in " + input.slug,
      about: [...input.about],
      exclusiveGroup: null,
    })),
  };
}

function openSetlist(id: string, input: KindInput): unknown {
  if (id === PAIR_KIND_ID) {
    const both = interpreted({ filled: TRACKED_IS_FILLED, hello: TRACKED_IS_HELLO });
    return setlist(input, [["something and hello", DECLARATIVE, both]]);
  }
  if (id === PRINTS_KIND_ID) {
    const printed = printsTracked({ kind: "equals", selector: { recipe: "prints", field: "output" }, value: "hello" });
    return setlist(input, [["hello when printed", DECLARATIVE, printed]]);
  }
  if (id === DECIDED_HERE_KIND_ID) {
    const decided = printsTracked({ kind: SAYS_HELLO_ID, recipe: "prints" });
    return setlist(input, [["hello as this module reads it", DECLARATIVE, decided]]);
  }
  return setlist(input, [
    ["hello", RULE_ID, JSON.stringify(TRACKED_IS_HELLO)],
    ["something", DECLARATIVE, interpreted({ tracked: TRACKED_IS_FILLED })],
  ]);
}

function decide(input: RuleInput): unknown {
  const refusal = input.refusals?.[0];
  if (refusal !== undefined) {
    return { kind: "verdict", label: "open", reason: refusal.error.message };
  }
  const run = input.evidence[0];
  if (run === undefined) {
    const recipe = inTree(JSON.parse(input.conditions[RULE_ID]!) as string[]);
    return { kind: "request", needs: [{ kind: "run", recipe }] };
  }
  return run.exitCode === 0
    ? { kind: "verdict", label: "holds", reason: "the command exited cleanly" }
    : { kind: "verdict", label: "fails", reason: "the command exited " + run.exitCode };
}

function saysHello(input: SaysHelloInput): unknown {
  const met = input.evidence[input.expectation.recipe]?.output === "hello";
  return { met, reason: met ? "it printed hello" : "it did not print hello" };
}

function respond(response: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(response));
}

export function invoke(requestBytes: Uint8Array): Uint8Array {
  const request = JSON.parse(new TextDecoder().decode(requestBytes)) as EnvelopeRequest;
  if (request.contribution === "describe") {
    return respond({ ok: true, output: CONTRIBUTIONS, diagnostics: [] });
  }
  if (request.contribution === "kind" && KIND_IDS.includes(request.id)) {
    return respond({ ok: true, output: openSetlist(request.id, request.input as KindInput), diagnostics: [] });
  }
  if (request.contribution === "rule" && request.id === RULE_ID) {
    return respond({ ok: true, output: decide(request.input as RuleInput), diagnostics: [] });
  }
  if (request.contribution === "expectation" && request.id === SAYS_HELLO_ID) {
    return respond({ ok: true, output: saysHello(request.input as SaysHelloInput), diagnostics: [] });
  }
  const message = request.id + " names a contribution this module does not answer";
  return respond({ ok: false, error: { code: "unknown-contribution", data: { id: request.id }, message } });
}
