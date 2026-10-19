import { isDeepStrictEqual } from "node:util";
import {
  actingPrincipal,
  DECLARATIVE_RULE,
  type OperationDescriptor,
  OperationError,
  openWorkspace,
  SALT_INPUT_SCHEMA,
  saltAsked,
  type Workspace,
} from "@musai/api-core";
import {
  type ClaimRecord,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  exitCodeForLabel,
  type PerformedRunRecord,
  performedRun,
  type RecordId,
  type RunRecipe,
  type RunRecord,
  slotFor,
  versionString,
} from "@musai/records";
import {
  authorisedBinary,
  bindCheckout,
  DEFAULT_CONTAINER_ENGINE,
  isToolName,
  readMachineTools,
  resolveBinaries,
  StationRefusedError,
  stationMasks,
  stationRecipeReady,
  TOOLS_CONFIG_KEY,
  TREE_SUBSTRATE_URI,
  workspaceToolsFromConfig,
} from "@musai/run";
import {
  editedConfig,
  gitDiffTreePaths,
  gitOldestRootCommit,
  resolveGitDir,
  resolveWorkTree,
  writeMainFiles,
} from "@musai/store";
import { assertMayAdmitTools } from "@musai/trust";
import { labelledClaim, measureTreeNow, treeMovement } from "../claim.js";
import { CHECK_CLAIM_TYPE, checkSpelling, shortIdOf } from "../claim-ref.js";
import { missingProgramHint, programHolderOf } from "../missing-program.js";
import { commandText, markOf } from "../text.js";

export interface CheckRunInput {
  readonly statement: string;
  readonly command?: readonly string[];
  /** An installed rule that judges the claim in place of a command. */
  readonly rule?: string;
  /** What the rule reads as its condition's value. */
  readonly parameters?: string;
  /** Programs the command reaches for by name beyond its own, such as the `sh` a script runs in. */
  readonly tool?: readonly string[];
  readonly salt?: boolean;
  /** Lets a sentence already checked be judged by another command or rule from now on. */
  readonly replace?: boolean;
}

/** What judges a check: a command the core's interpreter runs, or an installed rule. */
type Judge =
  | { readonly command: readonly string[]; readonly tool: readonly string[] }
  | { readonly rule: string; readonly parameters: string };

export interface CheckRunOutput {
  readonly label: "holds" | "fails" | "open";
  readonly reason: string | null;
  readonly statement: string;
  readonly slot: string;
  readonly claim: string;
  /** The slot's first hex digits, which `status` and `why` take. */
  readonly short: string;
  /** The programs this check named to the workspace's tools, where nothing admitted them before. */
  readonly toolsAdded: readonly string[];
  /** A program the failing run seems to have missed, and the paths the run moved in its tree. */
  readonly hint: string | null;
}

/** The substrate name the repository's working tree is bound under in `checkouts.json`. */
const TREE_NAME = "tree";

/** How many moved paths a hint names before it counts the rest. */
const NAMED_PATHS = 5;

function renderCheckText(output: CheckRunOutput): string {
  const added =
    output.toolsAdded.length === 0 ? [] : [`added ${output.toolsAdded.join(", ")} to the workspace's tools`];
  const reason = output.label === "open" && output.reason !== null ? ` — ${output.reason}` : "";
  const hint = output.hint === null ? [] : [output.hint];
  return [...added, `${markOf(output.label)} ${output.label} · ${output.short}${reason}`, ...hint].join("\n");
}

function refused(detail: string, about: string): OperationError {
  return new OperationError({ reason: "invalid-input", about: [about], detail });
}

/** A run finds its programs on `PATH` by name, so a path is refused before anything is written. */
function refusePathNamed(command: readonly string[], tools: readonly string[]): void {
  const program = command[0]!;
  if (!isToolName(program)) {
    throw refused(
      `refusing to check: ${program} is a path, and a check runs programs by name; run a script through its interpreter, as check "<sentence>" -- sh ${program}`,
      program,
    );
  }
  const pathNamed = tools.find((tool) => !isToolName(tool));
  if (pathNamed !== undefined) {
    throw refused(`refusing to check: the tool ${pathNamed} is a path, and a tool is a program's name`, pathNamed);
  }
}

