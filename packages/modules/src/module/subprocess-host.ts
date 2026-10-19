import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecipe } from "@musai/records";
import { KernelError, textOf } from "@musai/records";
import { performRecipe, type SpawnResult, signalOfExitCode } from "@musai/run";
import { packageRootFrom } from "@musai/store";
import {
  decodeResponse,
  type EnvelopeRequest,
  type EnvelopeResponse,
  encodeRequest,
  type InvokedContribution,
  validateEnvelopeInput,
  validateEnvelopeOutput,
} from "../rule/envelope.js";
import {
  DEFAULT_MEMORY_LIMIT_MB,
  DEFAULT_TIME_LIMIT_MS,
  HOST_DEADLINE_GRACE_MS,
  type HostInvocation,
  type InvocationLimits,
  RuleImportError,
  readLogForRequest,
} from "../rule/host.js";
import { checkRuleImports } from "../rule/imports.js";

/** Raised when the child could not be launched at all, before any request crossed the wire. */
export class SubprocessHostError extends KernelError {
  constructor(message: string) {
    super({ reason: "tool-unavailable", detail: message });
    this.name = "SubprocessHostError";
  }
}

/** What a runtime prints before it aborts a process that has run out of memory. */
const OUT_OF_MEMORY_DIAGNOSTIC = /out of memory|Reached heap limit/i;

/** The signals that end a child past its memory: the OS killer's, and the runtime's own abort. */
const MEMORY_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set(["SIGKILL", "SIGABRT"]);

/** What the deadline sends, then sends again to a child that lingers; any other was the child's. */
const DEADLINE_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set(["SIGTERM", "SIGKILL"]);

const ERROR_LINE = /^\w*Error(?: \[\w+\])?: .*/m;

const ERROR_LINE_MAX_CHARS = 200;

/** The child's first error line, so a compile error survives; a line naming a path is left out,
 * since the refusal is recorded and must read the same on every machine. */
function pathFreeErrorLine(output: string): string | undefined {
  const line = ERROR_LINE.exec(output)?.[0]?.trim().slice(0, ERROR_LINE_MAX_CHARS);
  return line === undefined || /[\\/]/.test(line) ? undefined : line;
}

interface LoadedModuleMeta {
  readonly modulePath: string;
  readonly exportName: string;
}

/** An opaque handle; nothing of a loaded module's shape leaks past this file. */
export interface SubprocessHandle {
  readonly __brand: "subprocess-handle";
}

/** `runtime` resolves on `PATH` like any declared binary, never assumed present. */
export interface SubprocessHostOptions {
  readonly runtime?: string;
  /** Replaceable so a test can run a misbehaving child without this host branching on it. */
  readonly childEntryPath?: string;
}

function defaultChildEntryPath(): string {
  const root = packageRootFrom(import.meta.url);
  const builtCandidate = join(root, "dist", "module", "host-child.js");
  if (existsSync(builtCandidate)) {
    return builtCandidate;
  }
  return join(root, "src", "module", "host-child.ts");
}

/** Runs each invocation in a fresh child sharing nothing with the kernel but envelope bytes.
 * Memory is capped at launch through the runtime's flag; time by the spawn's own timeout. */
export class SubprocessHost {
  readonly #runtime: string;
  readonly #childEntryPath: string;
  readonly #modules = new WeakMap<SubprocessHandle, LoadedModuleMeta>();

  constructor(options: SubprocessHostOptions = {}) {
    this.#runtime = options.runtime ?? "node";
    this.#childEntryPath = options.childEntryPath ?? defaultChildEntryPath();
  }

  /** Refused before any spawn by the same import scan `InProcessHost.load` applies. */
  async load(modulePath: string, exportName: string): Promise<SubprocessHandle> {
    const source = await readFile(modulePath, "utf8");
    const violations = checkRuleImports(source);
    if (violations.length > 0) {
      throw new RuleImportError(modulePath, violations);
    }
    const handle: SubprocessHandle = { __brand: "subprocess-handle" };
    this.#modules.set(handle, { modulePath, exportName });
    return handle;
  }

