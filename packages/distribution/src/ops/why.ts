import type { OperationDescriptor, Workspace } from "@musai/api-core";
import { openWorkspace, weighedRulingsFor } from "@musai/api-core";
import {
  authorityFromAttestation,
  BRIEF_HOP_LABEL,
  type DerivationJson,
  type DerivationNode,
  type DerivationSource,
  FLOOR_HOP_LABEL,
  formatBriefDecision,
  formatFloorDecision,
  formatRulingDecision,
  formatRulingVerdict,
  formatSetAsideDecision,
  renderText as kernelRenderText,
  mintSetAside,
  RULING_HOP_LABEL,
  renderJson,
  rulingConflicts,
  SET_ASIDE_HOP_LABEL,
  SUPERSEDED_HOP_LABEL,
  walkWitnesses,
} from "@musai/evaluate";
import {
  ANY_SCOPE,
  type ClaimRecord,
  type MusaiRecord,
  performedRun,
  type RecordId,
  type RulingRecord,
  type RunRecord,
  renderedTextOf,
  versionString,
} from "@musai/records";
import { shownPrincipal } from "@musai/trust";
import { contentIdsOf, labelledClaim } from "../claim.js";
import { shortIdOf } from "../claim-ref.js";
import { commandText, markOf } from "../text.js";

export interface ClaimWhyInput {
  readonly claim: string;
  readonly full?: boolean;
}

/** A run the claim's status rests on, as a reader needs it: what ran, how it ended, on what. */
export interface WhyRun {
  readonly id: string;
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly trees: readonly { readonly name: string; readonly digest: string }[];
  /** A receipt beside the one that decided, holding the claim too. */
  readonly agrees: boolean;
  /** The output's last lines, or `null` where it is sealed or held as a blob. */
  readonly outputTail: readonly string[] | null;
}

/** A live ruling on an open claim: it decided nothing, so it is named with what it said and who. */
export interface WhyRuling {
  readonly id: string;
  readonly verdict: "holds" | "fails";
  readonly authority: string;
  readonly principals: readonly string[];
  /** Each principal as the workspace's allowed signers name it, any alias beside its key. */
  readonly names: readonly string[];
}

export interface ClaimWhyOutput {
  readonly statement: string;
  readonly label: "holds" | "fails" | "open";
  readonly reason: string | null;
  readonly short: string;
  readonly via: string;
  /** Why the claim reads open, when its gate or its own check said why. */
  readonly detail?: string;
  readonly runs: readonly WhyRun[];
  /** Present on an open claim that live rulings bear on. */
  readonly rulings?: readonly WhyRuling[];
  /** The whole derivation, asked for with `full`; absent on an open claim: nothing decided it. */
  readonly derivation?: DerivationJson;
}

const OUTPUT_TAIL_LINES = 5;

function toDerivationNode(json: DerivationJson): DerivationNode {
  return {
    hop: { label: json.label, id: json.id, decidedBy: json.decidedBy, beat: json.beat },
    children: json.children.map(toDerivationNode),
  };
}

interface NamedRuling {
  readonly record: RulingRecord;
  readonly authority: string;
  readonly principals: readonly string[];
  /** Whether the ruling naming it is the succession that counts. */
  readonly retired: boolean;
}

/** Every ruling on the slot `supersedes` reaches, read ahead so `nodeOf` stays synchronous; a name
 * that is no ruling on the slot is not walked, and no record names an id derived from its bytes. */