function judgeOf(input: CheckRunInput): Judge {
  const { command, rule, parameters, tool = [] } = input;
  if (command !== undefined && rule !== undefined) {
    throw refused("refusing to check: name a command after -- or a rule with --rule, not both", rule);
  }
  if (rule !== undefined) {
    if (tool.length > 0) {
      throw refused(
        `refusing to check: --tool names what a command reaches for, and ${rule} asks for its own runs`,
        rule,
      );
    }
    return { rule, parameters: parameters ?? "" };
  }
  if (command === undefined) {
    throw refused(
      `refusing to check: name the command that settles it, as ${checkSpelling(DECLARATIVE_RULE)}, or a rule with --rule`,
      input.statement,
    );
  }
  if (parameters !== undefined) {
    throw refused("refusing to check: --parameters are a rule's, and a command carries its own", parameters);
  }
  refusePathNamed(command, tool);
  return { command, tool };
}

/** Refuses a rule that is not installed, is another kind of contribution, or is the interpreter. */
function assertInstalledRule(opened: Workspace, rule: string): void {
  const contribution = opened.index.contributionById(rule);
  if (contribution === undefined) {
    const rules = opened.index
      .contributionsOf("rule")
      .map((row) => row.entry.id)
      .filter((id) => id !== DECLARATIVE_RULE)
      .sort();
    throw new OperationError({
      reason: "no-such-record",
      about: [rule],
      detail: `no installed module contributes ${rule}; the rules installed here: ${rules.join(", ") || "none"}`,
    });
  }
  if (contribution.entry.kind !== "rule") {
    throw refused(`refusing to check by ${rule}: it is a ${contribution.entry.kind} contribution, not a rule`, rule);
  }
  if (rule === DECLARATIVE_RULE) {
    throw refused(`refusing to check by ${rule}: it runs a command, named as ${checkSpelling(rule)}`, rule);
  }
}

/** The repository the workspace sits in, named by its oldest root commit. */
export async function repositoryOf(
  workspace: string,
): Promise<{ readonly top: string; readonly gitDir: string; readonly subject: string }> {
  const top = await resolveWorkTree(workspace);
  const gitDir = top === null ? null : await resolveGitDir(top);
  if (top === null || gitDir === null) {
    throw refused(
      `refusing to check: ${workspace} is in no git working tree, and a check names its repository`,
      workspace,
    );
  }
  const root = await gitOldestRootCommit({ gitDir, operatorConfig: true });
  if (root === null) {
    throw refused(
      `refusing to check: the repository at ${top} has no commit to name it by; commit once and check again`,
      top,
    );
  }
  return { top, gitDir, subject: `git:${root}` };
}

/** Adds each program to the trust branch's tools once the recipe resolves; a station adds none. */
async function admitPrograms(
  opened: Workspace,
  principalName: string | undefined,
  programs: readonly string[],
): Promise<string[]> {
  const requirements = opened.requirements();
  const added = [...new Set(programs)].filter(
    (program) => authorisedBinary(requirements, program) === undefined && !opened.tools.includes(program),
  );
  if (added.length > 0) {
    if (opened.station !== undefined) {
      throw new StationRefusedError(
        opened.station.clearance,
        `refusing to run under the clearance ${opened.station.clearance}: check would add ${added.join(", ")} to the author's toolset, which a surface cleared to it is handed no way to write; ask the author to admit it, or check with a program already admitted`,
      );
    }
    assertMayAdmitTools(opened.matrix, await actingPrincipal(opened, principalName, undefined), added);
    await resolveBinaries([...new Set([...programs, ...opened.tools, ...(await readMachineTools(opened.localDir))])]);
    const withAdded = editedConfig((values) => ({
      ...values,
      [TOOLS_CONFIG_KEY]: [...new Set([...workspaceToolsFromConfig({ values }), ...added])],
    }));
    await writeMainFiles(opened.ctx, { "config.json": withAdded }, opened.now);
  }
  return added;
}

/** The paths the tree moved by while the run ran, which leave its claim stale at once. */
async function movedDuringRun(opened: Workspace, gitDir: string, run: PerformedRunRecord): Promise<string | null> {
  const movement = await treeMovement(opened, [run], measureTreeNow);
  if (movement?.recorded === undefined || movement.measured === undefined) {
    return null;
  }
  const paths = await gitDiffTreePaths({ gitDir, operatorConfig: true }, movement.recorded, movement.measured);
  const named = paths.slice(0, NAMED_PATHS).join(", ");
  const rest = paths.length > NAMED_PATHS ? ` and ${paths.length - NAMED_PATHS} more` : "";
  const them = paths.length === 1 ? "it" : "them";
  return `the tree moved while the command ran, so the claim reads stale from now on: ${named}${rest}; ignore ${them} in git, or have the command write ${them} outside the tree`;
}

