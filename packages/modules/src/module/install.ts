import type { DeclaredFoldTable, FoldEngine, IndexDb } from "@musai/fold";
import type { ContributionEntry, ModuleManifest, ModuleRecord, VersionString } from "@musai/records";
import { CURRENT_SCHEMA_VERSIONS, KernelError, type RecordId, rawId, validateRecord } from "@musai/records";
import { ConflictingRequirementError, requirementsFromModules } from "@musai/run";
import type { BlobStore, Store } from "@musai/store";
import { isWellFormedRequirementInput, kernelPoint } from "../rule/envelope.js";
import { FoldRefusedError, foldTablesFrom } from "./fold-registry.js";
import { pointRegistryFrom } from "./point-registry.js";
import { QueryRefusedError, queryDeclarationFromEntry } from "./query-registry.js";
import { partitionRequirementRows } from "./requirements.js";
import { refuseUnregistrableSlots } from "./slot-registry.js";

/** Raised when a contribution answers at a point that neither the kernel, the workspace nor its
 * own manifest declares. */
export class UnknownContributionPointError extends KernelError {
  constructor(module: string, contribution: string, point: string) {
    super({
      reason: "declaration-conflict",
      detail: `refusing to install ${module}, contribution ${contribution} answers at the point ${point}, which neither this kernel ships nor this workspace holds`,
      about: [module, contribution, point],
    });
    this.name = "UnknownContributionPointError";
  }
}

/** Raised when a module under another name holds the contribution id, which only nested names
 * reach; a reader resolving it by id would silently drop one. */
export class ContributionIdHeldError extends KernelError {
  constructor(module: string, contribution: string, holder: string) {
    super({
      reason: "declaration-conflict",
      detail: `refusing to install ${module}, contribution ${contribution} is already declared by the module ${holder}`,
      about: [module, contribution, holder],
    });
    this.name = "ContributionIdHeldError";
  }
}

/** Asked of an installed query, so an install is refused only for a query it would break. */
function standsAgainst(entry: ContributionEntry, tables: readonly DeclaredFoldTable[], engine: FoldEngine): boolean {
  try {
    queryDeclarationFromEntry(entry, tables, engine);
    return true;
  } catch (error) {
    if (error instanceof QueryRefusedError) {
      return false;
    }
    throw error;
  }
}

export interface InstalledModuleEntry {
  readonly moduleRecordId: RecordId;
  readonly version: VersionString;
}

/** The installed set, keyed by module name; names compare as exact bytes, so case and Unicode
 * normalisation each make a different name. */
export interface InstalledModules {
  readonly byName: ReadonlyMap<string, InstalledModuleEntry>;
}

export const EMPTY_INSTALLED_MODULES: InstalledModules = { byName: new Map() };

export interface InstallModuleResult {
  readonly moduleRecordId: RecordId;
  readonly bundleId: RecordId;
}

/** Mints a module record over its bundle, refusing before any write a manifest whose declarations
 * the workspace would refuse. Reinstalling the bytes a name resolves to commits nothing. */
export async function installModule(
  name: string,
  version: VersionString,
  manifest: ModuleManifest,
  bundleBytes: Uint8Array,
  buildReceiptId: RecordId,
  store: Store,
  blobs: BlobStore,
  index: IndexDb,
): Promise<InstallModuleResult> {
  // Validated first, so nothing reads into a manifest the record refuses and none leaves a blob.
  const bundleId = rawId(bundleBytes);
  const moduleRecord: ModuleRecord = {
    kind: "module",
    // A name resolves by history; naming the replaced record would make a reinstall a new record.
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name,
    version,
    manifest,
    bundle: bundleId,
    build: buildReceiptId,
  };
  const validation = validateRecord(moduleRecord);
  if (!validation.ok) {
    throw new KernelError({
      reason: "invalid-input",
      detail: `refusing to install ${name}: ${validation.error}`,
      about: [name],
    });
  }
  for (const entry of manifest.contributions) {
    if (entry.kind === "requirement" && !isWellFormedRequirementInput(entry.input)) {
      throw new KernelError({
        reason: "invalid-input",
        detail: `refusing to install ${name}: the requirement ${entry.id} does not declare a binary, a version predicate, what needs it and how to install it`,
        about: [name, entry.id],
      });
    }
  }

  // The manifest's rows come first, so a conflict it causes names this module first.
  const requirementConflict = [
    ...requirementsFromModules([
      ...manifest.contributions
        .filter((entry) => entry.kind === "requirement")
        .map((entry) => ({ entry, moduleName: name })),
      ...partitionRequirementRows(index.contributionsOf("requirement").filter((row) => row.moduleName !== name))
        .wellFormed,
    ]).conflicts.values(),
  ].find((conflict) => conflict.first === name);
  if (requirementConflict !== undefined) {
    throw new ConflictingRequirementError(
      requirementConflict.binary,
      requirementConflict.first,
      requirementConflict.second,
    );
  }

  // Gathered before any contribution is checked, so declaration order never decides the outcome.
  const points = pointRegistryFrom([
    ...index.contributionsOf("point").filter((row) => row.moduleName !== name),
    ...manifest.contributions.filter((entry) => entry.kind === "point").map((entry) => ({ entry, moduleName: name })),
  ]);
  for (const entry of manifest.contributions) {
    if (kernelPoint(entry.kind) === undefined && !points.has(entry.kind)) {
      throw new UnknownContributionPointError(name, entry.id, entry.kind);
    }
  }

  const engine = index.engine();
  const foldTables = foldTablesFrom(
    [
      ...index.contributionsOf("fold").filter((row) => row.moduleName !== name),
      ...manifest.contributions.filter((entry) => entry.kind === "fold").map((entry) => ({ entry, moduleName: name })),
    ],
    engine,
  );
  // Installed rows come first, so a refusal this manifest earned always lands on its own entry.
  const declaredHere = new Set(
    manifest.contributions.filter((entry) => entry.kind === "fold").map((entry) => entry.id),
  );
  const refusedTable = foldTables.refused.find((refusal) => declaredHere.has(refusal.contributionId));
  if (refusedTable !== undefined) {
    throw new FoldRefusedError(refusedTable.reason, [refusedTable.contributionId, refusedTable.name]);
  }

  // An installed query refuses the install only if it stands now and would not after it.
  const heldTables = foldTablesFrom(index.contributionsOf("fold"), engine).tables;
  for (const { entry } of index.contributionsOf("query").filter((row) => row.moduleName !== name)) {
    if (standsAgainst(entry, heldTables, engine)) {
      queryDeclarationFromEntry(entry, foldTables.tables, engine);
    }
  }
  for (const entry of manifest.contributions.filter((entry) => entry.kind === "query")) {
    queryDeclarationFromEntry(entry, foldTables.tables, engine);
  }

  refuseUnregistrableSlots(
    name,
    manifest.contributions.filter((entry) => entry.kind === "slot"),
    index.contributionsOf("slot"),
  );

  // A contribution id belongs to one module name; a re-pin replaces this name's own rows.
  for (const entry of manifest.contributions) {
    const holder = index.contributionsWithId(entry.id).find((row) => row.moduleName !== name);
    if (holder !== undefined) {
      throw new ContributionIdHeldError(name, entry.id, holder.moduleName);
    }
  }

  await blobs.put(bundleBytes);
  const moduleRecordId = await store.put("module", moduleRecord);

  return { moduleRecordId, bundleId };
}