  /** Validates the request before a child spawns and the response after; every failure is a
   * response carrying a closed code, never a rejected promise. */
  async invoke(
    handle: SubprocessHandle,
    request: EnvelopeRequest,
    contribution: InvokedContribution,
    limits: InvocationLimits = {},
  ): Promise<HostInvocation> {
    const meta = this.#modules.get(handle);
    if (meta === undefined) {
      throw new TypeError("invoke was called with a handle this host did not load");
    }
    const effectiveLimits: Required<InvocationLimits> = {
      timeLimitMs: limits.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS,
      memoryLimitMb: limits.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB,
    };
    const readLog = readLogForRequest(request);
    const { entry, point } = contribution;

    if (request.contribution !== entry.kind) {
      return {
        response: {
          ok: false,
          error: {
            code: "unknown-contribution",
            data: { id: request.id, contribution: request.contribution, kind: entry.kind },
            message: `${request.id} was invoked at ${request.contribution}, but its entry answers at ${entry.kind}`,
          },
        },
        readLog,
      };
    }

    if (point.name !== entry.kind) {
      return {
        response: {
          ok: false,
          error: {
            code: "unknown-contribution",
            data: { id: request.id, kind: entry.kind, point: point.name },
            message: `${request.id} answers at ${entry.kind}, but the point it was handed is ${point.name}`,
          },
        },
        readLog,
      };
    }

    if (point.role !== "invoke") {
      return {
        response: {
          ok: false,
          error: {
            code: "unknown-contribution",
            data: { id: request.id, point: point.name, role: point.role },
            message: `${request.id} answers at ${point.name}, a ${point.role} point read from the fold and never invoked`,
          },
        },
        readLog,
      };
    }

    const inputValidation = validateEnvelopeInput(contribution, request);
    if (!inputValidation.ok) {
      return { response: { ok: false, error: inputValidation.error }, readLog };
    }

    const response = await this.#runInChild(meta, request, effectiveLimits);
    if (!response.ok) {
      return { response, readLog };
    }

    const outputValidation = validateEnvelopeOutput(contribution, response.output);
    if (!outputValidation.ok) {
      return { response: { ok: false, error: outputValidation.error }, readLog };
    }
    return { response, readLog };
  }

  /** Nothing crosses but the request's bytes in and a line out; a silent child is classed by what
   * ended it. */
  async #runInChild(
    meta: LoadedModuleMeta,
    request: EnvelopeRequest,
    limits: Required<InvocationLimits>,
  ): Promise<EnvelopeResponse> {
    const requestLine = `${new TextDecoder().decode(encodeRequest(request))}\n`;
    const recipe: RunRecipe = {
      command: [
        this.#runtime,
        "--no-warnings",
        `--max-old-space-size=${limits.memoryLimitMb}`,
        this.#childEntryPath,
        meta.modulePath,
        meta.exportName,
        String(limits.timeLimitMs),
      ],
      workingDirectory: process.cwd(),
      environment: {},
      declared: [],
      substrates: [],
      isolation: "hygiene",
    };

    let spawnResult: SpawnResult;
    try {
      spawnResult = await performRecipe(recipe, {
        input: requestLine,
        timeoutMs: limits.timeLimitMs + HOST_DEADLINE_GRACE_MS,
      });
    } catch (error) {
      throw new SubprocessHostError(
        `refusing to invoke ${request.id}: the child could not be launched on the one spawn path: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const output = textOf(spawnResult.observation.output, `the output of ${request.id}`);
    const decoded = lastDecodableLine(output);
    if (decoded !== undefined) {
      return decoded;
    }

    const { exitCode } = spawnResult.observation;
    const signal = signalOfExitCode(exitCode);
    // A child dumping core is reaped late, so the deadline can pass after its own signal ended it.
    if (spawnResult.timedOut && (signal === undefined || DEADLINE_SIGNALS.has(signal))) {
      return {
        ok: false,
        error: { code: "time-limit", data: undefined, message: "the invocation never concluded within its time limit" },
      };
    }
    if (exitCode !== 0) {
      if (OUT_OF_MEMORY_DIAGNOSTIC.test(output) || (signal !== undefined && MEMORY_SIGNALS.has(signal))) {
        return {
          ok: false,
          error: {
            code: "memory-limit",
            data: undefined,
            message: "the child ran out of memory without answering",
          },
        };
      }
      const excerpt = pathFreeErrorLine(output);
      return {
        ok: false,
        error: {
          code: "contribution-threw",
          data: undefined,
          message: `the child ended without answering${excerpt === undefined ? "" : `: ${excerpt}`}`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "contribution-threw",
        data: undefined,
        message: "the child ended without a line this boundary could decode as a response",
      },
    };
  }
}

/** The runtime's diagnostics share the channel, so the response is the last line that decodes. */
function lastDecodableLine(output: string): EnvelopeResponse | undefined {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      return decodeResponse(new TextEncoder().encode(line));
    } catch {
      // A line that does not decode is diagnostic text, not the answer.
    }
  }
  return undefined;
}