/** `recipeNames` is `null` for a rule's run, whose programs no `--tool` can widen. */
async function hintFrom(
  opened: Workspace,
  gitDir: string,
  runId: RecordId,
  label: CheckRunOutput["label"],
  recipeNames: ReadonlySet<string> | null,
): Promise<string | null> {
  const run = performedRun(runId, (await opened.store.read(runId, "run")) as RunRecord);
  const { output, exitCode } = run.observation;
  const holder = programHolderOf(run, recipeNames);
  const missing =
    label === "fails" && holder !== null && typeof output === "string"
      ? missingProgramHint(exitCode, output, holder)
      : null;
  const hints = [missing, await movedDuringRun(opened, gitDir, run)].filter((hint) => hint !== null);
  return hints.length === 0 ? null : hints.join("\n");
}

function checkRecipe(command: readonly string[], tooling: readonly string[]): RunRecipe {
  return {
    command: [...command],
    workingDirectory: ".",
    environment: {},
    declared: [],
    substrates: [{ name: TREE_NAME, uri: TREE_SUBSTRATE_URI }],
    isolation: "hygiene",
    ...(tooling.length === 0 ? {} : { tooling: [...tooling] }),
  };
}

function checkConditions(
  subject: string,
  statement: string,
  command: readonly string[],
  tooling: readonly string[],
): Record<string, string> {
  const parameters = {
    recipes: [{ name: "check", kind: "run", recipe: checkRecipe(command, tooling) }],
    expectations: [{ kind: "exitCodeIs", recipe: "check", value: 0 }],
  };
  return { subject, statement, [DECLARATIVE_RULE]: new TextDecoder().decode(canonicalBytes(parameters)) };
}

/** What judges a check claim, by the command its recipe runs or the rule and what it reads. */
function judgedBy(conditions: Readonly<Record<string, unknown>>): { readonly key: string; readonly text: string } {
  const declared = conditions[DECLARATIVE_RULE];
  if (typeof declared === "string") {
    const { recipes } = JSON.parse(declared) as { recipes: { recipe: { command: string[] } }[] };
    const command = recipes[0]!.recipe.command;
    return { key: JSON.stringify(command), text: commandText(command) };
  }
  const [rule, parameters] = Object.entries(conditions).find(([key]) => key !== "subject" && key !== "statement")!;
  return { key: JSON.stringify([rule, parameters]), text: `the rule ${rule} reading ${JSON.stringify(parameters)}` };
}

/** The claim at the slot while it carries these conditions; a successor once they moved. */
async function claimFor(opened: Workspace, subject: string, input: CheckRunInput, judge: Judge) {
  const statement = input.statement;
  const declaration = opened.claimTypes.get(CHECK_CLAIM_TYPE);
  if (declaration === undefined) {
    throw new OperationError({
      reason: "workspace-incomplete",
      about: [CHECK_CLAIM_TYPE],
      detail: `refusing to check: no installed module declares ${CHECK_CLAIM_TYPE}; this workspace's musai.core predates it`,
    });
  }
  let conditions: Record<string, string>;
  let recipeNames: ReadonlySet<string> | null = null;
  if ("rule" in judge) {
    conditions = { subject, statement, [judge.rule]: judge.parameters };
  } else {
    const program = judge.command[0]!;
    const tooling = [...new Set([...opened.tools, ...judge.tool])].filter((tool) => tool !== program).sort();
    conditions = checkConditions(subject, statement, judge.command, tooling);
    recipeNames = new Set([program, ...tooling]);
  }
  const slot = slotFor(declaration, conditions);
  const existing = opened.index.claimAtSlot(slot);
  if (
    existing?.record.kind === "claim" &&
    isDeepStrictEqual(existing.record.conditions, conditions) &&
    (input.salt !== true || existing.record.salt !== undefined)
  ) {
    return { slot, id: existing.id, recipeNames };
  }
  if (existing?.record.kind === "claim" && input.replace !== true) {
    const before = judgedBy(existing.record.conditions);
    const after = judgedBy(conditions);
    if (before.key !== after.key) {
      throw new OperationError({
        reason: "invalid-input",
        about: [shortIdOf(slot)],
        detail: `refusing to check ${JSON.stringify(statement)} by ${after.text}: it is checked by ${before.text}, and one sentence is one claim; pass --replace to check it by ${after.text} from now on`,
      });
    }
  }
  const record: ClaimRecord = {
    kind: "claim",
    supersedes: existing === undefined ? [] : [existing.id],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CHECK_CLAIM_TYPE,
    about: [subject],
    slot,
    conditions,
    canonical: { statement },
    rendering: statement,
    evidence: [],
    exclusiveGroup: null,
  };
  const [id] = await opened.put([{ kind: "claim", value: record, ...saltAsked(input.salt) }]);
  return { slot, id: id as RecordId, recipeNames };
}

