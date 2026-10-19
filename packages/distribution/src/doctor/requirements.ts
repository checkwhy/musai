import type { Workspace } from "@musai/api-core";
import { partitionRequirementRows } from "@musai/modules";
import type { RequirementContributionInput } from "@musai/records";
import {
  BinaryNotFoundError,
  probeBinaryVersion,
  requirementsFromModules,
  resolveBinaries,
  versionSatisfies,
} from "@musai/run";

/** One declared `requirement` resolved on this machine; it carries no binary output beyond a
 * version, so a report is safe to paste into an issue. */
export interface RequirementReport {
  readonly binary: string;
  readonly resolved: boolean;
  readonly digest: string | null;
  readonly version: string | null;
  readonly versionPredicate: string | null;
  /** `null` where nothing was constrained or found, or the constraint cannot be evaluated. */
  readonly satisfiesVersion: boolean | null;
  readonly declaredBy: string;
  readonly neededBy: string;
  readonly install: string;
  /** Set where a run naming the binary is refused, and why. */
  readonly refusal: string | null;
}

type ResolvedPart = Pick<
  RequirementReport,
  "binary" | "resolved" | "digest" | "version" | "versionPredicate" | "satisfiesVersion"
>;

/** An absent binary is reported, not thrown. */
async function resolvedReport(binary: string, versionPredicate: string | null): Promise<ResolvedPart> {
  let resolved: { readonly digest: string; readonly directory: string } | null = null;
  try {
    const [found] = await resolveBinaries([binary]);
    resolved = found ?? null;
  } catch (error) {
    if (!(error instanceof BinaryNotFoundError)) {
      throw error;
    }
  }
  const version =
    resolved !== null && versionPredicate !== null ? await probeBinaryVersion(resolved.directory, binary) : null;
  return {
    binary,
    resolved: resolved !== null,
    digest: resolved?.digest ?? null,
    version,
    versionPredicate,
    satisfiesVersion:
      version !== null && versionPredicate !== null ? versionSatisfies(version, versionPredicate) : null,
  };
}

function uniqueSorted(values: readonly string[], separator: string): string {
  return [...new Set(values)].sort().join(separator);
}

/** Every declared `requirement` and workspace tool, resolved as a run's spawn resolves them; a
 * binary declared under disagreeing predicates is one row, since no run naming it is authorised. */
export async function enumerateRequirements(opened: Workspace): Promise<readonly RequirementReport[]> {
  const contributions = partitionRequirementRows(opened.index.contributionsOf("requirement")).wellFormed;
  const { conflicts } = requirementsFromModules(contributions);
  const reports: RequirementReport[] = [];
  for (const contribution of contributions) {
    const input = contribution.entry.input as RequirementContributionInput;
    if (conflicts.has(input.binary)) {
      continue;
    }
    reports.push({
      ...(await resolvedReport(input.binary, input.versionPredicate)),
      declaredBy: contribution.moduleName,
      neededBy: input.neededBy,
      install: input.install,
      refusal: null,
    });
  }
  for (const { binary } of conflicts.values()) {
    const declaring = contributions.filter(
      ({ entry }) => (entry.input as RequirementContributionInput).binary === binary,
    );
    const inputs = declaring.map(({ entry }) => entry.input as RequirementContributionInput);
    const declarations = declaring.map(
      ({ moduleName }, index) => `${moduleName} (${inputs[index]!.versionPredicate ?? "any version"})`,
    );
    reports.push({
      ...(await resolvedReport(binary, null)),
      declaredBy: uniqueSorted(
        declaring.map(({ moduleName }) => moduleName),
        ", ",
      ),
      neededBy: uniqueSorted(
        inputs.map((input) => input.neededBy),
        "; ",
      ),
      install: uniqueSorted(
        inputs.map((input) => input.install),
        "; ",
      ),
      refusal: `a run naming ${binary} is refused: its modules declare different version predicates: ${uniqueSorted(declarations, ", ")}`,
    });
  }
  for (const tool of opened.tools) {
    reports.push({
      ...(await resolvedReport(tool, null)),
      declaredBy: "workspace tools",
      neededBy: "the workspace's own runs",
      install: `install ${tool}, or remove it from config.json's "tools" on the trust branch`,
      refusal: null,
    });
  }
  reports.sort((a, b) => {
    if (a.binary !== b.binary) {
      return a.binary < b.binary ? -1 : 1;
    }
    return a.declaredBy < b.declaredBy ? -1 : a.declaredBy > b.declaredBy ? 1 : 0;
  });
  return reports;
}
