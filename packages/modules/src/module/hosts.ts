import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecipe, VersionString } from "@musai/records";
import { performRecipe, resolveBinaries } from "@musai/run";
import type { RuleInput, RuleOutput } from "../rule/contract.js";
import {
  ENVELOPE_PROTOCOL,
  type EnvelopeRequest,
  type EnvelopeResponse,
  type InvokedContribution,
} from "../rule/envelope.js";
import type { HostInvocation, InvocationLimits, Invoker } from "../rule/host.js";
import { InProcessHost } from "../rule/host.js";
import { SubprocessHost } from "./subprocess-host.js";

/** A module host. `load` answers an opaque handle, never a callable that could reach around the
 * envelope. */
export interface ModuleHost<Loaded = unknown> {
  load(modulePath: string, exportName: string): Promise<Loaded>;
  /** Invokes one contribution; its entry and point are handed in, since a host holds no fold. */
  invoke(
    loaded: Loaded,
    request: EnvelopeRequest,
    contribution: InvokedContribution,
    limits?: InvocationLimits,
  ): Promise<HostInvocation>;
  /** Releases a live resource, such as a worker, that would keep the caller's process running. */
  close?(): Promise<void>;
}

/** A bundle may hold several contributions, so one is named by id and version. */
export interface HostContribution extends InvokedContribution {
  readonly id: string;
  readonly version: VersionString;
}

/** Adapts a host bound to one loaded module into a rule invoker; an envelope failure becomes an
 * error output. The request names `rule`, so a host refuses a non-rule entry. */
export function invokerFromModuleHost<Loaded>(
  host: ModuleHost<Loaded>,
  loaded: Loaded,
  contribution: HostContribution,
  limits?: InvocationLimits,
): Invoker {
  return {
    invoke: async (input: RuleInput) => {
      const request: EnvelopeRequest = {
        protocol: ENVELOPE_PROTOCOL,
        contribution: "rule",
        id: contribution.id,
        version: contribution.version,
        input,
      };
      const { response, readLog }: HostInvocation = await host.invoke(loaded, request, contribution, limits);
      if (!response.ok) {
        return { output: { kind: "error", error: response.error }, readLog };
      }
      return { output: response.output as RuleOutput, readLog };
    },
  };
}

export interface HostDescriptor {
  readonly name: string;
  readonly available: () => boolean | Promise<boolean>;
  readonly create: () => ModuleHost;
}

/** Exits non-zero where the runtime's `node:vm` lacks the export the child's context needs. */
const VM_SUPPORT_PROBE_SCRIPT = [
  "import { constants } from 'node:vm';",
  "if (constants === undefined || constants.DONT_CONTEXTIFY === undefined) {",
  "  process.exit(1);",
  "}",
].join("\n");

let vmSupportProbePath: Promise<string> | undefined;

function vmSupportProbeScriptPath(): Promise<string> {
  vmSupportProbePath ??= (async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "musai-runtime-probe-"));
    const scriptPath = join(scratchDir, "vm-support-probe.mjs");
    await writeFile(scriptPath, VM_SUPPORT_PROBE_SCRIPT);
    return scriptPath;
  })();
  return vmSupportProbePath;
}

/** Being on `PATH` is not enough: a runtime whose `node:vm` cannot build the child's context
 * would fail deep in a child rather than at the probe. */
async function alternativeRuntimeAvailable(name: string): Promise<boolean> {
  try {
    await resolveBinaries([name]);
  } catch {
    return false;
  }
  const scriptPath = await vmSupportProbeScriptPath();
  const probe: RunRecipe = {
    command: [name, scriptPath],
    workingDirectory: process.cwd(),
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  };
  try {
    const result = await performRecipe(probe, { timeoutMs: 5000 });
    return result.observation.exitCode === 0;
  } catch {
    return false;
  }
}

/** Every host a caller compares or chooses from, in order; no caller names a host class. */
export const HOSTS: readonly HostDescriptor[] = [
  {
    name: "in-process",
    available: () => true,
    create: () => new InProcessHost(),
  },
  {
    name: "subprocess-node",
    available: () => true,
    create: () => new SubprocessHost({ runtime: "node" }),
  },
  // Optional, since its platform support is partial; the two rows above are the minimum compared.
  {
    name: "subprocess-bun",
    available: () => alternativeRuntimeAvailable("bun"),
    create: () => new SubprocessHost({ runtime: "bun" }),
  },
];

export async function firstAvailableHost(hosts: readonly HostDescriptor[]): Promise<HostDescriptor | undefined> {
  for (const candidate of hosts) {
    if (await candidate.available()) {
      return candidate;
    }
  }
  return undefined;
}

/** Chooses a host, invokes the bundle through it and always closes it; `undefined` where this
 * machine offers no host. */
export async function invokeThroughHost(
  modulePath: string,
  request: EnvelopeRequest,
  contribution: InvokedContribution,
  limits?: InvocationLimits,
): Promise<EnvelopeResponse | undefined> {
  const descriptor = await firstAvailableHost(HOSTS);
  if (descriptor === undefined) {
    return undefined;
  }
  const host = descriptor.create();
  try {
    const loaded = await host.load(modulePath, "invoke");
    const { response } = await host.invoke(loaded, request, contribution, limits);
    return response;
  } finally {
    await host.close?.();
  }
}
