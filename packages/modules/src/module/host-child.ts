import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createInterface } from "node:readline";
import { type Context, constants, createContext, Script } from "node:vm";

/** A reserved id this process answers outside the sandbox with what it can reach: a test
 * instrument, which callers across the process boundary spell as the same literal. */
const DIAGNOSTICS_REQUEST_ID = "musai-subprocess-host-diagnostics";

interface WireResponse {
  readonly ok: true;
  readonly output: unknown;
  readonly diagnostics: readonly unknown[];
}

/** Folded into a verdict's `reason`, so it validates against the rule-output schema. */
function diagnosticsResponse(): WireResponse {
  let fdEntries: readonly string[] | null;
  try {
    fdEntries = readdirSync("/dev/fd");
  } catch {
    fdEntries = null;
  }
  return {
    ok: true,
    output: {
      kind: "verdict",
      label: "open",
      reason: JSON.stringify({ envKeys: Object.keys(process.env), fdEntries }),
    },
    diagnostics: [],
  };
}

const CLOCK_DENIAL = "a contribution may not reach for the clock";
const RANDOMNESS_DENIAL = "a contribution may not draw randomness";

/** A top-level `export`, a syntax error in a script, dropped leaving its declaration. */
const TOP_LEVEL_EXPORT = /^export\s+(?=(?:const|let|function|class)\b)/gm;

/** `MODULE_BUNDLE_GLOBAL` of `@musai/devkit`, repeated by value; a raw gateway declares none. */
const BUNDLE_GLOBAL = "__musaiModule";

