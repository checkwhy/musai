import {
  ENVELOPE_PROTOCOL,
  type EnvelopeRequest,
  type EnvelopeResponse,
  firstAvailableHost,
  HOSTS,
  pointFor,
  queryFor,
  readQueryDeclarations,
} from "@musai/modules";
import type { ContributionEntry, ModuleManifest } from "@musai/records";
import { buildAdmissionWorkspace } from "./admission.js";
import { OperationError } from "./errors.js";
import { installedModules } from "./events.js";
import type { Workspace } from "./workspace.js";

/** Read from the module record, never the bundle: a receiver audits it without running it. */
export interface NamedManifest {
  readonly moduleName: string;
  readonly manifest: ModuleManifest;
}

/** Every installed module's manifest, by module name ascending. */
export async function installedManifests(opened: Workspace): Promise<readonly NamedManifest[]> {
  const installed = await installedModules(opened);
  const manifests: NamedManifest[] = [];
  for (const [moduleName, entry] of installed.byName) {
    const record = opened.read(entry.moduleRecordId);
    if (record.kind === "module") {
      manifests.push({ moduleName, manifest: record.manifest });
    }
  }
  return manifests;
}

/** Answers a contribution through the first available host, or from the fold for a `query`. */
export async function invokeContribution(
  opened: Workspace,
  moduleName: string,
  entry: ContributionEntry,
  input: unknown,
): Promise<EnvelopeResponse> {
  const point = pointFor(entry.kind, opened.index);
  if (point === undefined) {
    throw new OperationError({
      reason: "no-such-record",
      about: [entry.id, entry.kind],
      detail: `the workspace holds no point named ${entry.kind}, the kind contribution ${entry.id} names`,
    });
  }

  // A query opens no bundle, so it is answered before any bundle path is resolved.
  if (point.role === "data") {
    if (entry.kind !== "query") {
      throw new OperationError({
        reason: "no-such-record",
        about: [entry.id, entry.kind],
        detail: `contribution ${entry.id} answers at ${entry.kind}, a point read from the fold rather than called, so there is nothing here to invoke`,
      });
    }
    const declaration = queryFor(entry.id, readQueryDeclarations(opened.index));
    const rows = opened.index.runQuery(declaration, input as Record<string, unknown>);
    return { ok: true, output: { rows }, diagnostics: [] };
  }

  const installed = await installedModules(opened);
  const admission = await buildAdmissionWorkspace(opened, installed);

  const hostDescriptor = await firstAvailableHost(HOSTS);
  if (hostDescriptor === undefined) {
    throw new OperationError({
      reason: "no-such-record",
      about: [entry.id],
      detail: "this machine provides no host this kernel can invoke a contribution through",
    });
  }

  const host = hostDescriptor.create();
  try {
    const loaded = await host.load(admission.modulePath(moduleName), "invoke");
    const request: EnvelopeRequest = {
      protocol: ENVELOPE_PROTOCOL,
      contribution: entry.kind,
      id: entry.id,
      version: entry.version,
      input,
    };
    const { response } = await host.invoke(loaded, request, { entry, point }, admission.invocationLimits);
    return response;
  } finally {
    await host.close?.();
  }
}