/** `check.run@1`: mints a claim that a command passes in this repository's working tree, or that
 * an installed rule holds there, then performs it as `status` does. */
export const checkRun: OperationDescriptor<CheckRunInput, CheckRunOutput> = {
  id: "check.run",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["statement"],
    properties: {
      statement: { type: "string", minLength: 1 },
      command: { type: "array", minItems: 1, items: { type: "string" } },
      rule: {
        type: "string",
        minLength: 1,
        description: "an installed module's rule that judges the claim, in place of a command",
      },
      parameters: { type: "string", description: "what the rule reads as its condition's value" },
      tool: {
        type: "array",
        items: { type: "string", minLength: 1 },
        description: "a program the command reaches for by name, such as the sh a package script runs in",
      },
      salt: SALT_INPUT_SCHEMA,
      replace: {
        type: "boolean",
        description: "let a sentence already checked be judged by this command or rule from now on",
      },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["label", "reason", "statement", "slot", "claim", "short", "toolsAdded", "hint"],
    properties: {
      label: { enum: ["holds", "fails", "open"] },
      reason: { type: ["string", "null"] },
      statement: { type: "string" },
      slot: { type: "string" },
      claim: { type: "string" },
      short: { type: "string" },
      toolsAdded: { type: "array", items: { type: "string" } },
      hint: { type: ["string", "null"] },
    },
  },
  effect: "performs",
  authority: null,
  plans: false,
  reasons: [
    "invalid-input",
    "workspace-incomplete",
    "no-such-record",
    "head-moved",
    "not-authorised",
    "declaration-conflict",
    "tool-unavailable",
  ],
  documentation:
    "Mints a claim that a command passes in this repository's working tree, or that an installed rule holds, and checks it.",
  statements: ["statement"],
  cli: {
    verb: "check",
    positional: ["statement"],
    rest: "command",
    flags: ["rule", "parameters", "tool", "salt", "replace"],
    describe: 'claim that a command passes here, and check it: check "tests pass" -- node --test',
  },
  renderText: renderCheckText,
  exitCode: (output) => exitCodeForLabel(output.label),
  async handler(input, context) {
    const judge = judgeOf(input);
    const before = await openWorkspace(context);
    if ("rule" in judge) {
      assertInstalledRule(before, judge.rule);
    }
    const { top, gitDir, subject } = await repositoryOf(context.workspace);
    if (before.station !== undefined) {
      // Refused before the claim or a tool is written, as the run itself would be.
      await stationMasks(top, before.station);
      if ("command" in judge) {
        await stationRecipeReady(checkRecipe(judge.command, []), before.station, DEFAULT_CONTAINER_ENGINE);
      }
    }
    await bindCheckout(before.localDir, TREE_NAME, top);
    const toolsAdded =
      "command" in judge ? await admitPrograms(before, context.principalName, [judge.command[0]!, ...judge.tool]) : [];
    const opened = toolsAdded.length === 0 ? before : await openWorkspace(context);
    const { slot, id, recipeNames } = await claimFor(opened, subject, input, judge);
    const { status, runIdByArgumentId } = await labelledClaim(opened, slot, "perform");
    const decidedBy = runIdByArgumentId.get(`${id}#rule:${"rule" in judge ? judge.rule : DECLARATIVE_RULE}`);
    return {
      label: status.label,
      reason: status.label === "open" ? status.reason : null,
      statement: input.statement,
      slot,
      claim: id,
      short: shortIdOf(slot),
      toolsAdded,
      hint: decidedBy === undefined ? null : await hintFrom(opened, gitDir, decidedBy, status.label, recipeNames),
    };
  },
};