/** Node warns once per process that the stripper is experimental, a line every verb would print. */
function stripTypesQuietly(source: string): string {
  const emitWarning = process.emitWarning;
  process.emitWarning = () => undefined;
  try {
    return stripTypeScriptTypes(source, { mode: "strip" });
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** Compiled strict as the build compiles, every line in place. It mirrors `rule/sandbox-worker.ts`
 * rather than importing it: a spawned child maps no `.js` specifier to its `.ts` sibling. */
function compileModuleScript(source: string, modulePath: string): Script {
  const stripped = stripTypesQuietly(source);
  const scriptSource = stripped.replace(TOP_LEVEL_EXPORT, "");
  const body = scriptSource.startsWith("#!") ? `//${scriptSource.slice(2)}` : scriptSource;
  return new Script(`"use strict";${body}`, { filename: modulePath });
}

function forbidClockAndRandomness(context: Context): void {
  const forbiddenDate = (): never => {
    throw new Error(CLOCK_DENIAL);
  };
  forbiddenDate.now = (): never => {
    throw new Error(CLOCK_DENIAL);
  };
  context["Date"] = forbiddenDate;
  (context["Math"] as { random: () => number })["random"] = (): never => {
    throw new Error(RANDOMNESS_DENIAL);
  };
}

interface InvocationChannel {
  readonly request: Uint8Array;
  result: SandboxOutcome | undefined;
}

/** A context offering primitives and the two encoding classes, nothing that reaches outside. Left
 * unfrozen: a top-level `function` binds onto the global, so the caller freezes after it runs. */
function buildInvocationContext(requestBytes: Uint8Array): Context {
  const context = createContext(constants.DONT_CONTEXTIFY, { microtaskMode: "afterEvaluate" });
  forbidClockAndRandomness(context);
  context["TextEncoder"] = TextEncoder;
  context["TextDecoder"] = TextDecoder;
  const channel: InvocationChannel = { request: requestBytes, result: undefined };
  context["__musaiInvocation"] = channel;
  return context;
}

type SandboxOutcome =
  | { readonly kind: "settled"; readonly value: unknown }
  | { readonly kind: "threw"; readonly message: string }
  | { readonly kind: "unsettled" };

/** Calls the export with the request's raw bytes, off the bundle's global where a build declared
 * one and off the plain global otherwise. */
function buildCallSource(exportName: string): string {
  return [
    "Promise.resolve()",
    `  .then(() => (typeof ${BUNDLE_GLOBAL} !== "undefined" ? ${BUNDLE_GLOBAL}.${exportName} : ${exportName})(globalThis.__musaiInvocation.request))`,
    '  .then((value) => { globalThis.__musaiInvocation.result = { kind: "settled", value }; })',
    '  .catch((error) => { globalThis.__musaiInvocation.result = { kind: "threw", message: error instanceof Error ? error.message : String(error) }; });',
  ].join("\n");
}

/** Frozen after the module's top level runs and before the call script, so no global can be added
 * past that point. */
function runSandboxed(
  script: Script,
  exportName: string,
  modulePath: string,
  requestBytes: Uint8Array,
  timeLimitMs: number,
): SandboxOutcome {
  const context = buildInvocationContext(requestBytes);
  script.runInContext(context, { timeout: timeLimitMs, filename: modulePath });
  Object.freeze(context);
  const callScript = new Script(buildCallSource(exportName), { filename: `${modulePath}#invoke` });
  callScript.runInContext(context, { timeout: timeLimitMs });
  const channel = context["__musaiInvocation"] as InvocationChannel;
  return channel.result ?? { kind: "unsettled" };
}

/** Checked by `.code`: the error crosses realms, so an `instanceof` check would miss it. */
function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
  );
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

/** A failure the gateway's own code never got to answer, in the envelope's shape. */
function encodeFailure(code: string, message: string): Uint8Array {
  const text = JSON.stringify({ ok: false, error: { code, data: undefined, message } });
  return new TextEncoder().encode(text);
}

/** The gateway's response bytes untouched; only a failure it never answered is made here. */
function invokeOneRequest(
  script: Script,
  exportName: string,
  modulePath: string,
  requestBytes: Uint8Array,
  timeLimitMs: number,
): Uint8Array {
  try {
    const outcome = runSandboxed(script, exportName, modulePath, requestBytes, timeLimitMs);
    if (outcome.kind === "unsettled") {
      return encodeFailure("time-limit", "the invocation never concluded within its time limit");
    }
    if (outcome.kind === "threw") {
      return encodeFailure("contribution-threw", outcome.message);
    }
    if (!(outcome.value instanceof Uint8Array)) {
      return encodeFailure("contribution-threw", "the gateway's own export did not answer with bytes");
    }
    return outcome.value;
  } catch (error) {
    return encodeFailure(isTimeoutError(error) ? "time-limit" : "contribution-threw", describeError(error));
  }
}

const [, , modulePath, exportName, timeLimitArg] = process.argv;
if (modulePath === undefined || exportName === undefined || timeLimitArg === undefined) {
  process.stderr.write("host-child requires a module path, an export name and a time limit\n");
  process.exit(1);
}

const timeLimitMs = Number(timeLimitArg);
const source = readFileSync(modulePath, "utf8");
const script = compileModuleScript(source, modulePath);

/** One request per line, enough since a binary payload crosses as a blob reference. A line that
 * does not parse ends the process rather than guessing. */
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line: string) => {
  if (line.trim().length === 0) {
    return;
  }
  let requestId: unknown;
  try {
    requestId = (JSON.parse(line) as { readonly id?: unknown }).id;
  } catch (error) {
    process.stderr.write(
      `host-child received a line that does not parse as an envelope request: ${describeError(error)}\n`,
    );
    process.exit(1);
    return;
  }
  if (requestId === DIAGNOSTICS_REQUEST_ID) {
    process.stdout.write(`${JSON.stringify(diagnosticsResponse())}\n`);
    return;
  }
  const requestBytes = new TextEncoder().encode(line);
  const responseBytes = invokeOneRequest(script, exportName, modulePath, requestBytes, timeLimitMs);
  process.stdout.write(`${new TextDecoder().decode(responseBytes)}\n`);
});