async function rulingsNamedBeneath(
  opened: Workspace,
  slot: string,
  successor: RecordId,
  supersedes: readonly RecordId[],
): Promise<ReadonlyMap<string, NamedRuling>> {
  const weighed = new Map((await weighedRulingsFor(opened, slot)).map((ruling) => [ruling.id as string, ruling]));
  const named = new Map<string, NamedRuling>();
  const pending = supersedes.map((name) => ({ name, by: successor }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const ruling = weighed.get(next.name);
    if (ruling === undefined) {
      continue;
    }
    // One node per id: a name is marked superseded where any successor walking to it counted.
    named.set(next.name, {
      record: ruling.record,
      authority: ruling.tier ?? "contested-authority",
      principals: ruling.principals,
      retired: ruling.retiredBy === next.by || named.get(next.name)?.retired === true,
    });
    pending.push(...ruling.record.supersedes.map((name) => ({ name, by: ruling.id })));
  }
  return named;
}

function runFacts(run: WhyRun): string {
  const trees = run.trees.map((tree) => `${tree.name} ${tree.digest.slice(0, 12)}`);
  return [commandText(run.command), `exit ${run.exitCode}`, ...trees].join(" · ");
}

function tailLines(run: WhyRun): string[] {
  return run.outputTail === null || run.outputTail.length === 0
    ? []
    : ["output, last lines:", ...run.outputTail.map((line) => `  ${line}`)];
}

function renderClaimWhyText(output: ClaimWhyOutput): string {
  const reason = output.reason !== null ? ` (${output.reason})` : "";
  const header = [`${markOf(output.label)} ${output.label}${reason} · ${output.statement} (${output.short})`];
  const detail = output.detail !== undefined ? [`  ${output.detail}`] : [];
  const rulings = (output.rulings ?? []).map(
    (ruling) =>
      `  ruling ${shortIdOf(ruling.id)} · ${formatRulingVerdict(ruling.verdict, ruling.authority, ruling.names)}`,
  );
  if (output.derivation !== undefined) {
    const runs = new Map(output.runs.map((run) => [run.id, run]));
    const tree = kernelRenderText(toDerivationNode(output.derivation), (hop) => {
      const run = hop.label === "run" ? runs.get(hop.id) : undefined;
      return run === undefined ? [] : [runFacts(run), ...tailLines(run)];
    });
    return [...header, ...detail, tree].join("\n");
  }
  const runs = output.runs.flatMap((run) => [
    `  run ${shortIdOf(run.id)} · ${runFacts(run)}${run.agrees ? "   (agrees)" : ""}`,
    ...tailLines(run).map((line) => `    ${line}`),
  ]);
  return [...header, ...detail, ...rulings, ...runs].join("\n");
}

/** Every run a derivation reaches, in the order it walks them. */
function runIdsIn(node: DerivationJson): string[] {
  return [...(node.label === "run" ? [node.id] : []), ...node.children.flatMap(runIdsIn)];
}

async function whyRun(opened: Workspace, id: RecordId, agrees: boolean): Promise<WhyRun> {
  // From the store, not the fold: this call's own check may have minted the run.
  const run = performedRun(id, (await opened.store.read(id, "run")) as RunRecord);
  const { observation } = run;
  const asBlob = observation.resolved.some((resolved) => resolved.annotations?.["storage"] === "blob");
  const output = typeof observation.output === "string" && !asBlob ? observation.output.trimEnd() : null;
  return {
    id,
    command: run.recipe.command,
    exitCode: observation.exitCode,
    agrees,
    trees: run.recipe.substrates.flatMap((descriptor, position) => {
      const digest = observation.resolved[position]?.digest?.gitTree;
      return digest !== undefined && descriptor.name !== undefined ? [{ name: descriptor.name, digest }] : [];
    }),
    outputTail: output === null ? null : output === "" ? [] : output.split("\n").slice(-OUTPUT_TAIL_LINES),
  };
}

const WHY_RUN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "command", "exitCode", "trees", "agrees", "outputTail"],
  properties: {
    id: { type: "string" },
    command: { type: "array", items: { type: "string" } },
    exitCode: { type: "integer" },
    trees: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "digest"],
        properties: { name: { type: "string" }, digest: { type: "string" } },
      },
    },
    agrees: { type: "boolean" },
    outputTail: { oneOf: [{ type: "null" }, { type: "array", items: { type: "string" } }] },
  },
} as const;

const WHY_RULING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "verdict", "authority", "principals", "names"],
  properties: {
    id: { type: "string" },
    verdict: { enum: ["holds", "fails"] },
    authority: { type: "string" },
    principals: { type: "array", items: { type: "string" } },
    names: { type: "array", items: { type: "string" } },
  },
} as const;

