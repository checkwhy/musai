import {
  checkReceiptsOf,
  DECLARATIVE_RULE,
  type DeclarativeParameters,
  declarativeParametersOf,
  expectationsNamedBy,
  readDeclarativeParameters,
  rulesNamedBy,
  type Workspace,
  walkCitations,
} from "@musai/api-core";
import {
  blobPath,
  type ClaimRecord,
  type Conditions,
  canonicalBytes,
  type ModuleRecord,
  type PerformedRunRecord,
  performedRun,
  type RecordId,
  type RecordKind,
  type RunRecord,
  recordId,
  referencesOf,
} from "@musai/records";
import { labelledClaim } from "../claim.js";

/** `bytes` are what git stores, which are the bytes an id and a signature cover. */
export interface ClosureMember {
  readonly id: RecordId;
  readonly kind: RecordKind;
  readonly bytes: Uint8Array;
  readonly cites: readonly RecordId[];
  readonly blobs: readonly RecordId[];
}

/** A module a receiver re-derives a claim's verdict with, by its rule judging the claim or by an
 * expectation the interpreter, the judging rule there, invokes. */
export interface JudgingModule {
  readonly claim: RecordId;
  readonly rule: string;
  readonly contribution: string;
  readonly module: RecordId;
}

/** `cited` is what a verifier needs; `receipts`, the runs and module a check rests on uncited;
 * `attesting`, who made, asserted or re-shared those, and may be withheld. */
export interface Closure {
  readonly cited: readonly ClosureMember[];
  readonly receipts: readonly ClosureMember[];
  readonly attesting: readonly ClosureMember[];
  readonly judging: readonly JudgingModule[];
}

/** A release or a revocation lets a record go and is never part of what goes. */
const TRAVELLING_PURPOSES: ReadonlySet<string> = new Set(["made", "asserted", "re-shared"]);

async function memberOf(opened: Workspace, id: RecordId): Promise<ClosureMember> {
  const { kind } = opened.read(id);
  const bytes = await opened.store.readBytes(id, kind);
  const references = referencesOf(JSON.parse(new TextDecoder().decode(bytes)) as { kind: RecordKind });
  return { id, kind, bytes, cites: references.citations.map((citation) => citation.id), blobs: references.blobs };
}

/** A run's recipe and what it measured before it ran, which two runs share to be one trial. */
function trialOf(run: PerformedRunRecord): string {
  const { resolved, binaries } = run.observation;
  return new TextDecoder().decode(canonicalBytes({ recipe: recordId(run.recipe), resolved, binaries }));
}

/** The runs deciding each current check claim, with every run of its rule's recipes that read
 * the same inputs, so a receiver sees the flakiness and nothing of other trees. */
async function receiptsOf(opened: Workspace, cited: readonly ClosureMember[]): Promise<RecordId[]> {
  const receipts: RecordId[] = [];
  for (const member of cited.filter((entry) => entry.kind === "claim")) {
    const claim = opened.read(member.id) as ClaimRecord;
    const byRecipe = checkReceiptsOf(opened.index, claim);
    if (byRecipe.length === 0) {
      continue;
    }
    const { indexed, concluded } = await labelledClaim(opened, claim.slot, "recorded");
    if (indexed.id !== member.id || concluded === undefined) {
      continue;
    }
    const trials = new Set(concluded.runs.map((run) => trialOf(performedRun(run, opened.read(run) as RunRecord))));
    for (const receipt of byRecipe) {
      if (trials.has(trialOf(performedRun(receipt.recordId, receipt.record)))) {
        receipts.push(receipt.recordId);
      }
    }
  }
  return receipts;
}

/** Each installed module judging a claim of these conditions; the interpreter is every
 * workspace's own. */
export function judgingModulesOf(
  opened: Workspace,
  conditions: Conditions,
  parameters: DeclarativeParameters | null,
): Omit<JudgingModule, "claim">[] {
  const byRule = rulesNamedBy(opened.index, conditions)
    .filter((found) => found.entry.id !== DECLARATIVE_RULE)
    .map((found) => ({ rule: found.entry.id, found }));
  const byExpectation = expectationsNamedBy(opened.index, parameters).map((found) => ({
    rule: DECLARATIVE_RULE,
    found,
  }));
  return [...byRule, ...byExpectation].map(({ rule, found }) => ({
    rule,
    contribution: found.entry.id,
    module: found.moduleRecord,
  }));
}

/** Export and rerun name a judging module alike, so a reason in one matches the other's. */
export function judgingModuleName(
  opened: Workspace,
  { rule, contribution, module }: Omit<JudgingModule, "claim">,
): string {
  const { name, version } = opened.read(module) as ModuleRecord;
  return contribution === rule
    ? `its module ${name} ${version}`
    : `the module ${name} ${version} deciding its expectation ${contribution}`;
}

export function buildCarried(opened: Workspace, module: RecordId, files: ReadonlyMap<string, Uint8Array>): boolean {
  const { bundle } = opened.read(module) as ModuleRecord;
  return bundle !== null && files.has(blobPath(bundle));
}

/** Only a claim current at its slot is refused for a condition that does not read: a record is
 * never edited, so a superseded one must not keep its correction home. */
function judgingOf(opened: Workspace, cited: readonly ClosureMember[]): JudgingModule[] {
  return cited
    .filter((member) => member.kind === "claim")
    .flatMap((member) => {
      const { slot, conditions } = opened.read(member.id) as ClaimRecord;
      const parameters =
        opened.index.claimAtSlot(slot)?.id === member.id
          ? declarativeParametersOf(member.id, conditions)
          : readDeclarativeParameters(conditions);
      return judgingModulesOf(opened, conditions, parameters).map((judging) => ({ claim: member.id, ...judging }));
    });
}

/** Pins are not followed, since a verifier accepts one absent: a module travels, with its build,
 * only where its rule judges a member or the interpreter invokes its expectation for one. */
export async function closureOf(opened: Workspace, root: RecordId): Promise<Closure> {
  const reached = new Set<RecordId>();
  const walk = (from: readonly RecordId[], also: (member: ClosureMember) => RecordId[]) =>
    walkCitations(
      from,
      (id) => memberOf(opened, id),
      (member) => [...member.cites, ...also(member)],
      reached,
    );
  const attestationsOn = (member: ClosureMember): RecordId[] =>
    opened.index
      .attestationsBySubject(member.id)
      .filter((attestation) => TRAVELLING_PURPOSES.has(attestation.record.purpose))
      .map((attestation) => attestation.id);

  const cited = await walk([root], () => []);
  const judging = judgingOf(opened, cited);
  const receipts = await walk(
    [...(await receiptsOf(opened, cited)), ...judging.map((judged) => judged.module)],
    () => [],
  );
  const attesting = await walk([...cited, ...receipts].flatMap(attestationsOn), attestationsOn);
  return { cited, receipts, attesting, judging };
}
