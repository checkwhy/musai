import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { Script } from "node:vm";
import { Worker } from "node:worker_threads";
import type { SlotRegistry } from "@musai/records";
import { conditionReadText, KernelError, resolveSlot, type SlotLayers } from "@musai/records";
import { packageRootFrom } from "@musai/store";
import type { RuleInput, RuleOutput } from "./contract.js";
import {
  decodeResponse,
  type EnvelopeRequest,
  type EnvelopeResponse,
  encodeRequest,
  type InvokedContribution,
  isWellFormedRuleInput,
  validateEnvelopeInput,
  validateEnvelopeOutput,
} from "./envelope.js";
import { checkRuleImports, type ImportViolation } from "./imports.js";
import { type ReadLog, recordRead } from "./read-log.js";

export interface InvokeRuleResult {
  readonly output: RuleOutput;
  readonly readLog: ReadLog;
}

/** What the input made readable, never what the rule says it read, so a rule cannot keep a stale
 * status current by under-reporting. */
function readsFromInput(input: RuleInput): Set<string> {
  const reads = new Set<string>();
  for (const [dimension, value] of Object.entries(input.conditions)) {
    reads.add(`dim:${dimension}=${conditionReadText(value)}`);
  }
  for (const evidence of input.evidence) {
    reads.add(`evidence:${evidence.runId}`);
  }
  for (const invocation of input.invocations ?? []) {
    reads.add(`invoke:${invocation.moduleRecord}`);
  }
  return reads;
}

/** The read log a request stands for. Another kind reads nothing here: a parser's reads are the
 * observation already recorded on its run. An input that is no rule input made nothing readable. */
export function readLogForRequest(request: EnvelopeRequest): ReadLog {
  if (request.contribution === "rule" && isWellFormedRuleInput(request.input)) {
    const input = request.input as RuleInput;
    return recordRead(input.claimId, readsFromInput(input));
  }
  return recordRead(request.id, []);
}

/** One round of the restart loop, however its output was produced. */
export interface Invoker {
  invoke(input: RuleInput): Promise<InvokeRuleResult>;
}

export class RuleImportError extends KernelError {
  readonly modulePath: string;
  readonly violations: readonly ImportViolation[];

  constructor(modulePath: string, violations: readonly ImportViolation[]) {
    super({
      reason: "invalid-input",
      detail: RuleImportError.describe(modulePath, violations),
      about: [modulePath],
    });
    this.name = "RuleImportError";
    this.modulePath = modulePath;
    this.violations = violations;
  }

  private static describe(modulePath: string, violations: readonly ImportViolation[]): string {
    const lines = violations.map((violation) => `  ${violation.specifier} (line ${violation.line})`);
    return `${modulePath} declares a dependency the rule contract does not permit, or interpolates a template literal the scan cannot see into:\n${lines.join("\n")}`;
  }
}

export interface HostInvocation {
  readonly response: EnvelopeResponse;
  readonly readLog: ReadLog;
}

/** A top-level `export`, a syntax error in a script, dropped leaving its declaration. */
const TOP_LEVEL_EXPORT = /^export\s+(?=(?:const|let|function|class)\b)/gm;

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

/** The smallest transform that runs a hand-written gateway in a vm context without a build,
 * compiled strict as the build compiles and with every line in place. */
function compileModuleScript(source: string, modulePath: string): Script {
  const stripped = stripTypesQuietly(source);
  const scriptSource = stripped.replace(TOP_LEVEL_EXPORT, "");
  const body = scriptSource.startsWith("#!") ? `//${scriptSource.slice(2)}` : scriptSource;
  return new Script(`"use strict";${body}`, { filename: modulePath });
}

/** The default bounds, shared by every host so two hosts compared run under one bound. */
export const DEFAULT_TIME_LIMIT_MS = 2000;
export const DEFAULT_MEMORY_LIMIT_MB = 64;

/** How long a host waits past the time limit: the second bound, for an invocation wedged below
 * its script layer where the execution bound cannot stop it. */
export const HOST_DEADLINE_GRACE_MS = 500;

interface LoadedModuleMeta {
  readonly source: string;
  readonly exportName: string;
  readonly modulePath: string;
}

/** Resolved from the invocation-limits slot; a host falls back to the defaults for either. */
export interface InvocationLimits {
  readonly timeLimitMs?: number;
  readonly memoryLimitMb?: number;
}

export const INVOCATION_LIMITS_SLOT_ID = "musai.core/invocation-limits";

/** The limits the registry resolves to through `layers`, resolved once by a caller and handed to
 * every host it invokes. */
export function invocationLimitsFromSlots(registry: SlotRegistry, layers: SlotLayers = {}): InvocationLimits {
  const resolution = resolveSlot(INVOCATION_LIMITS_SLOT_ID, registry, layers);
  const value = resolution.value as { readonly timeLimitMs: number; readonly memoryLimitMb: number };
  return { timeLimitMs: value.timeLimitMs, memoryLimitMb: value.memoryLimitMb };
}

interface WorkerHandle {
  readonly worker: Worker;
  readonly timeLimitMs: number;
  readonly memoryLimitMb: number;
}

