import type { OperationDescriptor } from "@musai/api-core";
import { openWorkspace } from "@musai/api-core";
import { CODE_CLASSES, type CodeClass, exitCodeForClass, versionString } from "@musai/records";
import { type LocalCheck, localChecks } from "../doctor/local-checks.js";
import { enumerateRequirements, type RequirementReport } from "../doctor/requirements.js";

export type DoctorRunInput = Record<string, never>;

export interface ExitCodeRow {
  readonly code: number;
  readonly class: CodeClass | null;
  readonly description: string;
}

export interface DoctorRunOutput {
  readonly requirements: readonly RequirementReport[];
  readonly local: readonly LocalCheck[];
  readonly exitCodes: readonly ExitCodeRow[];
}

/** The exit-code table; a code is its class's index in `CODE_CLASSES` plus one. */
const EXIT_CODE_DESCRIPTIONS: Record<CodeClass, string> = {
  bug: "report a bug — the kernel itself failed",
  invocation: "fix the invocation",
  workspace: "fix the workspace",
  refold: "re-fold and retry — the head moved",
  authority: "ask someone with the role",
  requirement: "install something",
  unheld: "read the report — a claim fails, is stale or is open, or a module's own test does not hold",
};

// A machine row (the canary, the container engine) is routine to fail and never sets the exit.
const WORKSPACE_ROWS: ReadonlySet<string> = new Set([
  "record-layout",
  "blob-store",
  "key-file",
  "bindings-file",
  "enclosing-repository",
  "contributed-declarations",
  "requirement-entries",
  "published-key",
]);

function exitCodeTable(): readonly ExitCodeRow[] {
  const rows: ExitCodeRow[] = [{ code: 0, class: null, description: "nothing — it worked" }];
  CODE_CLASSES.forEach((codeClass, index) => {
    rows.push({ code: index + 1, class: codeClass, description: EXIT_CODE_DESCRIPTIONS[codeClass] });
  });
  return rows;
}

function renderRequirementLine(report: RequirementReport): string {
  if (report.refusal !== null) {
    return `!!      ${report.binary}  (${report.declaredBy}) — ${report.refusal}`;
  }
  if (!report.resolved) {
    return `absent  ${report.binary}  (${report.declaredBy}) — ${report.install}`;
  }
  const version = report.version !== null ? ` ${report.version}` : "";
  if (report.satisfiesVersion === false) {
    return `!!      ${report.binary}${version}  (${report.declaredBy}) — ${report.declaredBy} needs ${report.versionPredicate}: ${report.install}`;
  }
  // An unevaluable constraint is reported unjudged, never passed.
  if (report.versionPredicate !== null && report.satisfiesVersion === null) {
    return `??      ${report.binary}${version}  (${report.declaredBy}) — ${report.versionPredicate} is not a constraint this kernel can check`;
  }
  return `ok      ${report.binary}${version}  (${report.declaredBy})  ${report.digest}`;
}

function renderLocalLine(check: LocalCheck): string {
  return `${check.ok ? "ok" : "!!"}      ${check.name}: ${check.detail}`;
}

function renderDoctorText(output: DoctorRunOutput): string {
  const requirementLines = output.requirements.map(renderRequirementLine);
  const localLines = output.local.map(renderLocalLine);
  const exitLines = output.exitCodes.map((row) => `${row.code}  ${row.description}`);
  return [
    "## Requirements",
    ...(requirementLines.length > 0 ? requirementLines : ["(no requirement declared by an installed module)"]),
    "",
    "## Local checks",
    ...localLines,
    "",
    "## Exit codes",
    ...exitLines,
  ].join("\n");
}

/** `doctor.run@2`: local tooling, local checks and the exit-code table. It reads the requirements a
 * bundle carries, so it is never a second inventory, and it is safe to paste into an issue. */
export const doctorRun: OperationDescriptor<DoctorRunInput, DoctorRunOutput> = {
  id: "doctor.run",
  version: versionString("2"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["requirements", "local", "exitCodes"],
    properties: {
      requirements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "binary",
            "resolved",
            "digest",
            "version",
            "versionPredicate",
            "satisfiesVersion",
            "declaredBy",
            "neededBy",
            "install",
            "refusal",
          ],
          properties: {
            binary: { type: "string" },
            resolved: { type: "boolean" },
            digest: { type: ["string", "null"] },
            version: { type: ["string", "null"] },
            versionPredicate: { type: ["string", "null"] },
            satisfiesVersion: { type: ["boolean", "null"] },
            declaredBy: { type: "string" },
            neededBy: { type: "string" },
            install: { type: "string" },
            refusal: { type: ["string", "null"] },
          },
        },
      },
      local: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "ok", "detail"],
          properties: {
            name: { type: "string" },
            ok: { type: "boolean" },
            detail: { type: "string" },
          },
        },
      },
      exitCodes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["code", "class", "description"],
          properties: {
            code: { type: "integer" },
            class: { type: ["string", "null"] },
            description: { type: "string" },
          },
        },
      },
    },
  },
  effect: "read",
  authority: null,
  plans: true,
  reasons: [],
  documentation:
    "What this machine has for the distribution's own tooling, the kernel's local checks, and the exit-code table.",
  cli: {
    verb: "doctor",
    positional: [],
    flags: [],
    describe: "report what this machine has and what a receiver would need to re-run it",
  },
  renderText: renderDoctorText,
  exitCode: (output) =>
    output.local.some((check) => !check.ok && WORKSPACE_ROWS.has(check.name)) ? exitCodeForClass("workspace") : 0,
  async handler(_input, context) {
    const opened = await openWorkspace(context);
    const [requirements, local] = await Promise.all([enumerateRequirements(opened), localChecks(opened)]);
    return { requirements, local, exitCodes: exitCodeTable() };
  },
};
