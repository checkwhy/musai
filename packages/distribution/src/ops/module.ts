import { join } from "node:path";
import type { OperationDescriptor } from "@musai/api-core";
import { OperationError, openWorkspace } from "@musai/api-core";
import {
  buildModule,
  type Mismatch,
  runModuleTests,
  scaffoldModule,
  type TemplateReference,
  type TestReport,
} from "@musai/devkit";
import { exitCodeForClass, isKernelError, versionString } from "@musai/records";
import { MUSAI_DIR, Store } from "@musai/store";
import { defaultPluginDir, syncSkills } from "../plugin/sync.js";

/** Parses `<module>/<contribution>` on the first slash, so a slashed contribution round-trips. */
export function parseTemplateReference(value: string): TemplateReference {
  const slash = value.indexOf("/");
  if (slash === -1) {
    throw new Error(`a template reference must be spelled <module>/<contribution>, got ${value}`);
  }
  return { module: value.slice(0, slash), contribution: value.slice(slash + 1) };
}

const MISMATCH_IDENTITY = {
  module: { type: "string" },
  contribution: { type: "string" },
  fixture: { type: "string" },
} as const;

const TEST_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["module", "results", "ok"],
  properties: {
    module: { type: "string" },
    ok: { type: "boolean" },
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["host", "contribution", "fixture", "status", "mismatches"],
        properties: {
          host: { type: "string" },
          contribution: { type: "string" },
          fixture: { type: "string" },
          status: { enum: ["pass", "fail", "updated", "skipped"] },
          message: { type: "string" },
          mismatches: {
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: [...Object.keys(MISMATCH_IDENTITY), "half", "path", "byteOffset", "expected", "actual"],
                  properties: {
                    ...MISMATCH_IDENTITY,
                    half: { const: "response" },
                    path: { type: "string" },
                    byteOffset: { type: "integer" },
                    // A golden's response is whatever JSON value the contribution answered.
                    expected: true,
                    actual: true,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: [...Object.keys(MISMATCH_IDENTITY), "half", "missing", "extra"],
                  properties: {
                    ...MISMATCH_IDENTITY,
                    half: { const: "reads" },
                    missing: { type: "array", items: { type: "string" } },
                    extra: { type: "array", items: { type: "string" } },
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
} as const;

export interface ModuleNewInput {
  readonly dir: string;
  readonly template?: string;
}

export interface ModuleNewOutput {
  readonly targetDir: string;
  readonly created: boolean;
  readonly testReport: TestReport | null;
}

/** `module.new@1`: scaffolds a complete module, built and tested on the spot. */
export const moduleNew: OperationDescriptor<ModuleNewInput, ModuleNewOutput> = {
  id: "module.new",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["dir"],
    properties: {
      dir: { type: "string" },
      template: { type: "string" },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["targetDir", "created", "testReport"],
    properties: {
      targetDir: { type: "string" },
      created: { type: "boolean" },
      testReport: { oneOf: [{ type: "null" }, TEST_REPORT_SCHEMA] },
    },
  },
  effect: "performs",
  authority: null,
  plans: false,
  reasons: ["head-moved", "invalid-input"],
  documentation:
    "Scaffolds a complete module: writes its source, builds and tests it apart from any workspace, and names the build that installs it.",
  paths: ["dir"],
  cli: {
    verb: "new",
    positional: ["dir"],
    flags: ["template"],
    describe: "scaffold a complete module, built and tested apart from this workspace; module build installs it",
    group: "module",
  },
  renderText: (output) =>
    [
      output.targetDir,
      output.created ? "scaffolded, built and tested" : "already scaffolded by an earlier run",
      `install it in this workspace: musai lab module build ${output.targetDir}`,
    ].join("\n"),
  exitCode: (output) => (output.testReport !== null && !output.testReport.ok ? exitCodeForClass("unheld") : 0),
  async handler(input, context) {
    const template = input.template === undefined ? undefined : parseTemplateReference(input.template);
    return scaffoldModule(input.dir, { template, now: context.now });
  },
};

export interface ModuleBuildInput {
  readonly dir: string;
  readonly sourceGitDir?: string;
}

export interface ModuleBuildOutput {
  readonly moduleRecordId: string;
  readonly bundleId: string;
}

/** `module.build@1`: builds a module and installs it, with its derived manifest and its receipt. */
export const moduleBuild: OperationDescriptor<ModuleBuildInput, ModuleBuildOutput> = {
  id: "module.build",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["dir"],
    properties: {
      dir: { type: "string" },
      sourceGitDir: { type: "string" },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["moduleRecordId", "bundleId"],
    properties: {
      moduleRecordId: { type: "string" },
      bundleId: { type: "string" },
    },
  },
  effect: "performs",
  authority: null,
  plans: false,
  reasons: ["head-moved", "invalid-input", "workspace-incomplete"],
  documentation:
    "Builds a module's source and installs it in this workspace: its bundle, a manifest nobody wrote, and a receipt.",
  paths: ["dir", "sourceGitDir"],
  cli: {
    verb: "build",
    positional: ["dir"],
    flags: ["sourceGitDir"],
    describe: "build a module's source and install it in this workspace, with a manifest nobody wrote and a receipt",
    group: "module",
  },
  renderText: (output) => `${output.moduleRecordId}\n${output.bundleId}`,
  exitCode: () => 0,
  async handler(input, context) {
    const gitDir = join(context.workspace, MUSAI_DIR);
    const store = new Store({ ctx: { gitDir }, scope: context.scope, now: context.now });
    // Opened before the build, reporting nothing: the open after it reports every refusal once.
    const opened = await openWorkspace({ ...context, reportRefusal: undefined });
    let result: Awaited<ReturnType<typeof buildModule>>;
    try {
      result = await buildModule(input.dir, store, {
        blobs: opened.blobs,
        index: opened.index,
        sourceGitDir: input.sourceGitDir,
        now: context.now,
      });
    } finally {
      opened.close();
    }

    // A build is the install path, so a module's skill reaches the plugin as its build lands.
    try {
      const built = await openWorkspace(context);
      try {
        await syncSkills(built, defaultPluginDir(context.workspace));
      } finally {
        built.close();
      }
    } catch (error) {
      throw new OperationError({
        reason: isKernelError(error) ? error.reason : "workspace-incomplete",
        about: [result.moduleRecordId],
        detail: `built and installed ${input.dir} as ${result.moduleRecordId}, but syncing its skills into the plugin failed, so run \`plugin sync\` once the cause is fixed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return { moduleRecordId: result.moduleRecordId, bundleId: result.bundleId };
  },
};

export interface ModuleTestInput {
  readonly dir: string;
  readonly record?: boolean;
  readonly update?: boolean;
}

function formatMismatch(mismatch: Mismatch): string {
  if (mismatch.half === "response") {
    return `  response at ${mismatch.path}, byte ${mismatch.byteOffset}: expected ${JSON.stringify(mismatch.expected)}, got ${JSON.stringify(mismatch.actual)}`;
  }
  const missing = mismatch.missing?.length ? `missing ${mismatch.missing.join(", ")}` : "";
  const extra = mismatch.extra?.length ? `extra ${mismatch.extra.join(", ")}` : "";
  return `  read-log: ${[missing, extra].filter((part) => part.length > 0).join("; ")}`;
}

function renderModuleTestText(report: TestReport): string {
  const lines: string[] = [];
  for (const result of report.results) {
    lines.push(`${result.status} ${result.host} ${result.contribution} ${result.fixture}`);
    if (result.message !== undefined) {
      lines.push(`  ${result.message}`);
    }
    for (const mismatch of result.mismatches) {
      lines.push(formatMismatch(mismatch));
    }
  }
  return lines.join("\n");
}

/** `module.test@1`: runs a module's fixtures against the real evaluation. */
export const moduleTest: OperationDescriptor<ModuleTestInput, TestReport> = {
  id: "module.test",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["dir"],
    properties: {
      dir: { type: "string" },
      record: { type: "boolean" },
      update: { type: "boolean" },
    },
  },
  output: TEST_REPORT_SCHEMA,
  effect: "performs",
  authority: null,
  plans: false,
  reasons: ["head-moved", "invalid-input"],
  documentation: "Runs a module's own fixtures against the real evaluation, performing switched off unless recording.",
  paths: ["dir"],
  cli: {
    verb: "test",
    group: "module",
    positional: ["dir"],
    flags: ["record", "update"],
    describe: "run a module's own fixtures against the real evaluation, performing switched off",
  },
  renderText: renderModuleTestText,
  exitCode: (output) => (output.ok ? 0 : exitCodeForClass("unheld")),
  async handler(input, context) {
    return runModuleTests(input.dir, { record: input.record, update: input.update, now: context.now });
  },
};