/** The built worker entry, else its source. Node loads a worker's entry directly, with no `.ts`
 * mapping and not from wherever a bundler flattened this file. */
function sandboxWorkerUrl(): URL {
  const root = packageRootFrom(import.meta.url);
  const builtCandidate = join(root, "dist", "rule", "sandbox-worker.js");
  if (existsSync(builtCandidate)) {
    return pathToFileURL(builtCandidate);
  }
  return pathToFileURL(join(root, "src", "rule", "sandbox-worker.ts"));
}

/** A worker, because a heap limit belongs to an isolate and a main-thread context has none. The
 * process-wide heap flags are cleared first, or `NODE_OPTIONS` would lift every worker's cap. */
function spawnWorker(meta: LoadedModuleMeta, limits: Required<InvocationLimits>): Worker {
  setFlagsFromString("--max-old-space-size=0");
  setFlagsFromString("--max-heap-size=0");
  return new Worker(sandboxWorkerUrl(), {
    workerData: {
      source: meta.source,
      exportName: meta.exportName,
      modulePath: meta.modulePath,
      timeLimitMs: limits.timeLimitMs,
    },
    resourceLimits: { maxOldGenerationSizeMb: limits.memoryLimitMb },
  });
}

/** A worker error is the shape a memory-limit breach takes, since the worker answers every other
 * failure as a message. */
function invokeViaWorker(worker: Worker, request: EnvelopeRequest, timeLimitMs: number): Promise<EnvelopeResponse> {
  return new Promise((resolve) => {
    let settled = false;

    function cleanup(): void {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
    }

    function onMessage(responseBytes: Uint8Array): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        resolve(decodeResponse(responseBytes));
      } catch (error) {
        resolve({
          ok: false,
          error: {
            code: "contribution-threw",
            data: undefined,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    function onError(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ ok: false, error: { code: "memory-limit", data: undefined, message: error.message } });
    }

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        ok: false,
        error: { code: "time-limit", data: undefined, message: "the invocation never concluded within its time limit" },
      });
    }, timeLimitMs + HOST_DEADLINE_GRACE_MS);

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.postMessage(encodeRequest(request));
  });
}

/** An opaque handle; nothing of a loaded module's shape leaks past this file. */
export interface InProcessHandle {
  readonly __brand: "in-process-handle";
}

/** Runs the modules a distribution ships, in one worker per loaded module and a fresh context per
 * invocation, bounded in time and memory. */
export class InProcessHost {
  #modules = new WeakMap<InProcessHandle, LoadedModuleMeta>();
  #workers = new Map<InProcessHandle, WorkerHandle>();

  /** Compiled once so an unparseable source fails at load; a `Script` cannot cross into the
   * worker, which recompiles the source. */
  async load(modulePath: string, exportName: string): Promise<InProcessHandle> {
    const source = await readFile(modulePath, "utf8");
    const violations = checkRuleImports(source);
    if (violations.length > 0) {
      throw new RuleImportError(modulePath, violations);
    }
    compileModuleScript(source, modulePath);
    const handle: InProcessHandle = { __brand: "in-process-handle" };
    this.#modules.set(handle, { source, exportName, modulePath });
    return handle;
  }

  /** Started afresh when the limits differ; a worker that hit a limit was dropped, never reused. */
  #workerFor(loaded: InProcessHandle, meta: LoadedModuleMeta, limits: Required<InvocationLimits>): WorkerHandle {
    const existing = this.#workers.get(loaded);
    if (
      existing !== undefined &&
      existing.timeLimitMs === limits.timeLimitMs &&
      existing.memoryLimitMb === limits.memoryLimitMb
    ) {
      return existing;
    }
    void existing?.worker.terminate();
    const handle: WorkerHandle = {
      worker: spawnWorker(meta, limits),
      timeLimitMs: limits.timeLimitMs,
      memoryLimitMb: limits.memoryLimitMb,
    };
    this.#workers.set(loaded, handle);
    return handle;
  }

  /** Validates the request before the worker runs it and the response after; every failure is a
   * response carrying a closed code, never a rejected promise. */
  async invoke(
    loaded: InProcessHandle,
    request: EnvelopeRequest,
    contribution: InvokedContribution,
    limits: InvocationLimits = {},
  ): Promise<HostInvocation> {
    const meta = this.#modules.get(loaded);
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

    const handle = this.#workerFor(loaded, meta, effectiveLimits);
    const response = await invokeViaWorker(handle.worker, request, effectiveLimits.timeLimitMs);

    if (!response.ok) {
      if (response.error.code === "time-limit" || response.error.code === "memory-limit") {
        void handle.worker.terminate();
        this.#workers.delete(loaded);
      }
      return { response, readLog };
    }

    const outputValidation = validateEnvelopeOutput(contribution, response.output);
    if (!outputValidation.ok) {
      return { response: { ok: false, error: outputValidation.error }, readLog };
    }
    return { response, readLog };
  }

  /** A live worker keeps the process running, so a caller done with this host closes it. */
  async close(): Promise<void> {
    const workers = [...this.#workers.values()];
    this.#workers.clear();
    await Promise.all(workers.map((handle) => handle.worker.terminate()));
  }
}