const DERIVATION_HOP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label", "id", "decidedBy", "beat", "children"],
  properties: {
    label: { type: "string" },
    id: { type: "string" },
    decidedBy: { type: "string" },
    beat: { type: ["string", "null"] },
    children: { type: "array", items: { $ref: "#/$defs/hop" } },
  },
} as const;

/** `claim.why@3`: the derivation behind a claim's computed status, walked down to its receipts. */
export const claimWhy: OperationDescriptor<ClaimWhyInput, ClaimWhyOutput> = {
  id: "claim.why",
  version: versionString("3"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["claim"],
    properties: {
      claim: { type: "string" },
      full: { type: "boolean", description: "the whole derivation tree, each run's details beneath its run" },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["statement", "label", "reason", "short", "via", "runs"],
    properties: {
      statement: { type: "string" },
      label: { enum: ["holds", "fails", "open"] },
      reason: { type: ["string", "null"] },
      short: { type: "string" },
      via: { type: "string" },
      detail: { type: "string" },
      runs: { type: "array", items: WHY_RUN_SCHEMA },
      rulings: { type: "array", minItems: 1, items: WHY_RULING_SCHEMA },
      derivation: { $ref: "#/$defs/hop" },
    },
    $defs: { hop: DERIVATION_HOP_SCHEMA },
  },
  effect: "performs",
  authority: null,
  plans: true,
  reasons: ["declaration-conflict", "invalid-input", "no-such-record", "sibling-conflict"],
  documentation: "Renders the derivation behind a claim's computed status.",
  cli: {
    verb: "why",
    positional: ["claim"],
    flags: ["full"],
    describe: "say why a claim holds, fails or is open: the runs it rests on, and with --full the whole derivation",
  },
  renderText: renderClaimWhyText,
  exitCode: () => 0,
  async handler(input, context) {
    const opened = await openWorkspace(context);
    const {
      indexed,
      status,
      labelling,
      argumentsById,
      runIdByArgumentId,
      rulingsById,
      attestationsByRulingId,
      detail,
    } = await labelledClaim(opened, input.claim, context.mode === "plan" ? "recorded" : "perform");

    const agreeingRuns = new Set(status.comparison.corroborated.flatMap((id) => runIdByArgumentId.get(id) ?? []));
    const answer = async (derivation: DerivationJson | null): Promise<ClaimWhyOutput> => {
      const runIds = derivation === null ? [...new Set(runIdByArgumentId.values())] : runIdsIn(derivation);
      const rulings: WhyRuling[] =
        status.label === "open"
          ? (await weighedRulingsFor(opened, indexed.slot))
              .filter((ruling) => ruling.retiredBy === null)
              .map((ruling) => ({
                id: ruling.id,
                verdict: ruling.record.verdict,
                authority: ruling.tier ?? "contested-authority",
                principals: ruling.principals,
                names: ruling.principals.map((principal) => shownPrincipal(opened.allowedSigners, principal)),
              }))
          : [];
      return {
        statement: renderedTextOf((indexed.record as ClaimRecord).rendering),
        label: status.label,
        reason: status.label === "open" ? status.reason : null,
        short: shortIdOf(indexed.slot),
        via: status.comparison.via,
        ...(detail !== undefined ? { detail } : {}),
        ...(rulings.length > 0 ? { rulings } : {}),
        runs: await Promise.all(runIds.map((id) => whyRun(opened, id as RecordId, agreeingRuns.has(id as RecordId)))),
        ...(input.full === true && derivation !== null ? { derivation } : {}),
      };
    };

    // Read structurally off the rulings and the floor, never by matching the comparison's wording.
    const winningRuling = rulingsById.get(status.comparison.winner);
    const winningFloor =
      !winningRuling && opened.floor && status.comparison.winner === opened.floor.id ? opened.floor : undefined;
    const winningArgument = winningRuling || winningFloor ? undefined : argumentsById.get(status.comparison.winner);

    // Nothing decided an open claim, so a walk from its comparison's winner would read as decided.
    if (status.label === "open") {
      return answer(null);
    }
    if (!winningRuling && !winningFloor && !winningArgument) {
      throw new Error(`claim ${indexed.slot}: no winning argument for a ${status.label} status`);
    }

    let source: DerivationSource;

    if (winningFloor) {
      // The floor names no principal or reason, so its rival is an evidence hop, not a set-aside.
      const floorId = winningFloor.id;
      const rivalArgument = status.comparison.rival ? argumentsById.get(status.comparison.rival) : undefined;
      const rivalRunId = rivalArgument ? runIdByArgumentId.get(rivalArgument.id) : undefined;
      // From the store, not the fold: this call's own check may have minted the run.
      const rivalRun = rivalRunId ? ((await opened.store.read(rivalRunId, "run")) as RunRecord) : undefined;

      source = {
        nodeOf(id) {
          if (id === indexed.slot) {
            return {
              kind: "claim",
              decidedBy: status.comparison.via,
              beat: status.comparison.rival,
              childIds: [floorId],
            };
          }
          if (id === floorId) {
            return {
              kind: FLOOR_HOP_LABEL,
              decidedBy: formatFloorDecision(winningFloor.commit),
              beat: null,
              childIds: rivalArgument ? [rivalArgument.id] : [],
            };
          }
          if (rivalArgument && id === rivalArgument.id) {
            return {
              kind: "evidence",
              decidedBy: rivalArgument.evidenceKind,
              beat: null,
              childIds: rivalRunId ? [rivalRunId] : [],
            };
          }
          if (rivalRunId && id === rivalRunId) {
            return { kind: "run", decidedBy: rivalRun!.runKind, beat: null, childIds: [] };
          }
          throw new Error(`claim ${indexed.slot}: no derivation node for id: ${id}`);
        },
      };
    } else if (winningRuling) {
      // A ruling's children are its brief and the rulings it superseded.
      const rulingId = status.comparison.winner;
      const rivalArgument = status.comparison.rival ? argumentsById.get(status.comparison.rival) : undefined;
      const rivalRunId = rivalArgument ? runIdByArgumentId.get(rivalArgument.id) : undefined;

      // Who ruled lives on the attestations; the first stands for the ruling's time.
      const attestations = attestationsByRulingId.get(rulingId) ?? [];
      const primaryAttestation = attestations[0] ?? null;
      const evaluatedAuthority = authorityFromAttestation(
        { id: rulingId },
        primaryAttestation,
        opened.matrix,
        ANY_SCOPE,
      );
      const authorityLabel = evaluatedAuthority?.class ?? "contested-authority";

      // Evidence alone reaches holds, so a ruling conflicting with that sets the rival run aside.
      const setAside =
        rivalRunId && primaryAttestation && rulingConflicts(winningRuling.verdict, "holds")
          ? mintSetAside(
              { id: rulingId, principal: primaryAttestation.principal, decidedAt: primaryAttestation.at },
              rivalRunId,
              renderedTextOf(winningRuling.reason),
            )
          : null;

      const briefId = winningRuling.brief;
      const briefRun = opened.read(briefId) as RunRecord;
      const readIds = contentIdsOf(briefRun.observation.reads) as RecordId[];
      // A brief also reads its case and claim, so a read here is not always a run.
      const readRecords = new Map<RecordId, MusaiRecord>();
      for (const readId of readIds) {
        readRecords.set(readId, opened.read(readId));
      }
      // A named ruling's brief is not walked: it decided nothing that stands.
      const namedRulings = await rulingsNamedBeneath(
        opened,
        indexed.slot,
        rulingId as RecordId,
        winningRuling.supersedes,
      );
      const namedBeneath = (supersedes: readonly RecordId[]) => supersedes.filter((name) => namedRulings.has(name));

      const shown = (principal: string): string => shownPrincipal(opened.allowedSigners, principal);
      source = {
        nodeOf(id) {
          if (id === indexed.slot) {
            return {
              kind: "claim",
              decidedBy: status.comparison.via,
              beat: status.comparison.rival,
              childIds: [rulingId],
            };
          }
          if (id === rulingId) {
            return {
              kind: RULING_HOP_LABEL,
              decidedBy: formatRulingDecision(
                authorityLabel,
                attestations.map((attestation) => shown(attestation.principal)),
              ),
              beat: null,
              childIds: [briefId, ...namedBeneath(winningRuling.supersedes)],
            };
          }
          const named = namedRulings.get(id);
          if (named !== undefined) {
            return named.retired
              ? {
                  kind: SUPERSEDED_HOP_LABEL,
                  decidedBy: formatRulingVerdict(named.record.verdict, named.authority, named.principals.map(shown)),
                  beat: null,
                  childIds: namedBeneath(named.record.supersedes),
                }
              : {
                  kind: RULING_HOP_LABEL,
                  decidedBy: formatRulingDecision(named.authority, named.principals.map(shown)),
                  beat: null,
                  childIds: namedBeneath(named.record.supersedes),
                };
          }
          if (id === briefId) {
            return { kind: BRIEF_HOP_LABEL, decidedBy: formatBriefDecision(), beat: null, childIds: readIds };
          }
          const readRecord = readRecords.get(id as RecordId);
          if (readRecord !== undefined) {
            if (setAside && id === rivalRunId) {
              return {
                kind: SET_ASIDE_HOP_LABEL,
                decidedBy: formatSetAsideDecision(shown(setAside.principal), setAside.reason),
                beat: null,
                childIds: [],
              };
            }
            // A brief's case and claim carry no `runKind`, so they read as their record kind.
            const decidedBy = readRecord.kind === "run" ? readRecord.runKind : "packed by the brief";
            return { kind: readRecord.kind, decidedBy, beat: null, childIds: [] };
          }
          throw new Error(`claim ${indexed.slot}: no derivation node for id: ${id}`);
        },
      };
    } else {
      const winner = winningArgument!;
      const runId = runIdByArgumentId.get(winner.id);
      if (runId === undefined) {
        throw new Error(`claim ${indexed.slot}: the winning node ${winner.id} names no run to walk down to`);
      }
      // From the store, not the fold: this call's own check may have minted the run.
      const run = (await opened.store.read(runId, "run")) as RunRecord;
      const agreeing = new Map(
        await Promise.all(
          status.comparison.corroborated.map(async (argumentId) => {
            const agreeingRunId = runIdByArgumentId.get(argumentId)!;
            const agreeingRun = (await opened.store.read(agreeingRunId, "run")) as RunRecord;
            return [argumentId, { runId: agreeingRunId, run: agreeingRun }] as const;
          }),
        ),
      );
      const agreeingByRun = new Map([...agreeing.values()].map((entry) => [entry.runId as string, entry.run]));

      // A claim never stands as its own loser; the hop below names what beat it.
      source = {
        nodeOf(id) {
          if (id === indexed.slot) {
            const beat = status.comparison.rival === indexed.slot ? null : status.comparison.rival;
            return { kind: "claim", decidedBy: status.comparison.via, beat, childIds: [winner.id, ...agreeing.keys()] };
          }
          const agreeingArgument = agreeing.get(id);
          if (agreeingArgument !== undefined) {
            const evidenceKind = argumentsById.get(id)!.evidenceKind;
            return { kind: "evidence", decidedBy: evidenceKind, beat: null, childIds: [agreeingArgument.runId] };
          }
          const agreeingRun = agreeingByRun.get(id);
          if (agreeingRun !== undefined) {
            return { kind: "run", decidedBy: agreeingRun.runKind, beat: null, childIds: [] };
          }
          if (id === winner.id) {
            return {
              kind: "evidence",
              decidedBy: winner.evidenceKind,
              beat: status.comparison.rival,
              childIds: [runId],
            };
          }
          if (id === runId) {
            return { kind: "run", decidedBy: run.runKind, beat: null, childIds: [] };
          }
          throw new Error(`claim ${indexed.slot}: no derivation node for id: ${id}`);
        },
      };
    }

    return answer(renderJson(walkWitnesses(labelling, source, indexed.slot)));
  },
};
